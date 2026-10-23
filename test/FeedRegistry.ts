/**
 * FeedRegistry v1 — the contract tests listed in docs/CHAIN.md §5.
 *
 * Run: `npm run test:contract:js` (solc-js build, then hardhat test --no-compile)
 *  or: `npm run test:contract`    (hardhat's own solc download, production profile)
 *
 * Every signature here is produced with the shared viem constructors in
 * lib/chain/types.ts, so a green run proves the Solidity typehash, domain and
 * ABI match what the Worker and the client will use, byte for byte.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decodeEventLog, getAbiItem, getAddress, getContract, keccak256, stringToHex, toEventSelector, toFunctionSelector, type Address, type Hex } from "viem";
import { formatAbiItem } from "viem/utils";
import { network } from "hardhat";
import { ARENA, GAME_VERSION, TUNING, payRate, type ArcadeCommand } from "../lib/game/arcade.ts";
import { traceHash } from "../lib/chain/trace.ts";
import {
  DOMAIN_NAME, DOMAIN_VERSION, SIGNATURE_WINDOW_SECONDS, attestationTypedData, dominantOf, feedRegistryAbi, gameVersionId,
  resultFromJson, resultHash, resultToJson, resultTypedData, seedToBytes32, snapshotHashOf, PILE_FILINGS_PER_EPOCH, type RunResult, } from "../lib/chain/types.ts";

const DAY = 86_400n;
const HOUR = 3_600n;
const VERSION_ID = gameVersionId(GAME_VERSION);
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const ZERO_ADDRESS = `0x${"0".repeat(40)}` as Address;

/** A plausible short shift: a few launches, then it ends on tick 4,058. */
const END_TICK = 4_058;
const COMMANDS: ArcadeCommand[] = [
  { tick: 42, kind: "launch", ingredient: "metal", angle: -40, power: 13 },
  { tick: 88, kind: "launch", ingredient: "balloon", angle: -38, power: 14 },
  { tick: 131, kind: "launch", ingredient: "pepper", angle: -42, power: 12 },
  { tick: 700, kind: "hatch" },
  { tick: 3_990, kind: "launch", ingredient: "balloon", angle: -35, power: 16 },
];

describe("FeedRegistry v1", async () => {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const [owner, verifier, player, relayer, impostor, player2] = await viem.getWalletClients();
  const wallets = [owner, verifier, player, relayer, impostor, player2];
  /** The wallet that owns an address, so a result for `player2` is signed by player2. Unknown addresses fall back to `player`. */
  const walletOf = (address: Address) => wallets.find((wallet) => wallet.account.address.toLowerCase() === address.toLowerCase()) ?? player;
  let runCounter = 0;

  /** Ticket-style one-time run ids. */
  const nextRunId = () => keccak256(stringToHex(`ticket-${++runCounter}`));
  const soon = async (seconds = 600) => BigInt(await networkHelpers.time.latest()) + BigInt(seconds);

  /** The realistic result from the brief: 4,058 ticks, 65 feeds 21/23/21, best combo 2, size 1.58, ending 1, empty belly. */
  async function realistic(patch: Partial<RunResult> = {}): Promise<RunResult> {
    return {
      runId: nextRunId(), gameVersion: VERSION_ID, player: player.account.address,
      score: 14_730n, durationTicks: END_TICK, totalFeeds: 65, btcFed: 21, ethFed: 23, hemiFed: 21,
      bestCombo: 2, frenzies: 0, sizeCenti: 158, ending: 1, cause: 0,
      seed: seedToBytes32(0x5eed_0001), traceHash: traceHash(COMMANDS, END_TICK),
      snapshotHash: snapshotHashOf(0n, 0n, { btc: 0n, eth: 0n, hemi: 0n }), deadline: await soon(),
      ...patch,
    };
  }

  async function deploy(epochSeconds = DAY, gameVersion: Hex = VERSION_ID) {
    return viem.deployContract("FeedRegistry", [owner.account.address, verifier.account.address, gameVersion, epochSeconds]);
  }

  async function fixture(epochSeconds = DAY) {
    const registry = await deploy(epochSeconds);
    type SignOptions = { signer?: typeof player; attester?: typeof verifier; contract?: Address; chain?: number };
    async function sign(result: RunResult, { signer = walletOf(result.player), attester = verifier, contract = registry.address, chain = chainId }: SignOptions = {}) {
      const playerSignature = await signer.signTypedData(resultTypedData(result, contract, chain));
      const verifierSignature = await attester.signTypedData(attestationTypedData(result, contract, chain));
      return [playerSignature, verifierSignature] as const;
    }
    /** Sign with the honest parties and send from the relayer. */
    async function submit(result: RunResult, sender = relayer) {
      return registry.write.submitResult([result, ...(await sign(result))], { account: sender.account });
    }
    async function receiptOf(hash: Promise<Hex> | Hex) {
      return publicClient.waitForTransactionReceipt({ hash: await hash });
    }
    const expectInvalid = (result: RunResult, error = "InvalidResult") =>
      viem.assertions.revertWithCustomError(submit(result), registry, error as "InvalidResult");
    const expectAccepted = async (result: RunResult) => {
      await submit(result);
      assert.equal(await registry.read.usedRunIds([result.runId]), true);
    };
    return { registry, sign, submit, receiptOf, expectInvalid, expectAccepted };
  }

  // ------------------------------------------------------------ the ABI

  it("the shared ABI in lib/chain/types.ts matches the compiled contract, signature for signature", () => {
    const artifact = JSON.parse(readFileSync(new URL("../artifacts/contracts/FeedRegistry.sol/FeedRegistry.json", import.meta.url), "utf8"));
    const compiled = new Set<string>(artifact.abi.filter((item: { type: string }) => item.type !== "constructor").map((item: Parameters<typeof formatAbiItem>[0]) => formatAbiItem(item)));
    for (const item of feedRegistryAbi) assert.ok(compiled.has(formatAbiItem(item)), `missing from the contract: ${formatAbiItem(item)}`);
    const constructor = artifact.abi.find((item: { type: string }) => item.type === "constructor");
    assert.deepEqual(constructor.inputs.map((input: { type: string }) => input.type), ["address", "address", "bytes32", "uint64"]);
  });

  // ------------------------------------------------------- happy paths

  it("accepts a result sent by a relayer: effects, views and the event", async () => {
    const f = await fixture();
    const result = await realistic();
    const receipt = await f.receiptOf(f.submit(result));
    assert.equal(receipt.status, "success");

    assert.equal(await f.registry.read.usedRunIds([result.runId]), true);
    assert.equal(await f.registry.read.bestScore([player.account.address]), 14_730n);
    assert.equal(await f.registry.read.bestUptime([player.account.address]), END_TICK);
    assert.equal(await f.registry.read.runs([player.account.address]), 1);
    assert.deepEqual(await f.registry.read.diet([0n]), [21n, 23n, 21n, 1n]);
    assert.deepEqual(await f.registry.read.allTimeDiet(), [21n, 23n, 21n, 1n]);
    assert.equal(await f.registry.read.dominant([0n]), 2);
    assert.equal(await f.registry.read.currentEpoch(), 0n);

    // The event, decoded with the *client's* ABI, with exactly the declared fields in order.
    const log = receipt.logs.find((entry) => entry.address.toLowerCase() === f.registry.address.toLowerCase());
    assert.ok(log);
    assert.equal(log.topics[0], toEventSelector(getAbiItem({ abi: feedRegistryAbi, name: "ResultRecorded" })));
    const event = decodeEventLog({ abi: feedRegistryAbi, data: log.data, topics: log.topics });
    if (event.eventName !== "ResultRecorded") assert.fail(`unexpected event ${event.eventName}`);
    assert.deepEqual(event.args, {
      runId: result.runId, player: getAddress(player.account.address), gameVersion: VERSION_ID,
      score: 14_730n, durationTicks: END_TICK, btcFed: 21, ethFed: 23, hemiFed: 21,
      bestCombo: 2, frenzies: 0, sizeCenti: 158, ending: 1, cause: 0,
      epoch: 0n, snapshotHash: result.snapshotHash, traceHash: result.traceHash,
    });
  });

  it("accepts a result sent by the player through the shared client ABI", async () => {
    const f = await fixture();
    const result = await realistic();
    const client = getContract({ address: f.registry.address, abi: feedRegistryAbi, client: { public: publicClient, wallet: player } });
    await client.write.submitResult([result, ...(await f.sign(result))]);
    assert.equal(await client.read.bestScore([player.account.address]), 14_730n);
    assert.equal(await client.read.runs([player.account.address]), 1);
    assert.equal(await client.read.activeGameVersion(), VERSION_ID);
    assert.equal((await client.read.verifier()).toLowerCase(), verifier.account.address.toLowerCase());
    assert.equal(await client.read.EPOCH_SECONDS(), DAY);
    assert.equal(await client.read.paused(), false);
  });

  it("the wire codec round-trips a result that then signs and verifies", async () => {
    const f = await fixture();
    const original = await realistic();
    const wire = JSON.parse(JSON.stringify(resultToJson(original)));
    assert.equal(typeof wire.score, "string");
    assert.equal(typeof wire.deadline, "string");
    const decoded = resultFromJson(wire);
    assert.deepEqual(decoded, original);
    assert.equal(resultHash(decoded, f.registry.address, chainId), resultHash(original, f.registry.address, chainId));
    await f.expectAccepted(decoded);
  });

  it("keeps each player's best score and best uptime separately, and counts runs", async () => {
    const f = await fixture();
    await f.submit(await realistic({ score: 9_000n, durationTicks: 3_000, totalFeeds: 40, btcFed: 20, ethFed: 10, hemiFed: 10 }));
    await f.submit(await realistic({ score: 5_000n, durationTicks: 6_000, totalFeeds: 30, btcFed: 10, ethFed: 10, hemiFed: 10 }));
    await f.submit(await realistic({ player: player2.account.address, score: 100n, durationTicks: 100, totalFeeds: 1, btcFed: 0, ethFed: 0, hemiFed: 1, bestCombo: 1 }), player2);
    assert.equal(await f.registry.read.bestScore([player.account.address]), 9_000n);
    assert.equal(await f.registry.read.bestUptime([player.account.address]), 6_000);
    assert.equal(await f.registry.read.runs([player.account.address]), 2);
    assert.equal(await f.registry.read.bestScore([player2.account.address]), 100n);
    assert.equal(await f.registry.read.runs([player2.account.address]), 1);
    assert.deepEqual(await f.registry.read.diet([0n]), [30n, 20n, 21n, 3n]);
    assert.deepEqual(await f.registry.read.allTimeDiet(), [30n, 20n, 21n, 3n]);
  });

  it("gas: a cold first run and a warm repeat stay reasonable", async (t) => {
    const f = await fixture();
    const cold = await f.receiptOf(f.submit(await realistic()));
    const warm = await f.receiptOf(f.submit(await realistic({ score: 12_000n })));
    t.diagnostic(`submitResult gas: cold ${cold.gasUsed} (new player, new epoch), warm ${warm.gasUsed} (same player, same epoch)`);
    console.log(`    submitResult gas: cold ${cold.gasUsed}, warm ${warm.gasUsed}`);
    assert.ok(warm.gasUsed < 150_000n, `warm submitResult used ${warm.gasUsed} gas`);
  });

  // ------------------------------------------------------------ replay

  it("rejects a duplicate runId (DuplicateRun) and zero runId / zero player (InvalidResult)", async () => {
    const f = await fixture();
    const result = await realistic();
    const signatures = await f.sign(result);
    await f.registry.write.submitResult([result, ...signatures], { account: relayer.account });
    await viem.assertions.revertWithCustomError(f.registry.write.submitResult([result, ...signatures], { account: relayer.account }), f.registry, "DuplicateRun");
    // A new deadline and fresh signatures do not help: the runId is spent.
    await viem.assertions.revertWithCustomError(f.submit({ ...result, deadline: await soon(900) }), f.registry, "DuplicateRun");
    await f.expectInvalid(await realistic({ runId: ZERO32 }));
    await f.expectInvalid(await realistic({ player: ZERO_ADDRESS }));
  });

  // -------------------------------------------------------- signatures

  it("rejects a forged player signature, a forged verifier signature, a swap and a tampered field", async () => {
    const f = await fixture();
    const result = await realistic();
    const [playerSignature, verifierSignature] = await f.sign(result);
    const reject = (signatures: readonly [Hex, Hex], value = result) =>
      viem.assertions.revertWithCustomError(f.registry.write.submitResult([value, ...signatures], { account: relayer.account }), f.registry, "InvalidSignature");

    await reject(await f.sign(result, { signer: impostor }));
    await reject(await f.sign(result, { attester: impostor }));
    await reject([verifierSignature, playerSignature]);
    await reject([playerSignature, verifierSignature], { ...result, score: result.score + 1n });
    await reject([playerSignature, verifierSignature], { ...result, player: player2.account.address });
    // The verifier must sign VerifierAttestation(resultHash), not the result itself.
    const bare = await verifier.signTypedData(resultTypedData(result, f.registry.address, chainId));
    await reject([playerSignature, bare]);
    assert.equal(await f.registry.read.usedRunIds([result.runId]), false);
    // And the honest pair still goes through.
    await f.registry.write.submitResult([result, playerSignature, verifierSignature], { account: relayer.account });
  });

  it("rejects signatures for another chain or another contract", async () => {
    const f = await fixture();
    const other = await deploy();
    const result = await realistic();
    const reject = (signatures: readonly [Hex, Hex]) =>
      viem.assertions.revertWithCustomError(f.registry.write.submitResult([result, ...signatures], { account: relayer.account }), f.registry, "InvalidSignature");
    await reject(await f.sign(result, { chain: chainId + 1 }));
    await reject(await f.sign(result, { contract: other.address }));
    // Player on the right domain, verifier on the wrong one, and vice versa.
    const [goodPlayer, goodVerifier] = await f.sign(result);
    const [badPlayer, badVerifier] = await f.sign(result, { contract: other.address });
    await reject([goodPlayer, badVerifier]);
    await reject([badPlayer, goodVerifier]);
    assert.equal(await f.registry.read.usedRunIds([result.runId]), false);
  });

  it("rejects malformed signatures with InvalidSignature, never an ECDSA error", async () => {
    const f = await fixture();
    const result = await realistic();
    const [playerSignature, verifierSignature] = await f.sign(result);
    for (const bad of ["0x", "0x00", `0x${"11".repeat(64)}`, `0x${"11".repeat(66)}`, `0x${"ff".repeat(65)}`] as Hex[]) {
      await viem.assertions.revertWithCustomError(f.registry.write.submitResult([result, bad, verifierSignature], { account: relayer.account }), f.registry, "InvalidSignature");
      await viem.assertions.revertWithCustomError(f.registry.write.submitResult([result, playerSignature, bad], { account: relayer.account }), f.registry, "InvalidSignature");
    }
  });

  it("the domain is Do Not Feed It / 1 on this chain and contract", async () => {
    const f = await fixture();
    const [, name, version, domainChainId, verifyingContract] = await f.registry.read.eip712Domain();
    assert.equal(name, DOMAIN_NAME);
    assert.equal(version, DOMAIN_VERSION);
    assert.equal(domainChainId, BigInt(chainId));
    assert.equal(verifyingContract.toLowerCase(), f.registry.address.toLowerCase());
  });

  // ---------------------------------------------------------- the window

  it("deadline: accepted at block.timestamp and at +30 min, rejected one second past either edge", async () => {
    const f = await fixture();
    let t = (await networkHelpers.time.latest()) + 100;
    const at = async (deadlineOffset: number) => {
      t += 100;
      await networkHelpers.time.setNextBlockTimestamp(t);
      return realistic({ deadline: BigInt(t + deadlineOffset) });
    };
    await f.expectAccepted(await at(0));
    await viem.assertions.revertWithCustomError(f.submit(await at(-1)), f.registry, "Expired");
    await f.expectAccepted(await at(SIGNATURE_WINDOW_SECONDS));
    await f.expectInvalid(await at(SIGNATURE_WINDOW_SECONDS + 1));
    await viem.assertions.revertWithCustomError(f.submit(await realistic({ deadline: 0n })), f.registry, "Expired");
    assert.equal(await f.registry.read.SIGNATURE_WINDOW(), BigInt(SIGNATURE_WINDOW_SECONDS));
  });

  // ------------------------------------------------------------- bounds

  it("durationTicks: 1 and 43,200 pass; 0 and 43,201 fail", async () => {
    const f = await fixture();
    const short = { totalFeeds: 1, btcFed: 1, ethFed: 0, hemiFed: 0, bestCombo: 1, frenzies: 0, score: 2_000n } as const;
    await f.expectAccepted(await realistic({ durationTicks: 1, ...short }));
    await f.expectInvalid(await realistic({ durationTicks: 0, ...short }));
    await f.expectAccepted(await realistic({ durationTicks: ARENA.maxTicks }));
    await f.expectInvalid(await realistic({ durationTicks: ARENA.maxTicks + 1 }));
    assert.equal(await f.registry.read.MAX_DURATION_TICKS(), ARENA.maxTicks);
  });

  it("totalFeeds ≤ durationTicks / 15 + 1 + 3 × (durationTicks / 120 + 1): 373 passes at 4,058 ticks; 374 fails", async () => {
    const f = await fixture();
    const limit = Math.floor(END_TICK / ARENA.frenzyCooldownTicks) + 1
      + TUNING.crateCoins * (Math.floor(END_TICK / TUNING.crateGapMin) + 1);
    assert.equal(limit, 373);
    await f.expectAccepted(await realistic({ totalFeeds: 373, btcFed: 125, ethFed: 124, hemiFed: 124 }));
    await f.expectInvalid(await realistic({ totalFeeds: 374, btcFed: 126, ethFed: 124, hemiFed: 124 }));
    assert.equal(await f.registry.read.FEED_COOLDOWN_TICKS(), ARENA.frenzyCooldownTicks);
    assert.equal(await f.registry.read.CRATE_COINS(), TUNING.crateCoins);
    assert.equal(await f.registry.read.CRATE_GAP_MIN(), TUNING.crateGapMin);
  });

  it("btc + eth + hemi must equal totalFeeds, in uint256 so a wrapped uint32 sum cannot pass", async () => {
    const f = await fixture();
    await f.expectInvalid(await realistic({ btcFed: 22 }));
    await f.expectInvalid(await realistic({ hemiFed: 20 }));
    await f.expectInvalid(await realistic({ totalFeeds: 64 }));
    // 0xffffffff + 1 + 65 ≡ 65 (mod 2^32): the sum must not wrap into agreement.
    await f.expectInvalid(await realistic({ btcFed: 0xffff_ffff, ethFed: 1, hemiFed: 65 }));
    // And zero feeds is a legal (if sad) shift.
    await f.expectAccepted(await realistic({ totalFeeds: 0, btcFed: 0, ethFed: 0, hemiFed: 0, bestCombo: 0, frenzies: 0, score: 500n }));
  });

  it("bestCombo ≤ totalFeeds: 65 passes; 66 fails", async () => {
    const f = await fixture();
    await f.expectAccepted(await realistic({ bestCombo: 65 }));
    await f.expectInvalid(await realistic({ bestCombo: 66 }));
  });

  it("frenzies ≤ totalFeeds / 5 + 1: 14 passes at 65 feeds; 15 fails", async () => {
    const f = await fixture();
    assert.equal(Math.floor(65 / TUNING.frenzyAt) + 1, 14);
    await f.expectAccepted(await realistic({ frenzies: 14 }));
    await f.expectInvalid(await realistic({ frenzies: 15 }));
    assert.equal(await f.registry.read.FEEDS_PER_FRENZY(), TUNING.frenzyAt);
  });

  it("sizeCenti ≤ 1,000; ending ≤ 3; cause ≤ 2", async () => {
    const f = await fixture();
    await f.expectAccepted(await realistic({ sizeCenti: 1_000 }));
    await f.expectInvalid(await realistic({ sizeCenti: 1_001 }));
    await f.expectAccepted(await realistic({ ending: 3 }));
    await f.expectInvalid(await realistic({ ending: 4 }));
    await f.expectAccepted(await realistic({ cause: 2 }));
    await f.expectInvalid(await realistic({ cause: 3 }));
    assert.ok(Math.round(TUNING.sizeMax * 100) <= (await f.registry.read.MAX_SIZE_CENTI()));
  });

  it("score ≤ durationTicks × 4,000: 16,232,000 passes at 4,058 ticks; 16,232,001 fails", async () => {
    const f = await fixture();
    await f.expectAccepted(await realistic({ score: 16_232_000n }));
    await f.expectInvalid(await realistic({ score: 16_232_001n }));
    await f.expectInvalid(await realistic({ score: 2n ** 64n - 1n }));
    assert.equal(await f.registry.read.MAX_SCORE_PER_TICK(), 4_000n);
  });

  it("the score bound exceeds the theoretical maximum derived from TUNING over a full shift", async (t) => {
    const f = await fixture();
    const ticks = ARENA.maxTicks;
    // Feeds: one launch per frenzy cooldown, plus every coin a crate could have poured — the contract's own feed bound.
    const maxFeeds = Math.floor(ticks / ARENA.frenzyCooldownTicks) + 1 + TUNING.crateCoins * (Math.floor(ticks / TUNING.crateGapMin) + 1);
    // The richest single serving: max combo base × best bank × cooked × frenzy × a crate pour, plus a craving bonus in a frenzy.
    const base = 100 + TUNING.comboBonus * TUNING.comboBonusMax;
    const perFeed = Math.round(base * Math.max(...TUNING.bankMults) * TUNING.cookedMult * TUNING.frenzyScore * TUNING.crateMult)
      + Math.round(TUNING.cravingBonus * TUNING.frenzyScore);
    assert.equal(perFeed, 14_220);
    // Utensils: generously one caught per 15 ticks, every one in a frenzy (the storms are far slower).
    const utensils = Math.floor(ticks / 15) * TUNING.utensilScore * TUNING.frenzyScore;
    // Passive pay: every 10 ticks, at the rate reached after a whole shift kept fed.
    const passive = Math.ceil(ticks / 10) * Math.max(1, Math.round(payRate(ticks)));
    // Hatch bonuses (+150 lunge stopped, +220 flame blocked), one each per hatch cooldown.
    const hatch = (Math.floor(ticks / ARENA.hatchCooldown) + 1) * (150 + 220);
    const ceiling = maxFeeds * perFeed + utensils + passive + hatch;
    const bound = BigInt(await f.registry.read.MAX_DURATION_TICKS()) * (await f.registry.read.MAX_SCORE_PER_TICK());
    t.diagnostic(`theoretical ceiling ${ceiling.toLocaleString()} vs bound ${bound.toLocaleString()} (${(Number(bound) / ceiling).toFixed(2)}×)`);
    assert.equal(bound, 172_800_000n);
    assert.ok(BigInt(ceiling) < bound, `ceiling ${ceiling} is not under the bound ${bound}`);
    assert.ok(BigInt(ceiling) * 2n < bound, "the bound should keep at least a 2× margin over the ceiling");
  });

  // ------------------------------------------------------------ version

  it("version rotation: the new version is accepted, the old rejected, and a spent runId stays spent", async () => {
    const f = await fixture();
    const first = await realistic();
    await f.submit(first);
    const v6 = gameVersionId(GAME_VERSION + 1);
    await viem.assertions.revertWithCustomError(f.registry.write.setGameVersion([v6], { account: player.account }), f.registry, "OwnableUnauthorizedAccount");
    await viem.assertions.revertWithCustomError(f.registry.write.setGameVersion([ZERO32]), f.registry, "InvalidResult");
    await viem.assertions.emitWithArgs(f.registry.write.setGameVersion([v6]), f.registry, "GameVersionChanged", [VERSION_ID, v6]);
    assert.equal(await f.registry.read.activeGameVersion(), v6);

    await viem.assertions.revertWithCustomError(f.submit(await realistic()), f.registry, "WrongVersion");
    await f.expectAccepted(await realistic({ gameVersion: v6 }));
    // Same runId as the run filed under version 5, re-signed under version 6: still one-time.
    await viem.assertions.revertWithCustomError(f.submit({ ...first, gameVersion: v6, deadline: await soon() }), f.registry, "DuplicateRun");
    // A result for a version that was never active.
    await viem.assertions.revertWithCustomError(f.submit(await realistic({ gameVersion: gameVersionId(99) })), f.registry, "WrongVersion");
  });

  it("verifier rotation: the old key's attestation is refused, the new key's accepted", async () => {
    const f = await fixture();
    await viem.assertions.revertWithCustomError(f.registry.write.setVerifier([impostor.account.address], { account: player.account }), f.registry, "OwnableUnauthorizedAccount");
    await viem.assertions.revertWithCustomError(f.registry.write.setVerifier([ZERO_ADDRESS]), f.registry, "InvalidResult");
    await viem.assertions.emitWithArgs(f.registry.write.setVerifier([impostor.account.address]), f.registry, "VerifierChanged", [verifier.account.address, impostor.account.address]);
    const result = await realistic();
    await viem.assertions.revertWithCustomError(f.submit(result), f.registry, "InvalidSignature");
    await f.registry.write.submitResult([result, ...(await f.sign(result, { attester: impostor }))], { account: relayer.account });
    assert.equal(await f.registry.read.usedRunIds([result.runId]), true);
  });

  // -------------------------------------------------------------- pause

  it("pause is owner-only, blocks filing, and unpause restores it", async () => {
    const f = await fixture();
    await viem.assertions.revertWithCustomError(f.registry.write.pause([], { account: player.account }), f.registry, "OwnableUnauthorizedAccount");
    await f.registry.write.pause();
    assert.equal(await f.registry.read.paused(), true);
    await viem.assertions.revertWithCustomError(f.submit(await realistic()), f.registry, "EnforcedPause");
    await viem.assertions.revertWithCustomError(f.registry.write.unpause([], { account: player.account }), f.registry, "OwnableUnauthorizedAccount");
    await f.registry.write.unpause();
    assert.equal(await f.registry.read.paused(), false);
    await f.expectAccepted(await realistic());
  });

  it("ownership is two-step", async () => {
    const f = await fixture();
    await f.registry.write.transferOwnership([player.account.address]);
    assert.equal((await f.registry.read.owner()).toLowerCase(), owner.account.address.toLowerCase());
    assert.equal((await f.registry.read.pendingOwner()).toLowerCase(), player.account.address.toLowerCase());
    await viem.assertions.revertWithCustomError(f.registry.write.pause([], { account: player.account }), f.registry, "OwnableUnauthorizedAccount");
    await f.registry.write.acceptOwnership([], { account: player.account });
    assert.equal((await f.registry.read.owner()).toLowerCase(), player.account.address.toLowerCase());
    await f.registry.write.pause([], { account: player.account });
    assert.equal(await f.registry.read.paused(), true);
  });

  it("ownership cannot be renounced: a paused registry with no owner could never be unpaused or re-keyed", async () => {
    const f = await fixture();
    await viem.assertions.revertWithCustomError(f.registry.write.renounceOwnership(), f.registry, "NotRenounceable");
    await viem.assertions.revertWithCustomError(f.registry.write.renounceOwnership([], { account: player.account }), f.registry, "OwnableUnauthorizedAccount");
    assert.equal((await f.registry.read.owner()).toLowerCase(), owner.account.address.toLowerCase());
  });

  // ------------------------------------------------------------- epochs

  it("constructor: GENESIS is the deploy block, EPOCH_SECONDS ≥ 1 hour, and zero arguments are refused", async () => {
    const registry = await deploy(HOUR);
    const block = await publicClient.getBlock();
    assert.equal(await registry.read.GENESIS(), block.timestamp);
    assert.equal(await registry.read.EPOCH_SECONDS(), HOUR);
    assert.equal(await registry.read.MIN_EPOCH_SECONDS(), HOUR);
    assert.equal((await registry.read.owner()).toLowerCase(), owner.account.address.toLowerCase());
    // The deploy announces its configuration, so an indexer can start from block one.
    assert.equal((await registry.getEvents.VerifierChanged()).length, 1);
    assert.equal((await registry.getEvents.GameVersionChanged()).length, 1);
    await assert.rejects(deploy(HOUR - 1n));
    await assert.rejects(deploy(DAY, ZERO32));
    await assert.rejects(viem.deployContract("FeedRegistry", [owner.account.address, ZERO_ADDRESS, VERSION_ID, DAY]));
    await assert.rejects(viem.deployContract("FeedRegistry", [ZERO_ADDRESS, verifier.account.address, VERSION_ID, DAY]));
  });

  it("epochOf: before GENESIS is 0, then one epoch per EPOCH_SECONDS", async () => {
    const f = await fixture();
    const genesis = await f.registry.read.GENESIS();
    assert.equal(await f.registry.read.epochOf([0n]), 0n);
    assert.equal(await f.registry.read.epochOf([genesis - 1n]), 0n);
    assert.equal(await f.registry.read.epochOf([genesis]), 0n);
    assert.equal(await f.registry.read.epochOf([genesis + DAY - 1n]), 0n);
    assert.equal(await f.registry.read.epochOf([genesis + DAY]), 1n);
    assert.equal(await f.registry.read.epochOf([genesis + 2n * DAY - 1n]), 1n);
    assert.equal(await f.registry.read.epochOf([genesis + 2n * DAY]), 2n);
    assert.equal(await f.registry.read.epochOf([genesis + 1_000n * DAY + 5n]), 1_000n);
  });

  it("epoch accounting across a boundary: each pile keeps its own epoch, all-time keeps both", async () => {
    const f = await fixture();
    const a = await realistic();
    const receiptA = await f.receiptOf(f.submit(a));
    assert.equal(await f.registry.read.currentEpoch(), 0n);

    await networkHelpers.time.increase(Number(DAY));
    assert.equal(await f.registry.read.currentEpoch(), 1n);
    const b = await realistic({ score: 3_000n, durationTicks: 1_500, totalFeeds: 10, btcFed: 10, ethFed: 0, hemiFed: 0 });
    const receiptB = await f.receiptOf(f.submit(b));

    const epochOf = (receipt: typeof receiptA) => {
      const log = receipt.logs.find((entry) => entry.address.toLowerCase() === f.registry.address.toLowerCase());
      assert.ok(log);
      const event = decodeEventLog({ abi: feedRegistryAbi, data: log.data, topics: log.topics });
      if (event.eventName !== "ResultRecorded") assert.fail(`unexpected event ${event.eventName}`);
      return event.args.epoch;
    };
    assert.equal(epochOf(receiptA), 0n);
    assert.equal(epochOf(receiptB), 1n);

    assert.deepEqual(await f.registry.read.diet([0n]), [21n, 23n, 21n, 1n]);
    assert.deepEqual(await f.registry.read.diet([1n]), [10n, 0n, 0n, 1n]);
    assert.deepEqual(await f.registry.read.diet([2n]), [0n, 0n, 0n, 0n]);
    assert.deepEqual(await f.registry.read.allTimeDiet(), [31n, 23n, 21n, 2n]);
    assert.equal(await f.registry.read.dominant([0n]), 2);
    assert.equal(await f.registry.read.dominant([1n]), 1);
    assert.equal(await f.registry.read.dominant([2n]), 0);
    assert.equal(await f.registry.read.bestScore([player.account.address]), 14_730n);
    assert.equal(await f.registry.read.runs([player.account.address]), 2);
  });

  it("the pile: a wallet's first three filings in an epoch feed it; the fourth is recorded and ranked but feeds nothing", async () => {
    const f = await fixture();
    assert.equal(await f.registry.read.PILE_FILINGS_PER_EPOCH(), PILE_FILINGS_PER_EPOCH);
    const diets: Array<[number, number, number]> = [[10, 0, 0], [0, 10, 0], [0, 0, 10], [30, 0, 0]];
    const pileFedFor = (receipt: Awaited<ReturnType<typeof f.receiptOf>>) => {
      const names = receipt.logs
        .filter((entry) => entry.address.toLowerCase() === f.registry.address.toLowerCase())
        .map((entry) => decodeEventLog({ abi: feedRegistryAbi, data: entry.data, topics: entry.topics }));
      assert.equal(names[0].eventName, "ResultRecorded", "ResultRecorded comes first");
      return names.find((event) => event.eventName === "PileFed");
    };
    for (let i = 0; i < diets.length; i++) {
      const [btcFed, ethFed, hemiFed] = diets[i];
      const result = await realistic({ score: BigInt(1_000 * (i + 1)), totalFeeds: 10 + (i === 3 ? 20 : 0), btcFed, ethFed, hemiFed });
      const fed = pileFedFor(await f.receiptOf(f.submit(result)));
      if (i < 3) {
        assert.ok(fed && fed.eventName === "PileFed", `filing ${i + 1} fed the pile`);
        assert.deepEqual(fed.args, { runId: result.runId, player: getAddress(player.account.address), epoch: 0n, btcFed, ethFed, hemiFed });
      } else {
        assert.equal(fed, undefined, "the fourth filing fed nothing");
      }
      assert.equal(await f.registry.read.filingsIn([0n, player.account.address]), i + 1);
    }
    // The fourth (30 BTC) would have made BTC dominant; it did not reach the pile.
    assert.deepEqual(await f.registry.read.diet([0n]), [10n, 10n, 10n, 3n]);
    assert.deepEqual(await f.registry.read.allTimeDiet(), [10n, 10n, 10n, 3n]);
    assert.equal(await f.registry.read.dominant([0n]), 1); // the three-way tie → btc, by the tie rule
    // ...but it is a filing like any other: its score is the best, and it counts as a run.
    assert.equal(await f.registry.read.bestScore([player.account.address]), 4_000n);
    assert.equal(await f.registry.read.runs([player.account.address]), 4);

    // Another wallet in the same epoch starts at zero.
    await f.submit(await realistic({ player: player2.account.address, totalFeeds: 5, btcFed: 0, ethFed: 5, hemiFed: 0 }));
    assert.deepEqual(await f.registry.read.diet([0n]), [10n, 15n, 10n, 4n]);
    assert.equal(await f.registry.read.filingsIn([0n, player2.account.address]), 1);

    // The next epoch starts the count again.
    await networkHelpers.time.increase(Number(DAY));
    await f.submit(await realistic({ totalFeeds: 7, btcFed: 7, ethFed: 0, hemiFed: 0 }));
    assert.deepEqual(await f.registry.read.diet([1n]), [7n, 0n, 0n, 1n]);
    assert.equal(await f.registry.read.filingsIn([1n, player.account.address]), 1);
    assert.equal(await f.registry.read.filingsIn([0n, player.account.address]), 4);
    assert.deepEqual(await f.registry.read.allTimeDiet(), [17n, 15n, 10n, 5n]);
  });

  it("dominant: the largest share wins and a tie goes to the earlier token, exactly as dominantOf", async () => {
    const f = await fixture(HOUR);
    // Per epoch: the runs' feed splits, and the expected answer by hand.
    const epochs: Array<{ runs: Array<[number, number, number]>; expected: number }> = [
      { runs: [[5, 5, 5]], expected: 1 },              // three-way tie → btc
      { runs: [[1, 5, 5]], expected: 2 },              // eth/hemi tie → eth
      { runs: [[0, 0, 3]], expected: 3 },              // hemi alone
      { runs: [], expected: 0 },                       // nobody fed it
      { runs: [[0, 0, 0]], expected: 0 },              // one run, nothing fed
      { runs: [[2, 7, 7], [5, 0, 0]], expected: 1 },   // tie reached across two runs → btc
      { runs: [[3, 3, 9]], expected: 3 },              // a btc/eth tie below the winner
      { runs: [[2, 2, 2], [1, 2, 0]], expected: 2 },   // 3/4/2 → eth
      { runs: [[6, 1, 6]], expected: 1 },              // btc/hemi tie → btc
      { runs: [[0, 4, 0]], expected: 2 },
    ];
    for (let epoch = 0; epoch < epochs.length; epoch++) {
      if (epoch > 0) await networkHelpers.time.increase(Number(HOUR));
      assert.equal(await f.registry.read.currentEpoch(), BigInt(epoch));
      for (const [btcFed, ethFed, hemiFed] of epochs[epoch].runs) {
        const totalFeeds = btcFed + ethFed + hemiFed;
        await f.submit(await realistic({ totalFeeds, btcFed, ethFed, hemiFed, bestCombo: Math.min(2, totalFeeds), frenzies: 0 }));
      }
      const [btc, eth, hemi, runs] = await f.registry.read.diet([BigInt(epoch)]);
      assert.equal(runs, BigInt(epochs[epoch].runs.length));
      const onChain = await f.registry.read.dominant([BigInt(epoch)]);
      assert.equal(onChain, epochs[epoch].expected, `epoch ${epoch}`);
      assert.equal(onChain, dominantOf({ btc, eth, hemi }), `epoch ${epoch} disagrees with dominantOf`);
    }
  });

  // ------------------------------------------------------------ selectors

  it("the error selectors the Worker and client decode", (t) => {
    const selectors = Object.fromEntries(["InvalidResult()", "InvalidSignature()", "DuplicateRun()", "WrongVersion()", "Expired()", "EnforcedPause()"].map((sig) => [sig, toFunctionSelector(sig)]));
    t.diagnostic(JSON.stringify(selectors));
    assert.equal(selectors["DuplicateRun()"].length, 10);
  });
});
