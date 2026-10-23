import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
// Run the actual CLI with fetch replaced by a local fixture. No network, server or deployed contract is needed.
const cliFixture = String.raw`
import { readFileSync } from "node:fs";
import { encodeAbiParameters, encodeEventTopics, getAbiItem, toHex } from "viem";
import { verifyRun, buildResult } from "./worker/verifier.ts";
import { encodeTrace } from "./lib/chain/trace.ts";
import { feedRegistryAbi, resultToJson, snapshotHashOf, GAME_VERSION_ID } from "./lib/chain/types.ts";
const mode = process.env.DNFI_VERIFY_TEST_CASE;
const fixture = JSON.parse(readFileSync("./tests/fixtures/loop-traces.json", "utf8")).traces.find((trace) => !trace.inherited);
const contract = "0x0000000000000000000000000000000000000001";
const impostor = "0x0000000000000000000000000000000000000002";
const runId = "0x" + "ab".repeat(32);
const player = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const txHash = "0x" + "cd".repeat(32);
const blockHash = "0x" + "ef".repeat(32);
const snapshot = { epoch: 0, sourceEpoch: null, btc: "0", eth: "0", hemi: "0", runs: "0" };
const snapshotHash = snapshotHashOf(0n, 0n, { btc: 0n, eth: 0n, hemi: 0n });
const metrics = verifyRun({ seed: fixture.seed, commands: fixture.commands, endTick: fixture.endTick });
const result = buildResult({ runId, seed: fixture.seed, snapshotHash }, player, metrics, 1800000000);
const event = getAbiItem({ abi: feedRegistryAbi, name: "ResultRecorded" });
const data = encodeAbiParameters(event.inputs.filter((field) => !field.indexed), [result.score, result.durationTicks, result.btcFed, result.ethFed, result.hemiFed, result.bestCombo, result.frenzies, result.sizeCenti, result.ending, result.cause, 0n, snapshotHash, result.traceHash]);
const topics = encodeEventTopics({ abi: feedRegistryAbi, eventName: "ResultRecorded", args: { runId, player, gameVersion: GAME_VERSION_ID } });
const log = { address: mode === "spoofed-emitter" ? impostor : contract, data, topics, blockNumber: "0x1", blockHash, transactionHash: txHash, transactionIndex: "0x0", logIndex: "0x0", removed: false };
const receipt = { transactionHash: txHash, transactionIndex: "0x0", blockHash, blockNumber: "0x1", from: player, to: contract, cumulativeGasUsed: "0x1", gasUsed: "0x1", contractAddress: null, logs: mode === "ambiguous-events" ? [log, { ...log, logIndex: "0x1" }] : [log], logsBloom: "0x" + "00".repeat(256), status: "0x1", type: "0x2", effectiveGasPrice: "0x1" };
const attested = resultToJson(result);
if (mode === "altered-attested-seed") attested.seed = "0x" + "00".repeat(32);
globalThis.fetch = async (input, init) => {
  const url = String(input);
  let answer;
  if (url.endsWith("/api/chain/config")) answer = { enabled: true, contractAddress: contract, chainId: 31337 };
  else if (url.includes("/api/chain/trace")) answer = { runId, gameVersionId: GAME_VERSION_ID, chainId: 31337, contractAddress: contract, seed: fixture.seed, inherited: 0, trait: null, snapshot, snapshotHash, commands: fixture.commands, endTick: fixture.endTick, traceHash: metrics.traceHash, trace: toHex(encodeTrace(fixture.commands, fixture.endTick)), attested };
  else {
    const body = JSON.parse(init.body);
    let result;
    if (body.method === "eth_getTransactionReceipt") result = receipt;
    else if (body.method === "eth_chainId") result = mode === "wrong-rpc-chain" ? "0x1" : "0x7a69";
    else if (body.method === "eth_call") result = encodeAbiParameters([{ type: "bool" }], [true]);
    else throw new Error("Unexpected mocked RPC call: " + body.method);
    answer = { jsonrpc: "2.0", id: body.id, result };
  }
  return new Response(JSON.stringify(answer), { headers: { "Content-Type": "application/json" } });
};
process.argv = [process.execPath, process.cwd() + "/scripts/verify-filing.mjs", "--site", "https://fixture.test", "--rpc", "https://rpc.test", "--tx", txHash, ...(mode === "wrong-explicit-contract" ? ["--contract", impostor] : [])];
await import("./scripts/verify-filing.mjs");
`;

test("the CLI accepts a genuine filing and refuses spoofed, ambiguous or mismatched proof", () => {
  for (const [mode, status] of [
    ["valid", 0], ["spoofed-emitter", 1], ["wrong-explicit-contract", 1],
    ["ambiguous-events", 1], ["wrong-rpc-chain", 1], ["altered-attested-seed", 1],
  ]) {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), input: cliFixture, encoding: "utf8",
      env: { ...process.env, DNFI_VERIFY_TEST_CASE: mode },
    });
    assert.equal(result.status, status, `${mode}: ${result.stdout}\n${result.stderr}`);
  }
});
