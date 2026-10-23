#!/usr/bin/env node
/**
 * Check a filed shift against what is on chain — anyone can, with the public
 * site and a Hemi RPC. docs/CHAIN.md §3, README "The chain".
 *
 *   node --experimental-strip-types scripts/verify-filing.mjs \
 *     --site https://<the game> --rpc https://rpc.hemi.network/rpc --tx 0x<transaction hash>
 *   node --experimental-strip-types scripts/verify-filing.mjs \
 *     --site https://<the game> --rpc <url> --contract 0x<registry> --run 0x<run id> [--from-block N]
 *   node --experimental-strip-types scripts/verify-filing.mjs --site <url> --run 0x<run id> --no-chain
 *
 * What it proves, in order:
 *   1. the site's trace bytes hash to the `traceHash` it claims (keccak256);
 *   2. the snapshot preimage hashes to the `snapshotHash` it claims;
 *   3. replaying the trace with THIS checkout's rules, from the trace's seed
 *      and trait, gives exactly the numbers the verifier attested;
 *   4. (with the chain) the `ResultRecorded` event holds the same runId,
 *      traceHash, snapshotHash, player and numbers, under the same rules
 *      version this checkout has.
 * Run it from the commit whose GAME_VERSION the filing names (the event's
 * `gameVersion` is keccak256("do-not-feed-it/arcade/N")); another version's
 * rules replay to other numbers, and the script says so rather than failing
 * silently.
 */
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createPublicClient, decodeEventLog, getAddress, http, keccak256 } from "viem";
import { GAME_VERSION, replayArcade } from "../lib/game/arcade.ts";
import { feedRegistryAbi, gameVersionId, resultFromJson, snapshotHashOf, causeCode, dominantOf, inheritedOf, seedToBytes32 } from "../lib/chain/types.ts";
import { traceHash } from "../lib/chain/trace.ts";

function parseArgs(argv) {
  const args = { site: null, rpc: null, contract: null, tx: null, run: null, fromBlock: null, chain: true };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--site") args.site = argv[++i];
    else if (item === "--rpc") args.rpc = argv[++i];
    else if (item === "--contract") args.contract = argv[++i];
    else if (item === "--tx") args.tx = argv[++i];
    else if (item === "--run") args.run = argv[++i];
    else if (item === "--from-block") args.fromBlock = BigInt(argv[++i]);
    else if (item === "--no-chain") args.chain = false;
    else throw new Error(`Unknown argument ${item}`);
  }
  if (!args.site) throw new Error("--site is required");
  if (!args.tx && !args.run) throw new Error("--tx or --run is required");
  if (args.chain && !args.rpc) throw new Error("--rpc is required (or --no-chain)");
  if (args.chain && args.run && !args.contract) throw new Error("--contract is required with --run (or use --tx)");
  return args;
}

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

/** Only the expected registry can provide proof of a filing; an arbitrary contract can emit the same ABI. */
export function recordedEventsIn(logs, contract, runId = null) {
  const events = [];
  for (const log of logs) {
    if (getAddress(log.address) !== getAddress(contract)) continue;
    try {
      const decoded = decodeEventLog({ abi: feedRegistryAbi, data: log.data, topics: log.topics });
      if (decoded.eventName === "ResultRecorded" && (!runId || decoded.args.runId.toLowerCase() === runId.toLowerCase())) events.push(decoded.args);
    } catch { /* another event */ }
  }
  return events;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = args.chain ? createPublicClient({ transport: http(args.rpc) }) : null;

  // A transaction's emitter is not an authority: any contract can copy the event ABI.
  // Pin the expected registry explicitly, or use the registry published by the chosen site.
  let event = null;
  let contract = args.contract ? getAddress(args.contract) : null;
  if (args.chain && args.tx) {
    if (!contract) {
      const response = await fetch(`${args.site.replace(/\/$/, "")}/api/chain/config`);
      if (!response.ok) throw new Error(`Cannot read the site's registry configuration (${response.status}); pass --contract explicitly`);
      const config = await response.json();
      if (!config.enabled || !config.contractAddress) throw new Error("The site has no enabled registry; pass --contract explicitly");
      contract = getAddress(config.contractAddress);
    }
    const receipt = await client.getTransactionReceipt({ hash: args.tx });
    check("transaction succeeded", receipt.status === "success", `block ${receipt.blockNumber}`);
    const events = recordedEventsIn(receipt.logs, contract, args.run);
    check("the expected registry recorded exactly one matching run in this transaction", events.length === 1, `${events.length} event(s), registry ${contract}`);
    if (events.length !== 1) return finish();
    [event] = events;
  }
  const runId = (args.run ?? event?.runId).toLowerCase();

  // The site's record.
  const url = `${args.site.replace(/\/$/, "")}/api/chain/trace?runId=${runId}`;
  const response = await fetch(url);
  check("the site serves the trace", response.ok, `${response.status} ${url}`);
  if (!response.ok) return finish();
  const trace = await response.json();
  check("the trace belongs to the requested run", trace.runId?.toLowerCase() === runId);
  if (args.chain) {
    check("the trace names the expected registry", getAddress(trace.contractAddress) === contract, contract);
    const chainId = await client.getChainId();
    check("the RPC serves the trace's chain", chainId === trace.chainId, `RPC ${chainId}, trace ${trace.chainId}`);
  }

  // 1. The bytes hash to the trace hash.
  const bytesHash = keccak256(trace.trace);
  check("keccak256(trace bytes) == traceHash", bytesHash.toLowerCase() === trace.traceHash.toLowerCase(), bytesHash);
  const fromCommands = traceHash(trace.commands, trace.endTick);
  check("the decoded commands re-encode to the same hash", fromCommands.toLowerCase() === trace.traceHash.toLowerCase());

  // 2. The snapshot preimage hashes to the snapshot hash.
  const s = trace.snapshot;
  const snap = snapshotHashOf(BigInt(s.epoch), BigInt(s.sourceEpoch ?? 0), { btc: BigInt(s.btc), eth: BigInt(s.eth), hemi: BigInt(s.hemi) });
  check("snapshot preimage == snapshotHash", snap.toLowerCase() === trace.snapshotHash.toLowerCase(), `epoch ${s.epoch}, source ${s.sourceEpoch ?? "none"}, pile ${s.btc}/${s.eth}/${s.hemi}`);
  const inherited = dominantOf({ btc: BigInt(s.btc), eth: BigInt(s.eth), hemi: BigInt(s.hemi) });
  check("the replay trait comes from the committed snapshot", trace.inherited === inherited && (trace.trait ?? null) === inheritedOf(inherited));

  // 3. The replay, with this checkout's rules.
  const attested = resultFromJson(trace.attested);
  check("the attested result binds this run, seed, trace and snapshot", attested.runId.toLowerCase() === runId
    && attested.seed.toLowerCase() === seedToBytes32(trace.seed).toLowerCase()
    && attested.traceHash.toLowerCase() === trace.traceHash.toLowerCase()
    && attested.snapshotHash.toLowerCase() === trace.snapshotHash.toLowerCase()
    && attested.gameVersion.toLowerCase() === trace.gameVersionId.toLowerCase());
  const sameVersion = trace.gameVersionId.toLowerCase() === gameVersionId(GAME_VERSION).toLowerCase();
  check(`the trace was attested under this checkout's rules (GAME_VERSION ${GAME_VERSION})`, sameVersion, trace.gameVersionId);
  let state = null;
  try {
    state = replayArcade(trace.seed, trace.commands, trace.endTick, trace.trait ?? null);
  } catch (error) {
    check("the trace replays", false, error.message);
  }
  if (state) {
    const derived = {
      score: BigInt(state.score), durationTicks: state.tick, totalFeeds: state.totalFeeds,
      btcFed: state.servings.metal, ethFed: state.servings.balloon, hemiFed: state.servings.pepper,
      bestCombo: state.bestCombo, frenzies: state.frenzies, sizeCenti: Math.round(state.size * 100),
      ending: state.ending, cause: causeCode(state.failureReason),
    };
    check("the replay ended where the trace says", state.phase === "lost" && state.tick === trace.endTick, `tick ${state.tick}, ${state.failureReason}`);
    const diffs = Object.entries(derived).filter(([k, v]) => v !== attested[k]).map(([k, v]) => `${k}: replay ${v} vs attested ${attested[k]}`);
    check("the replay's numbers == the attested numbers", diffs.length === 0, diffs.join("; ") || `score ${derived.score}, ${derived.durationTicks} ticks, ${derived.btcFed}/${derived.ethFed}/${derived.hemiFed}`);
  }

  // 4. The chain.
  if (args.chain) {
    if (!event) {
      const fromBlock = args.fromBlock ?? 0n;
      const logs = await client.getLogs({ address: contract, event: feedRegistryAbi.find((x) => x.type === "event" && x.name === "ResultRecorded"), args: { runId }, fromBlock, toBlock: "latest" });
      check("the registry recorded this run id", logs.length === 1, `${logs.length} event(s) from block ${fromBlock}`);
      if (logs.length !== 1) return finish();
      event = decodeEventLog({ abi: feedRegistryAbi, data: logs[0].data, topics: logs[0].topics }).args;
    }
    const used = await client.readContract({ address: contract, abi: feedRegistryAbi, functionName: "usedRunIds", args: [runId] });
    check("usedRunIds(runId) on chain", used === true);
    check("event.traceHash == the trace's hash", event.traceHash.toLowerCase() === trace.traceHash.toLowerCase(), event.traceHash);
    check("event.snapshotHash == the trace's snapshot hash", event.snapshotHash.toLowerCase() === trace.snapshotHash.toLowerCase());
    check("event.gameVersion == the trace's version", event.gameVersion.toLowerCase() === trace.gameVersionId.toLowerCase());
    // A run is bound to the wallet of its first attestation (the Worker refuses any other), so the chain's player is the attested one.
    check("event.player == the attested player", getAddress(event.player) === getAddress(attested.player), getAddress(event.player));
    // The event carries the diet by token, not totalFeeds; the contract checked the sum on the way in.
    const fields = ["score", "durationTicks", "btcFed", "ethFed", "hemiFed", "bestCombo", "frenzies", "sizeCenti", "ending", "cause"];
    const diffs = fields.filter((k) => BigInt(event[k]) !== BigInt(attested[k])).map((k) => `${k}: chain ${event[k]} vs attested ${attested[k]}`);
    const fed = BigInt(event.btcFed) + BigInt(event.ethFed) + BigInt(event.hemiFed);
    if (fed !== BigInt(attested.totalFeeds)) diffs.push(`totalFeeds: chain ${fed} vs attested ${attested.totalFeeds}`);
    check("the event's numbers == the attested numbers", diffs.length === 0, diffs.join("; ") || `score ${event.score}, epoch ${event.epoch}`);
  }
  return finish();
}

function finish() {
  const failed = checks.filter((c) => !c.ok);
  console.log(failed.length ? `\nFAIL: ${failed.length} of ${checks.length} checks failed` : `\nPASS: all ${checks.length} checks`);
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message ?? error); process.exit(2); });
}
