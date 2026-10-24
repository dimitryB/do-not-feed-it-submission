import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, getAbiItem } from "viem";
import { GAME_VERSION_ID, feedRegistryAbi, resultToJson, resultTypedData, seedToBytes32 } from "../lib/chain/types.ts";
import { rankProviders, recordedIn } from "../lib/chain/wallet.ts";
import { traceHash } from "../lib/chain/trace.ts";
import { ChainApiError, TICKET_REUSE_SECONDS, addressUrl, chainFromConfig, decodeAttest, decodeConfig, decodeTicket, decodeWorld, ticketIsFresh, txUrl } from "../lib/chain/api.ts";
import {
  OFF_PRACTICE, READY, canonical, isCancellable, playedNumbers, reduce, runLedger, sessionFilingStore, toFailure, verifyAttestation,
} from "../lib/chain/ledger.ts";
import { INHERITED, LEDGER, LEDGER_PAGE, TOKEN_TRAITS } from "../lib/render/lore.ts";
import { defaultBoard, epochSpan, formatSpan, sharesOf, traitOf, uptime } from "../lib/chain/ledgerView.ts";

/**
 * The ledger is a state machine with the world injected (docs/CHAIN.md §8):
 * the reducer is pure, the driver walks it through fakes. Nothing here opens
 * a wallet, a socket or a browser.
 */

const PLAYER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const CONTRACT = "0x3333333333333333333333333333333333333333";
const CHAIN_ID = 31337;
const SIG = `0x${"ab".repeat(64)}1b`;
const TX = `0x${"cd".repeat(32)}`;
const NOW = 1_800_000_000;

const commands = [
  { tick: 30, kind: "launch", ingredient: "metal", angle: -40, power: 12 },
  { tick: 90, kind: "hatch" },
  { tick: 150, kind: "launch", ingredient: "pepper", angle: -35, power: 11 },
];
const endTick = 400;
const ticket = { runId: `0x${"77".repeat(32)}`, seed: 20260911, issuedAt: NOW - 60, expiresAt: NOW + 2340, epoch: 3, snapshotHash: `0x${"88".repeat(32)}`, sourceEpoch: 2, inherited: 1, snapshot: { btc: 10n, eth: 2n, hemi: 1n, runs: 1n, dominant: 1 } };
/** The page's own final state, as the report shows it (one Bitcoin and one HEMI fed, size ×1.23, ending 1, out of gas). */
const finalState = { score: 4_200, totalFeeds: 2, servings: { metal: 1, balloon: 0, pepper: 1 }, bestCombo: 2, frenzies: 0, size: 1.234, ending: 1, failureReason: "empty-belly" };
const played = playedNumbers(finalState);
const input = { ticket, commands, endTick, played, contractAddress: CONTRACT, chainId: CHAIN_ID };

/** What an honest verifier answers for this shift, with room to tamper. */
function attestation(patch = {}, player = PLAYER) {
  const result = {
    runId: ticket.runId, gameVersion: GAME_VERSION_ID, player,
    score: 4_200n, durationTicks: endTick, totalFeeds: 2, btcFed: 1, ethFed: 0, hemiFed: 1,
    bestCombo: 2, frenzies: 0, sizeCenti: 123, ending: 1, cause: 0,
    seed: seedToBytes32(ticket.seed), traceHash: traceHash(commands, endTick), snapshotHash: ticket.snapshotHash, deadline: BigInt(NOW + 1200),
    ...patch,
  };
  const json = resultToJson(result);
  return { result, resultJson: json, verifierSignature: SIG, typedData: JSON.parse(canonical(resultTypedData(result, CONTRACT, CHAIN_ID))) };
}

function memoryStore(initial = null) {
  let value = initial;
  return { read: () => value, write: (v) => { value = v; }, get value() { return value; } };
}

/** Happy-path fakes; each test overrides what it breaks. */
function fakeDeps(overrides = {}) {
  const calls = [];
  const record = (name, fn) => async (...args) => { calls.push(name); return fn(...args); };
  const deps = {
    connect: record("connect", async () => PLAYER),
    ensureChain: record("ensureChain", async () => {}),
    attest: record("attest", async (request) => { assert.equal(request.player, PLAYER); assert.equal(request.runId, ticket.runId); return attestation(); }),
    sign: record("sign", async (typedData) => { assert.equal(typedData.primaryType, "RunResult"); return SIG; }),
    send: record("send", async () => TX),
    waitForReceipt: record("waitForReceipt", async (txHash, runId) => { assert.equal(runId, ticket.runId); return { status: "success", blockNumber: 1234n, txHash, recorded: { epoch: 12n, player: PLAYER, fedPile: true } }; }),
    bestScore: record("bestScore", async () => 12_345n),
    usedRunId: record("usedRunId", async () => false),
    store: memoryStore(),
    now: () => NOW,
    receiptTimeoutMs: 50,
    ...overrides,
  };
  return { deps, calls };
}

async function drive(deps, extra = {}) {
  const states = [];
  const controller = new AbortController();
  const final = await runLedger({ input, deps, emit: (s) => states.push(s), signal: controller.signal, ...extra });
  return { states, final, statuses: states.map((s) => s.status) };
}

test("the reducer walks the happy path and ignores events that do not apply", () => {
  let s = READY;
  s = reduce(s, { type: "start" }); assert.equal(s.status, "connecting");
  s = reduce(s, { type: "attested", result: {} }); assert.equal(s.status, "connecting", "attested before connected is ignored");
  s = reduce(s, { type: "connected", player: PLAYER }); assert.equal(s.status, "attesting");
  s = reduce(s, { type: "attested", result: { score: 1n } }); assert.equal(s.status, "signing"); assert.equal(s.player, PLAYER);
  s = reduce(s, { type: "signed" }); assert.equal(s.status, "sending");
  s = reduce(s, { type: "sent", txHash: TX }); assert.equal(s.status, "confirming"); assert.equal(s.stalled, false);
  assert.deepEqual(s.result, { score: 1n }, "the result rides along to the report's pile line");
  s = reduce(s, { type: "stalled" }); assert.equal(s.stalled, true);
  s = reduce(s, { type: "filed", blockNumber: 9n, best: 1n, epoch: 3n, fedPile: true }); assert.equal(s.status, "filed"); assert.equal(s.txHash, TX); assert.equal(s.epoch, 3n); assert.equal(s.fedPile, true);
  assert.deepEqual(s.result, { score: 1n });
  assert.equal(reduce(s, { type: "failed", failure: {} }), s, "a filed shift cannot fail");
  assert.equal(reduce(OFF_PRACTICE, { type: "start" }), OFF_PRACTICE, "practice never starts");
  // Already on the chain (DuplicateRun + usedRunIds): filed from sending, with no transaction and no block of its own.
  const already = reduce({ status: "sending", player: PLAYER, result: { score: 2n } }, { type: "already", best: 7n });
  assert.deepEqual(already, { status: "filed", player: PLAYER, txHash: null, blockNumber: null, best: 7n, result: { score: 2n }, epoch: null, fedPile: null });
  // And from confirming: a replaced transaction mined without the event while another filing landed the run.
  const fromConfirming = reduce({ status: "confirming", player: PLAYER, txHash: TX, stalled: false, result: null }, { type: "already", best: 7n });
  assert.deepEqual(fromConfirming, { status: "filed", player: PLAYER, txHash: null, blockNumber: null, best: 7n, result: null, epoch: null, fedPile: null });
  assert.equal(reduce({ status: "signing", player: PLAYER, result: {} }, { type: "already", best: 7n }).status, "signing", "not from anywhere else");
  // Cancel only before the transaction is out.
  assert.ok(isCancellable({ status: "signing", player: PLAYER, result: {} }));
  assert.ok(!isCancellable({ status: "sending", player: PLAYER, result: {} }));
  assert.equal(reduce({ status: "attesting", player: PLAYER }, { type: "cancel" }).status, "ready");
  assert.equal(reduce({ status: "sending", player: PLAYER, result: {} }, { type: "cancel" }).status, "sending");
  // Retry and skip from failed; retry from a stalled confirmation.
  const failed = reduce({ status: "signing", player: PLAYER, result: {} }, { type: "failed", failure: { code: "rejected" } });
  assert.equal(failed.status, "failed");
  assert.equal(reduce(failed, { type: "retry" }).status, "ready");
  assert.deepEqual(reduce(failed, { type: "skip" }), { status: "off", reason: "skipped" });
  assert.equal(reduce({ status: "confirming", player: PLAYER, txHash: TX, stalled: true }, { type: "retry" }).status, "ready");
  assert.equal(reduce({ status: "confirming", player: PLAYER, txHash: TX, stalled: false }, { type: "retry" }).status, "confirming");
  const resumed = reduce(READY, { type: "resume", txHash: TX, player: null });
  assert.equal(resumed.status, "confirming");
  assert.equal(resumed.result, null, "a resumed filing has no numbers to show");
});

test("happy path: connect, attest, sign what was rebuilt, send, confirm, read the best", async () => {
  const { deps, calls } = fakeDeps();
  const { statuses, final } = await drive(deps);
  assert.deepEqual(statuses, ["connecting", "attesting", "signing", "sending", "confirming", "filed"]);
  assert.deepEqual(calls, ["connect", "ensureChain", "attest", "sign", "send", "waitForReceipt", "bestScore"]);
  assert.equal(final.status, "filed");
  assert.equal(final.txHash, TX);
  assert.equal(final.blockNumber, 1234n);
  assert.equal(final.best, 12_345n);
  assert.deepEqual([final.result.btcFed, final.result.ethFed, final.result.hemiFed], [1, 0, 1], "the filed state carries the verified result for the pile line");
  assert.equal(final.epoch, 12n, "the pile's epoch is the event's — the epoch the contract credited, not the ticket's");
  assert.equal(final.fedPile, true, "the receipt carried PileFed");
  assert.equal(deps.store.value.status, "filed");
  assert.equal(deps.store.value.blockNumber, "1234");
});

test("a filing past the wallet's three for the epoch is FILED with fedPile false, and the report says so", async () => {
  const { deps } = fakeDeps({ waitForReceipt: async (txHash) => ({ status: "success", blockNumber: 1300n, txHash, recorded: { epoch: 12n, player: PLAYER, fedPile: false } }) });
  const { final } = await drive(deps);
  assert.equal(final.status, "filed");
  assert.equal(final.epoch, 12n);
  assert.equal(final.fedPile, false);
  assert.equal(LEDGER.lines.pileFull("12"), "Epoch 12’s pile takes three shifts a wallet; yours are in. This one counts for the board.");
  assert.equal(LEDGER.lines.pileUnknownEpoch(21, 23, 21), "This shift: 21 BTC · 23 ETH · 21 HEMI.", "no receipt of ours: no pile is claimed");
});

test("recordedIn reads ResultRecorded and PileFed for this run only", () => {
  const CONTRACT = "0x" + "c0".repeat(20);
  const RUN = "0x" + "aa".repeat(32);
  const OTHER_RUN = "0x" + "bb".repeat(32);
  const recordedLog = (runId) => ({ address: CONTRACT, topics: encodeEventTopics({ abi: feedRegistryAbi, eventName: "ResultRecorded", args: { runId, player: PLAYER, gameVersion: "0x" + "00".repeat(32) } }),
    data: encodeAbiParameters(getAbiItem({ abi: feedRegistryAbi, name: "ResultRecorded" }).inputs.filter((i) => !i.indexed), [1n, 600, 1, 2, 3, 1, 0, 100, 0, 0, 12n, "0x" + "00".repeat(32), "0x" + "11".repeat(32)]) });
  const fedLog = (runId) => ({ address: CONTRACT, topics: encodeEventTopics({ abi: feedRegistryAbi, eventName: "PileFed", args: { runId, player: PLAYER, epoch: 12n } }),
    data: encodeAbiParameters(getAbiItem({ abi: feedRegistryAbi, name: "PileFed" }).inputs.filter((i) => !i.indexed), [1, 2, 3]) });
  assert.deepEqual(recordedIn([recordedLog(RUN), fedLog(RUN)], CONTRACT, RUN), { epoch: 12n, player: PLAYER, fedPile: true });
  assert.deepEqual(recordedIn([recordedLog(RUN)], CONTRACT, RUN), { epoch: 12n, player: PLAYER, fedPile: false });
  assert.deepEqual(recordedIn([recordedLog(RUN), fedLog(OTHER_RUN)], CONTRACT, RUN), { epoch: 12n, player: PLAYER, fedPile: false }, "another run's PileFed is not ours");
  assert.equal(recordedIn([fedLog(RUN)], CONTRACT, RUN), null, "PileFed without ResultRecorded is not a filing");
  assert.equal(recordedIn([{ ...recordedLog(RUN), address: "0x" + "dd".repeat(20) }, fedLog(RUN)], CONTRACT, RUN), null, "another contract's event is not ours");
});

test("a mined transaction that did not file the shift (replaced or cancelled in the wallet) is not FILED", async () => {
  // viem follows a replacement: a cancel mines under the same nonce with status success and no ResultRecorded.
  const replaced = { status: "success", blockNumber: 1235n, txHash: "0x" + "ee".repeat(32), recorded: null };
  const { deps, calls } = fakeDeps({ waitForReceipt: async () => replaced });
  const { statuses, final } = await drive(deps);
  assert.deepEqual(statuses, ["connecting", "attesting", "signing", "sending", "confirming", "failed"]);
  assert.equal(final.failure.code, "replaced");
  assert.equal(final.failure.txHash, replaced.txHash, "the hash that mined, for the explorer");
  assert.ok(calls.includes("usedRunId"), "the contract was asked whether something else filed it");
  assert.equal(deps.store.value, null, "nothing remembered as filed or pending; Retry sends a fresh transaction");
  // Something else did file it meanwhile (a second tab): confirmed by usedRunIds, FILED without a transaction of its own.
  const elsewhere = fakeDeps({ waitForReceipt: async () => replaced, usedRunId: async () => true });
  const other = await drive(elsewhere.deps);
  assert.equal(other.final.status, "filed");
  assert.equal(other.final.txHash, null);
  assert.equal(other.final.blockNumber, null);
  assert.equal(other.final.epoch, null, "no event in hand: the pile line names no epoch");
  assert.equal(other.final.best, 12_345n);
  // The lookup failing leaves the honest answer: not filed.
  const down = fakeDeps({ waitForReceipt: async () => replaced, usedRunId: async () => { throw new Error("rpc down"); } });
  assert.equal((await drive(down.deps)).final.failure.code, "replaced");
});

test("the wallet signs the typed data the client rebuilt, never the server's object", async () => {
  let signed = null;
  const { deps } = fakeDeps({ sign: async (typedData) => { signed = typedData; return SIG; } });
  await drive(deps);
  const expected = resultTypedData(attestation().result, CONTRACT, CHAIN_ID);
  assert.equal(canonical(signed), canonical(expected));
  assert.equal(signed.domain.chainId, CHAIN_ID);
  assert.equal(signed.domain.verifyingContract, CONTRACT);
  assert.equal(typeof signed.message.score, "bigint", "bigints stay bigints on the way to the wallet");
});

test("a verifier answer that does not match the shift is never signed", async () => {
  const cases = [
    ["player", attestation({}, OTHER)],
    ["runId", attestation({ runId: `0x${"99".repeat(32)}` })],
    ["seed", attestation({ seed: seedToBytes32(1) })],
    ["traceHash", attestation({ traceHash: `0x${"00".repeat(32)}` })],
    ["durationTicks", attestation({ durationTicks: endTick + 1 })],
    ["snapshotHash", attestation({ snapshotHash: `0x${"01".repeat(32)}` })],
    ["gameVersion", attestation({ gameVersion: `0x${"02".repeat(32)}` })],
    ["totalFeeds", attestation({ totalFeeds: 9 })],
  ];
  for (const [field, response] of cases) {
    assert.throws(() => verifyAttestation(response, input, PLAYER, NOW), (e) => e.code === "mismatch" && e.field === field && e.message === `mismatch:${field}`, field);
    const { deps, calls } = fakeDeps({ attest: async () => response });
    const { statuses, final } = await drive(deps);
    assert.deepEqual(statuses, ["connecting", "attesting", "failed"], field);
    assert.equal(final.failure.code, "mismatch");
    assert.equal(final.failure.at, "attesting");
    assert.equal(final.failure.detail, `mismatch:${field}`);
    assert.ok(!calls.includes("sign"), `${field}: nothing was signed`);
  }
  // The server's own typed data, when sent, must be byte-for-byte the client's.
  const tampered = attestation();
  tampered.typedData.domain.verifyingContract = OTHER;
  assert.throws(() => verifyAttestation(tampered, input, PLAYER, NOW), (e) => e.message === "mismatch:typedData");
  // And when the server sends none, the client's rebuild stands on its own.
  const bare = attestation(); bare.typedData = null;
  assert.equal(verifyAttestation(bare, input, PLAYER, NOW).primaryType, "RunResult");
  // The Worker's own shape (worker/chain.ts attestResponse): the v4 envelope's EIP712Domain in `types`, the message as decimal strings.
  const worker = attestation();
  const typed = resultTypedData(worker.result, CONTRACT, CHAIN_ID);
  worker.typedData = {
    domain: typed.domain,
    types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...typed.types },
    primaryType: typed.primaryType, message: resultToJson(worker.result),
  };
  assert.equal(verifyAttestation(worker, input, PLAYER, NOW).primaryType, "RunResult");
});

test("M2: the numbers the report showed are the numbers that get signed — each field tampered is a mismatch, nothing signed", async () => {
  // Identity fields intact, one number changed at a time. A diet field is changed with the total it sums to, so the sum
  // check is not what trips; `totalFeeds` on its own is the sum check, in the test above.
  const cases = [
    ["score", attestation({ score: 4_201n })],
    ["btcFed", attestation({ btcFed: 2, totalFeeds: 3 })],
    ["ethFed", attestation({ ethFed: 1, totalFeeds: 3 })],
    ["hemiFed", attestation({ hemiFed: 2, totalFeeds: 3 })],
    ["bestCombo", attestation({ bestCombo: 3 })],
    ["frenzies", attestation({ frenzies: 1 })],
    ["sizeCenti", attestation({ sizeCenti: 124 })],
    ["ending", attestation({ ending: 2 })],
    ["cause", attestation({ cause: 1 })],
  ];
  for (const [field, response] of cases) {
    assert.throws(() => verifyAttestation(response, input, PLAYER, NOW), (e) => e.code === "mismatch" && e.field === field, field);
    const { deps, calls } = fakeDeps({ attest: async () => response });
    const { statuses, final } = await drive(deps);
    assert.deepEqual(statuses, ["connecting", "attesting", "failed"], field);
    assert.equal(final.failure.code, "mismatch");
    assert.equal(final.failure.detail, `mismatch:${field}`);
    assert.ok(!calls.includes("sign") && !calls.includes("send"), `${field}: nothing was signed or sent`);
  }
  // A total that disagrees with the page's while still summing the diet (a fourth coin's worth from nowhere) is caught too.
  assert.throws(() => verifyAttestation(attestation({ totalFeeds: 3, btcFed: 2 }), { ...input, played: { ...played, btcFed: 2 } }, PLAYER, NOW), (e) => e.field === "totalFeeds");
  // The honest answer still passes with the same page state, and the reason is plain.
  assert.equal(verifyAttestation(attestation(), input, PLAYER, NOW).primaryType, "RunResult");
  assert.equal(LEDGER.reasons.mismatch, "The verifier’s numbers do not match this shift. Nothing was signed.");
  // playedNumbers maps the page's state the way the verifier does (docs/CHAIN.md §4).
  assert.deepEqual(played, { score: 4_200n, totalFeeds: 2, btcFed: 1, ethFed: 0, hemiFed: 1, bestCombo: 2, frenzies: 0, sizeCenti: 123, ending: 1, cause: 0 });
  assert.equal(playedNumbers({ ...finalState, failureReason: "outgrew-the-kitchen" }).cause, 2);
  assert.equal(playedNumbers({ ...finalState, failureReason: null }).cause, -1, "a shift that has not ended matches no cause");
  assert.equal(playedNumbers({ ...finalState, size: 2.406 }).sizeCenti, 241);
});

test("I5: the deadline is judged against the clock when the answer arrived, and a bad one blames the clock, not the verifier", async () => {
  // Out of the window either way: a 'clock' failure, with the field in the detail.
  for (const deadline of [BigInt(NOW + 3 * 3600), BigInt(NOW - 120)]) {
    const response = attestation({ deadline });
    assert.throws(() => verifyAttestation(response, input, PLAYER, NOW), (e) => e.code === "clock" && e.field === "deadline" && e.message === "clock:deadline");
    const { deps, calls } = fakeDeps({ attest: async () => response });
    const { statuses, final } = await drive(deps);
    assert.deepEqual(statuses, ["connecting", "attesting", "failed"]);
    assert.equal(final.failure.code, "clock");
    assert.ok(!calls.includes("sign"));
  }
  assert.match(LEDGER.reasons.clock, /clock looks off/);
  assert.doesNotMatch(LEDGER.reasons.clock, /mismatch/i);
  // The slack: a deadline inside the window with 60 s of grace passes.
  assert.equal(verifyAttestation(attestation({ deadline: BigInt(NOW + 30 * 60 + 59) }), input, PLAYER, NOW).primaryType, "RunResult");
  assert.equal(verifyAttestation(attestation({ deadline: BigInt(NOW - 59) }), input, PLAYER, NOW).primaryType, "RunResult");
  // The driver reads the clock once, when the answer arrives: a clock that jumps afterwards does not fail an honest answer.
  let clock = NOW;
  const { deps, calls } = fakeDeps({ now: () => { const t = clock; clock += 2 * 3600; return t; } });
  const { final } = await drive(deps);
  assert.equal(final.status, "filed", "later reads of the clock (the store's sentAt) do not re-judge the deadline");
  assert.ok(calls.includes("sign"));
});

test("the player rejects the signature: failed at signing, retry goes round again", async () => {
  const rejection = Object.assign(new Error("User rejected the request."), { code: "rejected" });
  const { deps, calls } = fakeDeps({ sign: async () => { throw rejection; } });
  const { statuses, final } = await drive(deps);
  assert.deepEqual(statuses, ["connecting", "attesting", "signing", "failed"]);
  assert.equal(final.failure.code, "rejected");
  assert.equal(final.failure.at, "signing");
  assert.ok(!calls.includes("send"));
  assert.equal(deps.store.value, null, "nothing was sent, nothing is remembered");
  assert.equal(reduce(final, { type: "retry" }).status, "ready");
});

test("attest 409: the ticket was already attested with another trace", async () => {
  const { deps } = fakeDeps({ attest: async () => { throw new ChainApiError("payload_conflict", "Ticket already attested", 409); } });
  const { statuses, final } = await drive(deps);
  assert.deepEqual(statuses, ["connecting", "attesting", "failed"]);
  assert.equal(final.failure.code, "payload_conflict");
  assert.equal(typeof LEDGER.reasons.payload_conflict, "string");
  // Every Worker code and wallet code has a plain line.
  for (const code of ["disabled", "rate_limited", "bad_request", "unknown_ticket", "expired_ticket", "invalid_trace", "run_not_over", "payload_conflict", "out_of_bounds", "unavailable", "timeout", "network", "bad_response", "no_wallet", "rejected", "wrong_chain", "insufficient_funds", "reverted", "reverted_onchain", "mismatch", "clock", "unknown"]) {
    assert.ok(code in LEDGER.reasons, `a reason for ${code}`);
  }
  assert.equal(LEDGER.reasons.out_of_bounds, "The verifier refused this shift’s numbers.");
  const bounds = fakeDeps({ attest: async () => { throw new ChainApiError("out_of_bounds", "score", 422); } });
  assert.equal((await drive(bounds.deps)).final.failure.code, "out_of_bounds");
});

test("the wallet refuses to switch chains: failed at connecting, nothing attested", async () => {
  const refusal = Object.assign(new Error("The wallet stayed on another chain"), { code: "wrong_chain" });
  const { deps, calls } = fakeDeps({ ensureChain: async () => { throw refusal; } });
  const { statuses, final } = await drive(deps);
  assert.deepEqual(statuses, ["connecting", "failed"]);
  assert.equal(final.failure.code, "wrong_chain");
  assert.equal(final.failure.at, "connecting");
  assert.deepEqual(calls, ["connect"], "the override is not recorded; nothing after it ran");
  assert.equal(LEDGER.reasons.wrong_chain("Hemi"), "Your wallet is on another chain. Switch to Hemi and retry.");
});

test("the contract refuses it: the decoded custom error rides along", async () => {
  const revert = Object.assign(new Error("InvalidSignature()"), { code: "reverted", revert: "InvalidSignature" });
  const { deps, calls } = fakeDeps({ send: async () => { throw revert; } });
  const { statuses, final } = await drive(deps);
  assert.deepEqual(statuses, ["connecting", "attesting", "signing", "sending", "failed"]);
  assert.equal(final.failure.code, "reverted");
  assert.equal(final.failure.revert, "InvalidSignature");
  assert.ok(!calls.includes("usedRunId"), "only a DuplicateRun asks the contract whether the shift is already there");
  assert.equal(LEDGER.reverts.DuplicateRun, "This shift was already filed.");
});

test("DuplicateRun: when usedRunIds agrees, the shift is filed — no transaction, no block, the best read; otherwise the refusal stands", async () => {
  const duplicate = () => Object.assign(new Error("DuplicateRun()"), { code: "reverted", revert: "DuplicateRun" });
  // Already on the chain (another tab, a relayer, a retry after a lost receipt).
  let asked = null;
  const { deps, calls } = fakeDeps({ send: async () => { throw duplicate(); }, usedRunId: async (runId) => { asked = runId; return true; } });
  const { statuses, final } = await drive(deps);
  assert.deepEqual(statuses, ["connecting", "attesting", "signing", "sending", "filed"]);
  assert.equal(asked, ticket.runId, "the contract is asked about this shift's run id");
  assert.deepEqual(calls, ["connect", "ensureChain", "attest", "sign", "bestScore"], "(overrides are not recorded) no receipt is waited for: there is no transaction of ours");
  assert.equal(final.txHash, null);
  assert.equal(final.blockNumber, null);
  assert.equal(final.best, 12_345n);
  assert.equal(final.player, PLAYER);
  assert.equal(final.result.btcFed, 1, "the attested result stays for the pile line");
  assert.equal(deps.store.value, null, "no transaction of ours to remember");
  assert.equal(LEDGER.lines.already("Hemi"), "This shift was already on Hemi.");
  assert.equal(LEDGER.lines.alreadyLink("Hemi"), "This shift was already on Hemi ↗");
  // The contract does not know the run after all (a stale simulation): the refusal is shown and Retry stays.
  const not = fakeDeps({ send: async () => { throw duplicate(); }, usedRunId: async () => false });
  const again = await drive(not.deps);
  assert.deepEqual(again.statuses, ["connecting", "attesting", "signing", "sending", "failed"]);
  assert.equal(again.final.failure.revert, "DuplicateRun");
  // The lookup itself fails: the refusal is still the reason, not the lookup.
  const down = fakeDeps({ send: async () => { throw duplicate(); }, usedRunId: async () => { throw new Error("rpc down"); } });
  const third = await drive(down.deps);
  assert.equal(third.final.status, "failed");
  assert.equal(third.final.failure.revert, "DuplicateRun");
  // A best that cannot be read does not unfile it.
  const quiet = fakeDeps({ send: async () => { throw duplicate(); }, usedRunId: async () => true, bestScore: async () => { throw new Error("rpc down"); } });
  const fourth = await drive(quiet.deps);
  assert.equal(fourth.final.status, "filed");
  assert.equal(fourth.final.best, null);
});

test("the receipt says reverted: failed with the transaction for the explorer, remembered as reverted", async () => {
  const { deps } = fakeDeps({ waitForReceipt: async (txHash) => ({ status: "reverted", blockNumber: 77n, txHash, recorded: null }) });
  const { statuses, final } = await drive(deps);
  assert.deepEqual(statuses, ["connecting", "attesting", "signing", "sending", "confirming", "failed"]);
  assert.equal(final.failure.code, "reverted_onchain");
  assert.equal(final.failure.txHash, TX);
  assert.equal(deps.store.value.status, "reverted");
});

test("no receipt inside the cap: still pending, the transaction stays remembered", async () => {
  const { deps, calls } = fakeDeps({ waitForReceipt: async () => null });
  const { statuses, final } = await drive(deps);
  assert.deepEqual(statuses, ["connecting", "attesting", "signing", "sending", "confirming", "confirming"]);
  assert.equal(final.status, "confirming");
  assert.equal(final.stalled, true);
  assert.ok(!calls.includes("bestScore"));
  assert.deepEqual(deps.store.value, { runId: ticket.runId, txHash: TX, player: PLAYER, status: "pending", blockNumber: null, sentAt: NOW });
});

test("resume from a remembered transaction goes straight to confirming, then filed", async () => {
  const { deps, calls } = fakeDeps({ store: memoryStore({ runId: ticket.runId, txHash: TX, player: PLAYER, status: "pending", blockNumber: null, sentAt: NOW - 30 }) });
  const { statuses, final } = await drive(deps, { resume: { txHash: TX, player: PLAYER } });
  assert.deepEqual(statuses, ["confirming", "filed"]);
  assert.deepEqual(calls, ["waitForReceipt", "bestScore"], "no wallet, no verifier: the transaction is already out");
  assert.equal(final.blockNumber, 1234n);
  assert.equal(final.result, null, "the numbers are not remembered, so the pile line is not shown");
  assert.equal(deps.store.value.status, "filed");
  // A best that cannot be read does not unfile anything.
  const quiet = fakeDeps({ bestScore: async () => { throw new Error("rpc down"); } });
  const again = await drive(quiet.deps, { resume: { txHash: TX, player: PLAYER } });
  assert.equal(again.final.status, "filed");
  assert.equal(again.final.best, null);
});

test("cancelling between steps stops without another state", async () => {
  const controller = new AbortController();
  const { deps, calls } = fakeDeps({ attest: async () => { controller.abort(); return attestation(); } });
  const states = [];
  const final = await runLedger({ input, deps, emit: (s) => states.push(s), signal: controller.signal });
  assert.deepEqual(states.map((s) => s.status), ["connecting", "attesting"]);
  assert.equal(final.status, "attesting", "it stopped where it was");
  assert.ok(!calls.includes("sign"));
});

test("failures classify: API codes pass through, wallet codes pass through, anything else is unknown", () => {
  assert.equal(toFailure(new ChainApiError("expired_ticket", "x", 410), "attesting").code, "expired_ticket");
  assert.equal(toFailure(Object.assign(new Error("y"), { code: "insufficient_funds" }), "sending").code, "insufficient_funds");
  assert.equal(toFailure(Object.assign(new Error("z"), { code: "clock" }), "attesting").code, "clock");
  assert.equal(toFailure(new TypeError("boom"), "sending").code, "unknown");
  assert.equal(toFailure(Object.assign(new Error("z"), { code: 4001 }), "signing").code, "unknown", "a raw provider code is classified by wallet.ts, not here");
});

test("the filing store survives a bad or missing sessionStorage, and drops a record whose hashes are not hashes (I4)", () => {
  let bucket = {};
  const storage = { getItem: (k) => bucket[k] ?? null, setItem: (k, v) => { bucket[k] = v; }, removeItem: (k) => { delete bucket[k]; } };
  const store = sessionFilingStore(storage);
  assert.equal(store.read(), null);
  store.write({ runId: ticket.runId, txHash: TX, player: PLAYER, status: "pending", blockNumber: null, sentAt: NOW });
  assert.equal(store.read().txHash, TX);
  assert.equal(store.read().player, PLAYER);
  bucket = { "dnfi-ledger-filing": "{not json" };
  assert.equal(store.read(), null);
  // Tampered or truncated records never reach the RPC or an explorer link.
  const put = (record) => { bucket = { "dnfi-ledger-filing": JSON.stringify(record) }; return store.read(); };
  const good = { runId: ticket.runId, txHash: TX, player: PLAYER, status: "filed", blockNumber: "12", sentAt: NOW };
  assert.equal(put(good).blockNumber, "12");
  assert.equal(put({ ...good, txHash: "javascript:alert(1)" }), null);
  assert.equal(put({ ...good, txHash: `0x${"cd".repeat(31)}` }), null, "63 bytes is not a hash");
  assert.equal(put({ ...good, txHash: `${TX}00` }), null);
  assert.equal(put({ ...good, runId: "run-1" }), null);
  assert.equal(put({ ...good, runId: 7 }), null);
  assert.equal(put({ ...good, player: "0xnotanaddress" }).player, null, "a bad player is dropped, the filing kept");
  assert.equal(put({ ...good, blockNumber: "12abc" }).blockNumber, null);
  assert.equal(put({ ...good, txHash: TX.toUpperCase().replace("0X", "0x") }).txHash, TX.toUpperCase().replace("0X", "0x"), "case does not matter");
  store.write(null);
  assert.equal(store.read(), null);
  const none = sessionFilingStore(null);
  none.write({ runId: ticket.runId, txHash: TX, player: null, status: "pending", blockNumber: null, sentAt: NOW });
  assert.equal(none.read(), null);
});

test("the API decoders take the Worker's shapes and fall back to Hemi's constants", () => {
  const config = decodeConfig({ enabled: true, chainId: 31337, contractAddress: CONTRACT, rpcUrl: "http://127.0.0.1:8545", explorerUrl: "http://explorer.local/", gameVersion: 5, gameVersionId: GAME_VERSION_ID, epochSeconds: 86400, ticketSeconds: 2400 });
  assert.equal(config.enabled, true);
  assert.equal(config.explorerUrl, "http://explorer.local");
  const chain = chainFromConfig(config);
  assert.equal(chain.id, 31337);
  assert.equal(chain.label, "Hardhat");
  assert.equal(addressUrl(chain, CONTRACT), `http://explorer.local/address/${CONTRACT}`);
  const scaffold = decodeConfig({ chainId: 43111, enabled: false, mode: "scaffold", reason: "off" });
  assert.equal(scaffold.enabled, false);
  assert.equal(scaffold.ticketSeconds, 2400);
  const hemi = chainFromConfig(scaffold);
  assert.equal(hemi.label, "Hemi");
  assert.equal(hemi.rpcUrl, "https://rpc.hemi.network/rpc");
  assert.equal(hemi.explorerUrl, "https://explorer.hemi.xyz");
  // Enabled without a contract address is not enabled.
  assert.equal(decodeConfig({ enabled: true, chainId: 43111 }).enabled, false);
  // Off Hemi the Worker sends `explorerUrl: null` (e2e finding 1): no explorer, so no links — and no fallback to Hemi's.
  const local = chainFromConfig(decodeConfig({ enabled: true, chainId: 31337, contractAddress: CONTRACT, rpcUrl: "http://127.0.0.1:8545", explorerUrl: null }));
  assert.equal(local.explorerUrl, null);
  assert.equal(txUrl(local, TX), null);
  assert.equal(addressUrl(local, CONTRACT), null);
  assert.equal(txUrl(hemi, TX), `https://explorer.hemi.xyz/tx/${TX}`);

  const t = decodeTicket({ runId: ticket.runId, seed: 123, issuedAt: NOW, expiresAt: NOW + 2400, epoch: "3", snapshotHash: ticket.snapshotHash, sourceEpoch: 2, inherited: 1, snapshot: { btc: "10", eth: 2, hemi: "0", runs: "1", dominant: 1 } });
  assert.equal(t.epoch, 3);
  assert.equal(t.snapshot.btc, 10n);
  assert.equal(t.sourceEpoch, 2);
  assert.equal(t.inherited, 1);
  // Stage 2's fields are lenient: missing means nothing inherited (an older Worker), as do junk values.
  const bare = decodeTicket({ runId: ticket.runId, seed: 123, issuedAt: NOW, expiresAt: NOW + 2400, epoch: 3, snapshotHash: ticket.snapshotHash });
  assert.equal(bare.sourceEpoch, null);
  assert.equal(bare.inherited, 0);
  assert.equal(decodeTicket({ ...bare, snapshotHash: ticket.snapshotHash, sourceEpoch: "11", inherited: "3" }).inherited, 3);
  assert.equal(decodeTicket({ ...bare, snapshotHash: ticket.snapshotHash, sourceEpoch: -1, inherited: 9 }).inherited, 0);
  assert.equal(decodeTicket({ ...bare, snapshotHash: ticket.snapshotHash, sourceEpoch: -1, inherited: 9 }).sourceEpoch, null);
  // L6: a spare ticket is reused only while under five minutes old.
  assert.equal(TICKET_REUSE_SECONDS, 5 * 60);
  assert.ok(ticketIsFresh(t, NOW + 4 * 60 + 59));
  assert.ok(!ticketIsFresh(t, NOW + 5 * 60));
  assert.throws(() => decodeTicket({ runId: ticket.runId, seed: 2 ** 32, issuedAt: NOW, expiresAt: NOW, snapshotHash: ticket.snapshotHash }), (e) => e.code === "bad_response");

  const a = decodeAttest({ result: attestation().resultJson, verifierSignature: SIG, typedData: { domain: {} } });
  assert.equal(a.result.score, 4200n);
  assert.throws(() => decodeAttest({ result: { ...attestation().resultJson, score: "-1" }, verifierSignature: SIG }), (e) => e.code === "bad_response");
  assert.throws(() => decodeAttest({ result: attestation().resultJson, verifierSignature: "0x12" }), (e) => e.code === "bad_response");

  const w = decodeWorld({
    gameVersionId: GAME_VERSION_ID, epoch: 3, epochSeconds: 86400,
    pile: { current: { btc: "5", eth: "3", hemi: "2", runs: "4" }, previous: { btc: 1, eth: 1, hemi: 1, runs: 1 }, allTime: {} },
    top: [{ player: PLAYER, score: "9000", durationTicks: 3600, btcFed: 1, ethFed: 2, hemiFed: 3, bestCombo: 4, sizeCenti: 150, ending: 2, epoch: 3 }, { player: "nope" }],
    inherited: 2, sourceEpoch: 2,
    updatedAt: NOW, stale: true,
  });
  assert.equal(w.top.length, 1, "a malformed row is dropped, not fatal");
  assert.equal(w.top[0].score, 9000n);
  assert.equal(w.pile.current.runs, 4n);
  assert.equal(w.pile.allTime.btc, 0n);
  assert.equal(w.stale, true);
  assert.equal(w.inherited, 2);
  assert.equal(w.sourceEpoch, 2);
  const older = decodeWorld({ epoch: 3, pile: {}, top: [], updatedAt: NOW });
  assert.equal(older.inherited, 0);
  assert.equal(older.sourceEpoch, null);
  assert.deepEqual(older.epochs, [], "an older Worker without the ledger's epochs decodes to none");
  assert.equal(older.genesis, null);
  assert.equal(w.top[0].runId, null, "a row without a run id has no trace link");
});

test("the world's epochs decode leniently for the ledger page: piles, the trait handed down, per-epoch boards, run ids", () => {
  const RUN = `0x${"ab".repeat(32)}`;
  const w = decodeWorld({
    epoch: 4, epochSeconds: 86400, genesis: 1_760_000_000, pile: {}, top: [], updatedAt: NOW,
    epochs: [
      { epoch: 4, btc: "7", eth: 2, hemi: 1, runs: 3, dominant: 1, sourceEpoch: 2, inherited: 3, top: [{ player: PLAYER, score: "1200", durationTicks: 600, epoch: 4, runId: RUN, txHash: "0x12" }] },
      { epoch: 2, btc: 0, eth: 0, hemi: 9, runs: 1, dominant: 3, sourceEpoch: null, inherited: null, top: [] },
      { epoch: -1, btc: 1 },
      { epoch: 1.5 },
      "nope",
      { epoch: 1, dominant: 9, inherited: "x", top: "nope" },
    ],
  });
  assert.equal(w.genesis, 1_760_000_000);
  assert.deepEqual(w.epochs.map((e) => e.epoch), [4, 2, 1], "a negative, fractional or non-object epoch is dropped");
  const [now, quiet, odd] = w.epochs;
  assert.deepEqual(now.pile, { btc: 7n, eth: 2n, hemi: 1n, runs: 3n });
  assert.equal(now.dominant, 1);
  assert.equal(now.inherited, 3);
  assert.equal(now.sourceEpoch, 2);
  assert.equal(now.top[0].runId, RUN);
  assert.equal(now.top[0].txHash, null, "a malformed transaction hash is no link, not a broken one");
  assert.equal(quiet.inherited, null, "unknown inheritance stays unknown (the page shows —), never \"nothing\"");
  assert.equal(odd.dominant, 0);
  assert.equal(odd.inherited, 0);
  assert.deepEqual(odd.top, []);
});

test("the ledger page's arithmetic: shares add up to 100, ties go to the earlier coin, dates, the board that opens", () => {
  const pct = (btc, eth, hemi) => sharesOf({ btc, eth, hemi }).map((s) => s.percent);
  assert.deepEqual(pct(0n, 0n, 0n), [0, 0, 0]);
  assert.deepEqual(pct(1n, 1n, 1n), [34, 33, 33], "a three-way tie: the extra point goes to BTC, as the contract's dominant does");
  assert.deepEqual(pct(0n, 1n, 1n), [0, 50, 50]);
  assert.deepEqual(pct(412n, 380n, 151n), [44, 40, 16]);
  for (const [a, b, c] of [[1n, 2n, 3n], [7n, 0n, 0n], [999n, 1n, 1n], [10n ** 20n, 3n, 10n ** 19n], [5n, 5n, 1n]]) {
    const shares = sharesOf({ btc: a, eth: b, hemi: c });
    assert.equal(shares.reduce((sum, s) => sum + s.percent, 0), 100, `${a}/${b}/${c}`);
    assert.deepEqual(shares.map((s) => s.count), [a, b, c]);
  }
  assert.deepEqual(sharesOf({ btc: 1n, eth: 2n, hemi: 3n }).map((s) => [s.coin, s.ingredient]), [["btc", "metal"], ["eth", "balloon"], ["hemi", "pepper"]]);

  assert.equal(traitOf(null), null);
  assert.equal(traitOf(0), null);
  assert.deepEqual([1, 2, 3].map(traitOf), ["metal", "balloon", "pepper"]);
  assert.equal(TOKEN_TRAITS[traitOf(1)], "HODL jaws");

  assert.equal(epochSpan(null, 86400, 3), null, "no genesis yet: no dates");
  assert.equal(epochSpan(1000, 0, 3), null);
  assert.deepEqual(epochSpan(1000, 86400, 3), { from: 1000 + 3 * 86400, to: 1000 + 4 * 86400 });
  assert.equal(formatSpan(null), null);
  assert.equal(formatSpan({ from: Date.UTC(2026, 9, 22, 14, 5) / 1000, to: Date.UTC(2026, 9, 23, 14, 5) / 1000 }, "en-US", "UTC"), "Oct 22, 14:05 → Oct 23, 14:05");

  const epoch = (n, rows) => ({ epoch: n, pile: { btc: 0n, eth: 0n, hemi: 0n, runs: BigInt(rows) }, dominant: 0, inherited: 0, sourceEpoch: null, top: Array.from({ length: rows }, () => ({})) });
  assert.equal(defaultBoard([epoch(5, 2), epoch(4, 9)], 5), 5, "the current epoch opens when anyone filed in it");
  assert.equal(defaultBoard([epoch(5, 0), epoch(4, 9)], 5), "all", "a quiet current epoch opens all time, not an empty table");
  assert.equal(defaultBoard([], 5), "all");

  assert.equal(uptime(0), "0:00");
  assert.equal(uptime(59), "0:00");
  assert.equal(uptime(3 * 3600 + 40 * 60), "3:40");
  assert.equal(uptime(-5), "0:00");
});

test("the ledger's copy obeys the lore rules: captions uppercase with a full stop, no prices, no promises, plain actions", () => {
  for (const caption of Object.values(LEDGER.captions)) {
    assert.equal(caption, caption.toUpperCase(), caption);
    assert.ok(caption.endsWith("."), caption);
    assert.ok(caption.length <= 18, caption);
  }
  const flatten = (value) => (typeof value === "function" ? value("Hemi", "12,345", 3, 4) : typeof value === "string" ? value : Object.values(value).flatMap(flatten));
  const everything = [...flatten(LEDGER), ...flatten(LEDGER_PAGE), ...flatten(INHERITED.help), INHERITED.tag, ...Object.values(INHERITED.line("metal", 0.61)), ...Object.values(INHERITED.line("pepper", null))].join(" ");
  assert.doesNotMatch(everything, /\$|price|pump|dump|crash|rug|hack|exploit|scam|liquidat|treasury|foundation|bags|seed phrase|earn|reward|airdrop|claim|drain|audit|profit|free money/i);
  assert.doesNotMatch(everything, /\b(Rick|Max|Jeremy|Joshua|JCV|John|Marco|Alpha|Alex)\b/);
  assert.equal(LEDGER.button, "File this shift on Hemi");
  assert.equal(LEDGER.practice, "Practice shift. Not filed.");
  assert.deepEqual([LEDGER.actions.retry, LEDGER.actions.skip, LEDGER.actions.cancel], ["Retry", "Skip", "Cancel"]);
  assert.match(LEDGER.gas, /You pay the gas/);
  assert.equal(LEDGER.lines.confirming("Hemi"), "Pending on Hemi");
  assert.equal(LEDGER.lines.best("Hemi", "12,345"), "Your best on Hemi: 12,345");
  assert.equal(LEDGER.lines.explorer("Hemi"), "View on Hemi Explorer ↗");
  assert.equal(LEDGER.lines.pile("12", 21, 23, 21), "Filed into epoch 12’s pile: 21 BTC · 23 ETH · 21 HEMI.");
});

test("when the pile closes: sentence case after the diet line, caption voice without one", () => {
  assert.equal(INHERITED.closes(6 * 3600 + 12 * 60), "PILE CLOSES IN 6H 12M.");
  assert.equal(INHERITED.closes(6 * 3600 + 11 * 60 + 1), "PILE CLOSES IN 6H 12M.", "minutes round up");
  assert.equal(INHERITED.closes(2 * 3600), "PILE CLOSES IN 2H.");
  assert.equal(INHERITED.closes(59 * 60 + 30), "PILE CLOSES IN 1H.", "59:30 rounds up to the hour");
  assert.equal(INHERITED.closes(45), "PILE CLOSES IN 1M.");
  assert.equal(INHERITED.closes(0.2), "PILE CLOSES IN 1M.", "never 0M");
  for (let s = 1; s <= 86_400; s += 997) {
    const caption = INHERITED.closes(s);
    assert.equal(caption, caption.toUpperCase());
    assert.ok(caption.endsWith(".") && caption.length <= 30, caption);
  }
  assert.equal(INHERITED.closesAfterDiet(6 * 3600 + 12 * 60, "this epoch"), "The pile closes in 6h 12m.");
  assert.equal(INHERITED.closesAfterDiet(45, "last epoch"), "This epoch’s pile closes in 1m.", "after last epoch's line, say which pile");
  // The close is GENESIS + (epoch + 1) × EPOCH_SECONDS: the end of the ledger's span for the current epoch.
  assert.equal(epochSpan(1_000, 86_400, 3).to, 1_000 + 4 * 86_400);
  const words = [INHERITED.closes(100), INHERITED.closesAfterDiet(100, "this epoch"), INHERITED.closesAfterDiet(100, "last epoch")].join(" ");
  assert.doesNotMatch(words, /\$|price|pump|dump|crash|rug|hack|exploit|scam|earn|reward|airdrop|claim|profit/i);
});

test("the inherited trait's copy: two short captions for the title, the chip's tag, and a whitepaper step with no promises", () => {
  // The title's line: LAST EPOCH: 61% BTC. TONIGHT IT HAS HODL JAWS. — the trait names are the chips' own.
  assert.deepEqual(INHERITED.line("metal", 0.61), { last: "LAST EPOCH: 61% BTC.", tonight: "TONIGHT IT HAS HODL JAWS." });
  assert.deepEqual(INHERITED.line("balloon", 0.5), { last: "LAST EPOCH: 50% ETH.", tonight: "TONIGHT IT HAS GAS BELLY." });
  assert.deepEqual(INHERITED.line("pepper", 0.999), { last: "LAST EPOCH: 100% HEMI.", tonight: "TONIGHT IT HAS TURBO BREATH." });
  // No share known (the source epoch is not the previous one, so the client has no pile for it): only which coin was on top.
  assert.deepEqual(INHERITED.line("metal", null), { last: "LAST EPOCH: BTC ON TOP.", tonight: "TONIGHT IT HAS HODL JAWS." });
  assert.equal(INHERITED.line("metal", 2).last, "LAST EPOCH: 100% BTC.", "a share is clamped");
  for (const trait of Object.keys(TOKEN_TRAITS)) {
    for (const share of [0.34, 0.61, null]) {
      const { last, tonight } = INHERITED.line(trait, share);
      for (const caption of [last, tonight]) {
        assert.equal(caption, caption.toUpperCase(), caption);
        assert.ok(caption.endsWith("."), caption);
        assert.ok(caption.length <= 30, `"${caption}" is ${caption.length} characters`);
      }
      assert.ok(tonight.includes(TOKEN_TRAITS[trait].toUpperCase()), tonight);
    }
  }
  assert.ok(`${INHERITED.line("metal", 0.61).last} ${INHERITED.line("metal", 0.61).tonight}`.length <= 48, "the BTC line fits in one caption's worth");
  assert.equal(INHERITED.tag, "INHERITED");
  // The whitepaper's step: the pile, last epoch's coin as tonight's level-one trait, filing optional and paid by the player; about three sentences.
  const { title, body } = INHERITED.help;
  assert.ok(title.length <= 40 && title.endsWith("."), title);
  const sentences = body.split(/(?<=\.)\s+/).filter(Boolean);
  assert.ok(sentences.length >= 2 && sentences.length <= 4, `${sentences.length} sentences`);
  assert.match(body, /community pile/);
  assert.match(body, /last epoch/);
  assert.match(body, /level one/);
  assert.match(body, /optional/);
  assert.match(body, /gas paid by you/);
  assert.match(body, /one transaction/i);
  assert.doesNotMatch(`${title} ${body}`, /\$|price|pump|dump|crash|rug|hack|exploit|scam|liquidat|treasury|foundation|bags|seed phrase|earn|reward|airdrop|claim|drain|audit|profit|free money|guarantee|promise|will win|moon/i);
});

test("an installed wallet is used before a browser's built-in one (Brave announces its own first)", () => {
  const wallet = (name, rdns) => ({ info: { uuid: rdns, name, icon: "", rdns }, provider: { request: async () => null } });
  const brave = wallet("Brave Wallet", "com.brave.wallet");
  const metamask = wallet("MetaMask", "io.metamask");
  const rabby = wallet("Rabby Wallet", "io.rabby");
  assert.deepEqual(rankProviders([brave, metamask]).map((p) => p.info.name), ["MetaMask", "Brave Wallet"]);
  assert.deepEqual(rankProviders([brave, rabby, metamask]).map((p) => p.info.name), ["Rabby Wallet", "MetaMask", "Brave Wallet"]);
  assert.deepEqual(rankProviders([brave]).map((p) => p.info.name), ["Brave Wallet"], "Brave Wallet alone is still used");
  assert.deepEqual(rankProviders([]), []);
});
