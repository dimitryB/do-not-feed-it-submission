import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";
import { Miniflare } from "miniflare";
import { encodePacked, hashTypedData, keccak256, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { MAX_COMMANDS, traceHash } from "../lib/chain/trace.ts";
import {
  attestationTypedData, DEADLINE_SECONDS, GAME_VERSION_ID, resultHash, resultTypedData, seedToBytes32,
} from "../lib/chain/types.ts";
import { ARENA, GAME_VERSION, replayArcade, TUNING } from "../lib/game/arcade.ts";
import {
  assertContractBounds, buildResult, CONTRACT_BOUNDS, hashTrace, maxFeedsFor, maxFrenziesFor, payloadHashOf, signAttestation, VerifyError, verifyRun,
} from "../worker/verifier.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const fixtures = JSON.parse(readFileSync(path.join(HERE, "fixtures", "loop-traces.json"), "utf8"));

/** Hardhat's first well-known test key. Never a real key. */
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CONTRACT = "0x000000000000000000000000000000000000dEaD";
const PLAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CHAIN_ID = 31337;
const TICKET = { runId: `0x${"11".repeat(32)}`, snapshotHash: `0x${"22".repeat(32)}` };

const metricsFromState = (state, hash) => ({
  score: BigInt(state.score), durationTicks: state.tick, totalFeeds: state.totalFeeds,
  btcFed: state.servings.metal, ethFed: state.servings.balloon, hemiFed: state.servings.pepper,
  bestCombo: state.bestCombo, frenzies: state.frenzies, sizeCenti: Math.round(state.size * 100),
  ending: state.ending, cause: ["empty-belly", "kitchen-destroyed", "outgrew-the-kitchen"].indexOf(state.failureReason),
  traceHash: hash,
});

const rejects = (fn, code, label = "") => {
  let error;
  try { fn(); } catch (e) { error = e; }
  assert.ok(error instanceof VerifyError, `${label}: expected a VerifyError, got ${error?.constructor?.name ?? "nothing"}`);
  if (code instanceof RegExp) assert.match(error.code, code, label);
  else assert.equal(error.code, code, label);
};

/** A fixture's replay input: the trait it was recorded with (null for the plain traces). */
const inputOf = (trace, overrides = {}) => ({ seed: trace.seed, commands: trace.commands, endTick: trace.endTick, inherited: trace.inherited ?? null, ...overrides });

test("verifyRun derives every signed number from the replay of the frozen fixtures, each with its inherited trait", () => {
  assert.equal(fixtures.gameVersion, GAME_VERSION);
  assert.deepEqual(fixtures.traces.map((t) => t.inherited ?? null), [null, null, null, "metal", "balloon", "pepper"], "three plain traces, one per trait");
  for (const trace of fixtures.traces) {
    const label = `${trace.bot}/${trace.inherited ?? "plain"}`;
    const metrics = verifyRun(inputOf(trace));
    assert.equal(metrics.score, BigInt(trace.expect.score), `${label}: score`);
    assert.equal(metrics.totalFeeds, trace.expect.totalFeeds, `${label}: feeds`);
    // Each shift ends the way it was recorded ending (the blind bot's kitchen is wrecked; the rest run out of gas).
    assert.equal(metrics.cause, ["empty-belly", "kitchen-destroyed", "outgrew-the-kitchen"].indexOf(trace.expect.failureReason), `${label}: cause is ${trace.expect.failureReason}`);
    assert.equal(metrics.durationTicks, trace.endTick);
    const state = replayArcade(trace.seed, trace.commands, trace.endTick, trace.inherited ?? null);
    assert.deepEqual(metrics, metricsFromState(state, traceHash(trace.commands, trace.endTick)), `${label}: metrics`);
    assert.equal(metrics.btcFed + metrics.ethFed + metrics.hemiFed, metrics.totalFeeds);
    assert.equal(metrics.traceHash, hashTrace(trace.commands, trace.endTick));
    assert.equal(state.inherited, trace.inherited ?? null);
  }
});

test("verifyRun with the wrong inherited trait is another creature: the recorded shots do not land", () => {
  const plain = fixtures.traces.find((t) => !t.inherited);
  rejects(() => verifyRun(inputOf(plain, { inherited: "metal" })), /invalid_trace|run_not_over/);
  for (const trace of fixtures.traces.filter((t) => t.inherited)) {
    rejects(() => verifyRun(inputOf(trace, { inherited: null })), /invalid_trace|run_not_over/, `${trace.inherited} replayed plain`);
    const other = trace.inherited === "metal" ? "pepper" : "metal";
    rejects(() => verifyRun(inputOf(trace, { inherited: other })), /invalid_trace|run_not_over/, `${trace.inherited} replayed as ${other}`);
  }
  assert.throws(() => verifyRun(inputOf(plain, { inherited: "gold" })), /inherited/, "an unknown trait is a server fault, not a client one");
});

test("verifyRun rejects a run that has not ended", () => {
  const trace = fixtures.traces[0];
  const endTick = trace.endTick - 1;
  const commands = trace.commands.filter((c) => c.tick <= endTick);
  rejects(() => verifyRun({ seed: trace.seed, commands, endTick }), "run_not_over");
  rejects(() => verifyRun({ seed: trace.seed, commands: trace.commands.slice(0, 3), endTick: 100 }), "run_not_over");
});

test("verifyRun rejects an endTick past the tick the run really ended on", () => {
  const trace = fixtures.traces[0];
  rejects(() => verifyRun({ seed: trace.seed, commands: trace.commands, endTick: trace.endTick + 1 }), "invalid_trace");
  rejects(() => verifyRun({ seed: trace.seed, commands: trace.commands, endTick: ARENA.maxTicks }), "invalid_trace");
});

test("verifyRun never returns the honest result for a tampered command", () => {
  const trace = fixtures.traces[2];
  const honest = verifyRun({ seed: trace.seed, commands: trace.commands, endTick: trace.endTick });
  const launches = trace.commands.map((c, i) => (c.kind === "launch" ? i : -1)).filter((i) => i >= 0);
  let failedClosed = 0;
  let changedNumbers = 0;
  for (const index of launches.filter((_, n) => n % 20 === 0)) {
    const tampered = trace.commands.map((c, i) => (i === index ? { ...c, power: c.power === 16 ? 9 : 16 } : c));
    let outcome;
    try {
      outcome = verifyRun({ seed: trace.seed, commands: tampered, endTick: trace.endTick });
    } catch (error) {
      assert.ok(error instanceof VerifyError, "a tampered run that cannot replay fails closed");
      failedClosed += 1;
      continue;
    }
    // It replayed and ended on the same tick: the signed result still differs, by its hash at least.
    assert.notEqual(outcome.traceHash, honest.traceHash);
    if (outcome.score !== honest.score || outcome.totalFeeds !== honest.totalFeeds) changedNumbers += 1;
  }
  assert.ok(failedClosed > 0, "some tampered shots make the recorded run impossible (a launch lands on a cooldown, the run ends elsewhere)");
  assert.ok(changedNumbers > 0, "some tampered shots replay to different numbers");
});

test("verifyRun rejects the wrong seed and a malformed or over-long trace", () => {
  const trace = fixtures.traces[0];
  rejects(() => verifyRun({ seed: trace.seed + 1, commands: trace.commands, endTick: trace.endTick }), "invalid_trace");
  rejects(() => verifyRun({ seed: trace.seed, commands: "nope", endTick: trace.endTick }), "invalid_trace");
  rejects(() => verifyRun({ seed: trace.seed, commands: [{ tick: 0, kind: "launch", ingredient: "gold", angle: -40, power: 13 }], endTick: 10 }), "invalid_trace");
  rejects(() => verifyRun({ seed: trace.seed, commands: trace.commands, endTick: ARENA.maxTicks + 1 }), "invalid_trace");
  rejects(() => verifyRun({ seed: trace.seed, commands: trace.commands, endTick: -1 }), "invalid_trace");
  const tooMany = Array.from({ length: MAX_COMMANDS + 1 }, (_, i) => ({ tick: i, kind: "hatch" }));
  rejects(() => verifyRun({ seed: trace.seed, commands: tooMany, endTick: ARENA.maxTicks }), "invalid_trace");
  rejects(() => hashTrace(tooMany, ARENA.maxTicks), "invalid_trace");
  // A rejected launch (on cooldown) is a rule violation, not a shape error.
  const doubled = [trace.commands[0], { ...trace.commands[0], tick: 1 }, ...trace.commands.slice(1)];
  rejects(() => verifyRun({ seed: trace.seed, commands: doubled, endTick: trace.endTick }), "invalid_trace");
  assert.throws(() => verifyRun({ seed: -1, commands: trace.commands, endTick: trace.endTick }), /Invalid seed/);
});

test("the contract bounds are mirrored from the rules' constants, and refused as out_of_bounds at each edge", () => {
  // The registry's constants, by the names its comments give them (contracts/FeedRegistry.sol).
  assert.deepEqual({ ...CONTRACT_BOUNDS }, {
    maxDurationTicks: ARENA.maxTicks, feedCooldownTicks: ARENA.frenzyCooldownTicks, crateCoins: TUNING.crateCoins, crateGapMin: TUNING.crateGapMin,
    feedsPerFrenzy: TUNING.frenzyAt, maxSizeCenti: 1_000, maxEnding: 3, maxCause: 2, maxScorePerTick: 4_000n,
  });
  assert.equal(ARENA.maxTicks, 43_200);
  assert.equal(ARENA.frenzyCooldownTicks, 15);
  assert.equal(TUNING.crateCoins, 3);
  assert.equal(TUNING.crateGapMin, 120);
  assert.equal(TUNING.frenzyAt, 5);
  const d = 6_000;
  assert.equal(maxFeedsFor(d), Math.floor(d / 15) + 1 + 3 * (Math.floor(d / 120) + 1), "the contract's totalFeeds bound");
  assert.equal(maxFrenziesFor(77), Math.floor(77 / 5) + 1);

  const trace = fixtures.traces[1];
  const metrics = verifyRun({ seed: trace.seed, commands: trace.commands, endTick: trace.endTick });
  assert.doesNotThrow(() => assertContractBounds(metrics));
  const outOfBounds = (m, what) => {
    let error;
    try { assertContractBounds(m); } catch (e) { error = e; }
    assert.ok(error instanceof VerifyError && error.code === "out_of_bounds", `${what}: out_of_bounds`);
    assert.match(error.message, what);
  };
  // Every edge: the bound itself passes, one past it fails.
  const feeds = maxFeedsFor(metrics.durationTicks);
  const atFeeds = (n) => ({ ...metrics, totalFeeds: n, btcFed: n, ethFed: 0, hemiFed: 0, bestCombo: Math.min(metrics.bestCombo, n), frenzies: 0 });
  assert.doesNotThrow(() => assertContractBounds(atFeeds(feeds)));
  outOfBounds(atFeeds(feeds + 1), /totalFeeds/);
  const frenzies = maxFrenziesFor(metrics.totalFeeds);
  assert.doesNotThrow(() => assertContractBounds({ ...metrics, frenzies }));
  outOfBounds({ ...metrics, frenzies: frenzies + 1 }, /frenzies/);
  const scoreCap = BigInt(metrics.durationTicks) * 4_000n;
  assert.doesNotThrow(() => assertContractBounds({ ...metrics, score: scoreCap }));
  outOfBounds({ ...metrics, score: scoreCap + 1n }, /score/);
  outOfBounds({ ...metrics, score: BigInt(metrics.durationTicks) * 2_000n * 3n }, /score/);
  const atTicks = (n) => ({ ...metrics, durationTicks: n, score: 0n, totalFeeds: 0, btcFed: 0, ethFed: 0, hemiFed: 0, bestCombo: 0, frenzies: 0 });
  assert.doesNotThrow(() => assertContractBounds(atTicks(ARENA.maxTicks)));
  outOfBounds(atTicks(ARENA.maxTicks + 1), /durationTicks/);
  outOfBounds(atTicks(0), /durationTicks/);
  assert.doesNotThrow(() => assertContractBounds({ ...metrics, bestCombo: metrics.totalFeeds }));
  outOfBounds({ ...metrics, bestCombo: metrics.totalFeeds + 1 }, /bestCombo/);
  assert.doesNotThrow(() => assertContractBounds({ ...metrics, sizeCenti: 1_000 }));
  outOfBounds({ ...metrics, sizeCenti: 1_001 }, /sizeCenti/);
  assert.doesNotThrow(() => assertContractBounds({ ...metrics, ending: 3 }));
  outOfBounds({ ...metrics, ending: 4 }, /ending/);
  assert.doesNotThrow(() => assertContractBounds({ ...metrics, cause: 2 }));
  outOfBounds({ ...metrics, cause: 3 }, /cause/);
  outOfBounds({ ...metrics, btcFed: metrics.btcFed + 1 }, /diet sum/);
});

test("buildResult dates the deadline and binds the ticket, the player and the trace", () => {
  const trace = fixtures.traces[0];
  const metrics = verifyRun({ seed: trace.seed, commands: trace.commands, endTick: trace.endTick });
  const result = buildResult({ ...TICKET, seed: trace.seed }, PLAYER, metrics, 1_700_000_000);
  assert.equal(result.deadline, BigInt(1_700_000_000 + DEADLINE_SECONDS));
  assert.equal(result.runId, TICKET.runId);
  assert.equal(result.snapshotHash, TICKET.snapshotHash);
  assert.equal(result.gameVersion, GAME_VERSION_ID);
  assert.equal(result.player, PLAYER);
  assert.equal(result.seed, seedToBytes32(trace.seed));
  assert.equal(result.traceHash, traceHash(trace.commands, trace.endTick));
  assert.equal(result.score, BigInt(trace.expect.score));
  assert.equal(result.durationTicks, trace.endTick);
  assert.throws(() => buildResult({ ...TICKET, seed: trace.seed }, PLAYER, metrics, -1), /clock/);
});

test("signAttestation verifies against the verifier's address and over the result's own digest", async () => {
  const trace = fixtures.traces[0];
  const metrics = verifyRun({ seed: trace.seed, commands: trace.commands, endTick: trace.endTick });
  const result = buildResult({ ...TICKET, seed: trace.seed }, PLAYER, metrics, 1_700_000_000);
  const signature = await signAttestation(result, CONTRACT, CHAIN_ID, TEST_KEY);
  const verifier = privateKeyToAccount(TEST_KEY).address;
  const typed = attestationTypedData(result, CONTRACT, CHAIN_ID);
  assert.equal(typed.message.resultHash, hashTypedData(resultTypedData(result, CONTRACT, CHAIN_ID)));
  assert.equal(typed.message.resultHash, resultHash(result, CONTRACT, CHAIN_ID));
  assert.equal(await verifyTypedData({ ...typed, address: verifier, signature }), true);
  assert.equal(await verifyTypedData({ ...typed, address: PLAYER, signature }), false, "not the player's signature");
  const other = attestationTypedData({ ...result, score: result.score + 1n }, CONTRACT, CHAIN_ID);
  assert.equal(await verifyTypedData({ ...other, address: verifier, signature }), false, "a changed field breaks the signature");
  const otherChain = attestationTypedData(result, CONTRACT, 43_111);
  assert.equal(await verifyTypedData({ ...otherChain, address: verifier, signature }), false, "the domain binds the chain");
});

test("payloadHashOf is keccak256(runId ‖ traceHash ‖ endTick): the player is not part of it", () => {
  const hash = `0x${"33".repeat(32)}`;
  const expected = keccak256(encodePacked(["bytes32", "bytes32", "uint32"], [TICKET.runId, hash, 4058]));
  assert.equal(payloadHashOf(TICKET.runId, hash, 4058), expected);
  assert.notEqual(payloadHashOf(TICKET.runId, `0x${"44".repeat(32)}`, 4058), expected);
  assert.notEqual(payloadHashOf(TICKET.runId, hash, 4059), expected);
  assert.notEqual(payloadHashOf(`0x${"12".repeat(32)}`, hash, 4058), expected);
  assert.equal(payloadHashOf.length, 3, "no player argument");
});

/* ------------------------------------------------------------------ *
 * Determinism in workerd (docs/CHAIN.md §3)
 * ------------------------------------------------------------------ */

const WORKER_ENTRY = `
import { replayArcade } from "./lib/game/arcade.ts";
const pick = (s) => ({
  score: s.score, totalFeeds: s.totalFeeds, phase: s.phase, failureReason: s.failureReason, tick: s.tick,
  bestCombo: s.bestCombo, frenzies: s.frenzies, servings: s.servings, size: s.size, ending: s.ending, inherited: s.inherited, mutations: s.mutations,
});
export default {
  async fetch(request) {
    const { seed, commands, endTick, inherited } = await request.json();
    // The clock only advances on I/O in workerd; bracket the replay with a timer so the difference is the CPU time.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const started = Date.now();
    const state = replayArcade(seed, commands, endTick, inherited ?? null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const elapsedMs = Date.now() - started;
    return Response.json({ final: pick(state), elapsedMs });
  },
};
`;

async function bundleWorker() {
  const built = await esbuild.build({
    stdin: { contents: WORKER_ENTRY, resolveDir: ROOT, loader: "ts", sourcefile: "entry.ts" },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", logLevel: "silent",
  });
  return built.outputFiles[0].text;
}

test("the frozen fixtures replay in workerd exactly as in Node", async (t) => {
  const miniflare = new Miniflare({ modules: true, script: await bundleWorker(), compatibilityDate: "2025-01-01" });
  t.after(() => miniflare.dispose());
  const run = async (seed, commands, endTick, inherited) => {
    const started = performance.now();
    const response = await miniflare.dispatchFetch("http://replay/", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seed, commands, endTick, inherited }),
    });
    const wallMs = performance.now() - started;
    assert.equal(response.status, 200);
    return { ...(await response.json()), wallMs };
  };
  // Warm the isolate so the first measurement does not include compilation.
  await run(fixtures.traces[0].seed, [], 1, null);
  const timings = [];
  const ROUNDS = 3;
  const timed = async (bot, seed, commands, endTick, inherited) => {
    let best = null;
    let nodeMs = Infinity;
    for (let round = 0; round < ROUNDS; round++) {
      const started = performance.now();
      replayArcade(seed, commands, endTick, inherited);
      nodeMs = Math.min(nodeMs, performance.now() - started);
      const sample = await run(seed, commands, endTick, inherited);
      if (!best || sample.elapsedMs < best.elapsedMs) best = sample;
    }
    timings.push({ bot, inherited, ticks: best.final.tick, commands: commands.length, workerdMs: best.elapsedMs, wallMs: Math.round(best.wallMs), nodeMs: Math.round(nodeMs) });
    return best.final;
  };
  for (const trace of fixtures.traces) {
    const inherited = trace.inherited ?? null;
    const node = replayArcade(trace.seed, trace.commands, trace.endTick, inherited);
    const final = await timed(trace.bot, trace.seed, trace.commands, trace.endTick, inherited);
    assert.deepEqual(final, {
      score: node.score, totalFeeds: node.totalFeeds, phase: node.phase, failureReason: node.failureReason, tick: node.tick,
      bestCombo: node.bestCombo, frenzies: node.frenzies, servings: node.servings, size: node.size, ending: node.ending,
      inherited, mutations: node.mutations,
    }, `${trace.bot}/${inherited ?? "plain"}: workerd and Node disagree`);
    assert.equal(final.score, trace.expect.score);
  }
  // A twelve-minute endTick on the good trace: the run is lost at its real end, so this measures the same work.
  const good = fixtures.traces[2];
  const long = await timed("good@43200", good.seed, good.commands, ARENA.maxTicks, good.inherited ?? null);
  assert.equal(long.tick, good.endTick, "the replay stops where the run was lost, not at endTick");
  t.diagnostic(`replay timings (best of ${ROUNDS}): ${JSON.stringify(timings)}`);
});
