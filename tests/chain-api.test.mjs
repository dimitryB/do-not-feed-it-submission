import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";
import {
  encodeAbiParameters, encodeEventTopics, getAbiItem, hashTypedData, keccak256, stringToHex, toFunctionSelector, toHex, verifyTypedData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { issueRunTicket, readLeaderboardSnapshot, readRunTicket, writeLeaderboardSnapshot } from "../db/chainState.ts";
import { MAX_TRACE_JSON_BYTES, traceHash } from "../lib/chain/trace.ts";
import {
  attestationTypedData, DEADLINE_SECONDS, feedRegistryAbi, GAME_VERSION_ID, gameVersionId, resultFromJson, seedToBytes32,
  SIGNATURE_WINDOW_SECONDS, SNAPSHOT_LOOKBACK, snapshotHashOf, TICKET_SECONDS,
} from "../lib/chain/types.ts";
import { ARENA, GAME_VERSION } from "../lib/game/arcade.ts";
import { ATTEST_LIMIT_PER_MINUTE, handleChainRequest, rateLimitBucket, TICKET_LIMIT_PER_MINUTE } from "../worker/chain.ts";
import { DEFAULT_CONFIRMATIONS, emptySnapshot, KEPT_EPOCHS, LOG_BATCH_BLOCKS, MAX_BLOCKS_PER_REFRESH, REFRESH_INTERVAL_MS, REFRESH_LEASE_MS } from "../worker/indexer.ts";
import { payloadHashOf } from "../worker/verifier.ts";
import { recordedEventsIn } from "../scripts/verify-filing.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(path.join(HERE, "fixtures", "loop-traces.json"), "utf8"));

/** Hardhat's first well-known test key. Never a real key. */
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const VERIFIER = privateKeyToAccount(TEST_KEY).address;
const PLAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const CHAIN_ID = 31337;
const START_MS = 1_800_000_000_000;
const HEX32 = /^0x[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ *
 * A Miniflare D1 with every migration applied, as production has them.
 * ------------------------------------------------------------------ */
const MIGRATIONS_DIR = new URL("../drizzle/", import.meta.url);
async function testDatabase() {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: crypto.randomUUID() },
  });
  const db = await miniflare.getD1Database("DB");
  for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort()) {
    const migration = await readFile(new URL(file, MIGRATIONS_DIR), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await db.prepare(statement).run();
    }
  }
  return { db, miniflare };
}

/** One contract address per harness: the indexer remembers its last attempt per contract across tests. */
let contracts = 0;
const nextContract = () => `0x${(++contracts).toString(16).padStart(40, "0")}`;

async function harness(t, { env: extra = {}, rpc } = {}) {
  const { db, miniflare } = await testDatabase();
  t.after(() => miniflare.dispose());
  const clock = { nowMs: START_MS };
  const env = {
    DB: db, DNFI_CONTRACT_ADDRESS: nextContract(), DNFI_VERIFIER_PRIVATE_KEY: TEST_KEY, DNFI_CHAIN_ID: String(CHAIN_ID),
    DNFI_DEPLOY_BLOCK: "0", DNFI_CONFIRMATIONS: "0", DNFI_PUBLIC_RPC_URL: "http://public-rpc.test/",
    HEMI_RPC_URL: "http://rpc.test/", HEMI_RPC_FALLBACKS: "http://rpc-fallback.test/", ...extra,
  };
  const deps = { now: () => clock.nowMs, fetchFn: rpc?.fetch };
  const call = async (route, { method = "GET", body, ip = "203.0.113.7", headers = {}, raw } = {}) => {
    const init = { method, headers: { "CF-Connecting-IP": ip, ...headers } };
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
    const response = await handleChainRequest(new Request(`https://dnfi.test${route}`, init), env, deps);
    if (response === null) return { status: null, body: null, response };
    if (!route.startsWith("/api/chain/trace")) assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Content-Type"), "application/json");
    return { status: response.status, body: await response.json(), response };
  };
  return { db, env, deps, clock, call };
}

const ZERO_PILE = { btc: 0n, eth: 0n, hemi: 0n };
/** The fixture's trait as the ticket row stores it: 0 none, 1 btc (metal), 2 eth (balloon), 3 hemi (pepper). */
const INHERITED_CODE = { metal: 1, balloon: 2, pepper: 3 };
const codeOf = (trace) => (trace.inherited ? INHERITED_CODE[trace.inherited] : 0);

/** A ticket for a frozen fixture: the seed (and the trait) must be the fixture's, so it goes in through D1, never HTTP. */
async function fixtureTicket(db, trace, nowMs, overrides = {}) {
  const issuedAt = Math.floor(nowMs / 1_000);
  const runId = `0x${crypto.randomUUID().replaceAll("-", "").padEnd(64, "a")}`;
  const snapshotHash = snapshotHashOf(0n, 0n, ZERO_PILE);
  await issueRunTicket(db, {
    runId, issuedAt, seed: String(trace.seed), expiresAt: issuedAt + TICKET_SECONDS, gameVersion: GAME_VERSION_ID, epoch: 0, snapshotHash,
    sourceEpoch: null, inherited: codeOf(trace),
    snapshotJson: JSON.stringify({ epoch: 0, sourceEpoch: null, btc: "0", eth: "0", hemi: "0", runs: "0" }),
    ...overrides,
  });
  return { runId, snapshotHash };
}

const attestBody = (runId, trace, player = PLAYER) => ({ runId, player, commands: trace.commands, endTick: trace.endTick });
const plainTrace = fixtures.traces.find((t) => !t.inherited);

/** Write a cached world straight into D1: the immutables and the piles the indexer would have kept. */
async function seedWorld(db, env, { genesis, epochSeconds, piles = {}, updatedAt = 1 }) {
  const snapshot = { ...emptySnapshot(), genesis, epochSeconds, cursor: 0, piles: Object.fromEntries(Object.entries(piles).map(([e, p]) => [e, { btc: 0, eth: 0, hemi: 0, runs: 0, ...p }])) };
  await writeLeaderboardSnapshot(db, { chainId: CHAIN_ID, contractAddress: env.DNFI_CONTRACT_ADDRESS, gameVersion: GAME_VERSION_ID, cursor: 0, snapshotJson: JSON.stringify(snapshot), updatedAt });
  return snapshot;
}

/* ------------------------------------------------------------------ *
 * config
 * ------------------------------------------------------------------ */

test("config says why the chain is off, and everything else is 503 disabled", async (t) => {
  const { call, env } = await harness(t);
  delete env.DNFI_VERIFIER_PRIVATE_KEY;
  const { status, body } = await call("/api/chain/config");
  assert.equal(status, 200);
  assert.equal(body.enabled, false);
  assert.match(body.reason, /DNFI_VERIFIER_PRIVATE_KEY/);
  assert.equal(body.chainId, CHAIN_ID);
  assert.equal(body.contractAddress, null);
  assert.equal(body.gameVersion, GAME_VERSION);
  assert.equal(body.gameVersionId, GAME_VERSION_ID);
  assert.equal(body.ticketSeconds, TICKET_SECONDS);
  for (const [route, method] of [["/api/chain/ticket", "POST"], ["/api/chain/attest", "POST"], ["/api/chain/world", "GET"]]) {
    const closed = await call(route, { method, body: method === "POST" ? {} : undefined });
    assert.equal(closed.status, 503, route);
    assert.equal(closed.body.error.code, "disabled", route);
  }
  delete env.DB;
  delete env.DNFI_CONTRACT_ADDRESS;
  const bare = await call("/api/chain/config");
  assert.match(bare.body.reason, /DB, DNFI_CONTRACT_ADDRESS, DNFI_VERIFIER_PRIVATE_KEY/);
  assert.equal(bare.body.chainId, CHAIN_ID, "the chain id still comes from the env");
});

test("config requires DNFI_DEPLOY_BLOCK once the chain is on, and reports a malformed one", async (t) => {
  const { call, env } = await harness(t);
  delete env.DNFI_DEPLOY_BLOCK;
  const missing = await call("/api/chain/config");
  assert.equal(missing.body.enabled, false);
  assert.match(missing.body.reason, /DNFI_DEPLOY_BLOCK not configured/);
  assert.equal((await call("/api/chain/ticket", { method: "POST", body: {} })).status, 503);
  env.DNFI_DEPLOY_BLOCK = "soon";
  const malformed = await call("/api/chain/config");
  assert.equal(malformed.body.enabled, false);
  assert.match(malformed.body.reason, /DNFI_DEPLOY_BLOCK is malformed/);
  env.DNFI_DEPLOY_BLOCK = "1234";
  assert.equal((await call("/api/chain/config")).body.enabled, true);
});

test("DNFI_TEST_CLOCK_OFFSET_SECONDS moves the Worker's clock on a local chain only", async (t) => {
  const { call, env, deps } = await harness(t, { env: { DNFI_TEST_CLOCK_OFFSET_SECONDS: "86400", DNFI_GENESIS: "1000", DNFI_EPOCH_SECONDS: "86400" } });
  deps.now = undefined; // the seam off: the real clock, plus the offset
  const wall = Math.floor(Date.now() / 1000);
  const local = await call("/api/chain/ticket", { method: "POST", body: {} });
  assert.equal(local.status, 200);
  assert.ok(local.body.issuedAt >= wall + 86400 - 5 && local.body.issuedAt <= wall + 86400 + 5, `a day ahead on 31337 (${local.body.issuedAt} vs ${wall})`);
  assert.equal(local.body.epoch, Math.floor((wall + 86400 - 1000) / 86400));
  env.DNFI_CHAIN_ID = "43111";
  const hemi = await call("/api/chain/ticket", { method: "POST", body: {} });
  assert.equal(hemi.status, 200);
  assert.ok(Math.abs(hemi.body.issuedAt - wall) <= 5, "ignored on Hemi");
  env.DNFI_CHAIN_ID = String(CHAIN_ID);
  env.DNFI_TEST_CLOCK_OFFSET_SECONDS = "a day";
  assert.equal((await call("/api/chain/ticket", { method: "POST", body: {} })).status, 503, "malformed is a fault, not a silent zero");
});

test("config is enabled with every binding present, and malformed values keep it off", async (t) => {
  const { call, env } = await harness(t);
  const { status, body } = await call("/api/chain/config");
  assert.equal(status, 200);
  assert.deepEqual(body, {
    enabled: true, chainId: CHAIN_ID, contractAddress: env.DNFI_CONTRACT_ADDRESS, explorerUrl: null,
    rpcUrl: env.DNFI_PUBLIC_RPC_URL, gameVersion: GAME_VERSION, gameVersionId: GAME_VERSION_ID, epochSeconds: 86_400, ticketSeconds: TICKET_SECONDS,
  }, "no explorer link off Hemi; the rpcUrl is the public one, never the indexer's");
  delete env.DNFI_PUBLIC_RPC_URL;
  assert.equal((await call("/api/chain/config")).body.rpcUrl, "https://rpc.hemi.network/rpc", "Hemi's public RPC when none is configured — not HEMI_RPC_URL");
  env.DNFI_PUBLIC_RPC_URL = "ftp://nope";
  assert.equal((await call("/api/chain/config")).body.rpcUrl, "https://rpc.hemi.network/rpc", "a non-http value is ignored");
  env.DNFI_PUBLIC_RPC_URL = "http://public-rpc.test/";
  env.DNFI_CHAIN_ID = "43111";
  assert.equal((await call("/api/chain/config")).body.explorerUrl, "https://explorer.hemi.xyz", "the explorer only on Hemi Mainnet");
  env.DNFI_CHAIN_ID = String(CHAIN_ID);
  env.DNFI_EPOCH_SECONDS = "3600";
  assert.equal((await call("/api/chain/config")).body.epochSeconds, 3600, "the env's epoch length is reported before the contract's is read");
  env.DNFI_VERIFIER_PRIVATE_KEY = "0x1234";
  const malformed = await call("/api/chain/config");
  assert.equal(malformed.body.enabled, false);
  assert.match(malformed.body.reason, /malformed/);
  env.DNFI_VERIFIER_PRIVATE_KEY = TEST_KEY;
  env.DNFI_CONTRACT_ADDRESS = "registry";
  assert.match((await call("/api/chain/config")).body.reason, /not an address/);
});

test("routing: wrong method, unknown route, and paths outside /api/chain fall through", async (t) => {
  const { call } = await harness(t);
  const method = await call("/api/chain/ticket", { method: "GET" });
  assert.equal(method.status, 405);
  assert.equal(method.body.error.code, "bad_request");
  const unknown = await call("/api/chain/nope");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, "bad_request");
  assert.equal((await call("/api/other")).response, null);
  assert.equal((await call("/")).response, null);
});

test("POST bodies must be declared application/json: 415 otherwise, a charset is fine", async (t) => {
  const { call } = await harness(t);
  for (const route of ["/api/chain/ticket", "/api/chain/attest"]) {
    const bare = await call(route, { method: "POST", raw: "{}" });
    assert.equal(bare.status, 415, `${route} with no Content-Type`);
    assert.equal(bare.body.error.code, "bad_request");
    const form = await call(route, { method: "POST", raw: "{}", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    assert.equal(form.status, 415, `${route} as a form`);
    const text = await call(route, { method: "POST", raw: "{}", headers: { "Content-Type": "text/plain" } });
    assert.equal(text.status, 415, `${route} as text`);
  }
  assert.equal((await call("/api/chain/ticket", { method: "POST", raw: "", headers: { "Content-Type": "application/json; charset=utf-8" } })).status, 200);
  assert.equal((await call("/api/chain/ticket", { method: "POST", raw: "", headers: { "Content-Type": "Application/JSON" } })).status, 200, "case-insensitive");
  const attest = await call("/api/chain/attest", { method: "POST", raw: "{}", headers: { "Content-Type": "application/json; charset=utf-8" } });
  assert.equal(attest.status, 400, "past the type check, the body's shape is judged");
});

test("rate-limit buckets: IPv4 as is, IPv6 by its /64, a mapped IPv4 as the IPv4", () => {
  assert.equal(rateLimitBucket("203.0.113.7"), "203.0.113.7");
  assert.equal(rateLimitBucket("2001:db8:85a3:8d3:1319:8a2e:370:7348"), "2001:db8:85a3:8d3::/64", "the interface half is dropped");
  assert.equal(rateLimitBucket("2001:0db8:85a3:08d3:1319:8a2e:0370:7348"), "2001:db8:85a3:8d3::/64", "leading zeros");
  assert.equal(rateLimitBucket("2001:DB8:85A3:8D3::1"), "2001:db8:85a3:8d3::/64", "case and `::`");
  assert.equal(rateLimitBucket("2001:db8::1"), "2001:db8:0:0::/64", "`::` in the network half");
  assert.equal(rateLimitBucket("::1"), "0:0:0:0::/64");
  assert.equal(rateLimitBucket("[2001:db8::2]"), "2001:db8:0:0::/64", "brackets");
  assert.equal(rateLimitBucket("fe80::1%eth0"), "fe80:0:0:0::/64", "a zone id");
  assert.equal(rateLimitBucket("::ffff:1.2.3.4"), "1.2.3.4", "IPv4-mapped");
  assert.equal(rateLimitBucket("::ffff:102:304"), "1.2.3.4", "IPv4-mapped, hex form");
  assert.equal(rateLimitBucket("0:0:0:0:0:ffff:203.0.113.7"), "203.0.113.7", "IPv4-mapped, full form");
  assert.equal(rateLimitBucket("64:ff9b::1.2.3.4"), "64:ff9b:0:0::/64", "NAT64 is an IPv6 /64, not the IPv4");
  assert.equal(rateLimitBucket("unknown"), "unknown", "the shared bucket");
  assert.equal(rateLimitBucket("2001:db8::1::2"), "2001:db8::1::2", "garbage is its own literal");
  assert.equal(rateLimitBucket("1:2:3:4:5:6:7:8:9"), "1:2:3:4:5:6:7:8:9");
  assert.notEqual(rateLimitBucket("2001:db8:85a3:8d3::1"), rateLimitBucket("2001:db8:85a3:8d4::1"), "another /64 is another bucket");
});

/* ------------------------------------------------------------------ *
 * ticket
 * ------------------------------------------------------------------ */

test("a ticket has a random 32-byte run id, a uint32 seed, a 40-minute life and inherits nothing when nothing is cached", async (t) => {
  const { call, db, clock } = await harness(t);
  const { status, body } = await call("/api/chain/ticket", { method: "POST", body: {} });
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["epoch", "expiresAt", "inherited", "issuedAt", "runId", "seed", "snapshot", "snapshotHash", "sourceEpoch"]);
  assert.match(body.runId, HEX32);
  assert.ok(Number.isInteger(body.seed) && body.seed >= 0 && body.seed <= 0xffffffff);
  assert.equal(body.issuedAt, Math.floor(clock.nowMs / 1_000));
  assert.equal(body.expiresAt, body.issuedAt + TICKET_SECONDS);
  assert.equal(body.epoch, 0);
  assert.equal(body.sourceEpoch, null);
  assert.equal(body.inherited, 0);
  assert.deepEqual(body.snapshot, { btc: 0, eth: 0, hemi: 0, runs: 0, dominant: 0 });
  assert.equal(body.snapshotHash, snapshotHashOf(0n, 0n, ZERO_PILE));
  const stored = await readRunTicket(db, body.runId);
  assert.equal(stored.seed, String(body.seed));
  assert.equal(stored.gameVersion, GAME_VERSION_ID);
  assert.equal(stored.epoch, 0);
  assert.equal(stored.sourceEpoch, null);
  assert.equal(stored.inherited, 0);
  assert.equal(stored.snapshotHash, body.snapshotHash);
  assert.equal(stored.expiresAt, body.expiresAt);
  const second = await call("/api/chain/ticket", { method: "POST", raw: "", headers: { "Content-Type": "application/json" } });
  assert.notEqual(second.body.runId, body.runId, "run ids are random");
  assert.equal(second.status, 200, "the ticket body is ignored");
});

test("a ticket inherits the dominant token of the last epoch with runs, within the lookback (docs/CHAIN.md §10.1)", async (t) => {
  const { call, db, env, clock } = await harness(t);
  const epochSeconds = 3_600;
  const now = Math.floor(clock.nowMs / 1_000);
  const genesis = now - 10 * epochSeconds - 100; // epoch 10, 100 s in
  const issue = async () => { const r = await call("/api/chain/ticket", { method: "POST", body: {} }); assert.equal(r.status, 200); return r.body; };
  const stored = (body) => readRunTicket(db, body.runId);

  // (i) the immutables are known but no pile is cached: nothing inherited, the hash says epoch 10 and a zero world.
  await seedWorld(db, env, { genesis, epochSeconds });
  const empty = await issue();
  assert.equal(empty.epoch, 10);
  assert.equal(empty.sourceEpoch, null);
  assert.equal(empty.inherited, 0);
  assert.deepEqual(empty.snapshot, { btc: 0, eth: 0, hemi: 0, runs: 0, dominant: 0 });
  assert.equal(empty.snapshotHash, snapshotHashOf(10n, 0n, ZERO_PILE));
  assert.deepEqual([(await stored(empty)).sourceEpoch, (await stored(empty)).inherited], [null, 0]);

  // (ii) epoch 9 has runs: the source is 9, its pile is the snapshot, its dominant the trait (eth here).
  await seedWorld(db, env, { genesis, epochSeconds, piles: { 9: { btc: 5, eth: 9, hemi: 2, runs: 3 }, 10: { btc: 100, eth: 0, hemi: 0, runs: 4 } } });
  const last = await issue();
  assert.equal(last.epoch, 10);
  assert.equal(last.sourceEpoch, 9);
  assert.equal(last.inherited, 2);
  assert.deepEqual(last.snapshot, { btc: 5, eth: 9, hemi: 2, runs: 3, dominant: 2 });
  assert.equal(last.snapshotHash, snapshotHashOf(10n, 9n, { btc: 5n, eth: 9n, hemi: 2n }));
  assert.deepEqual([(await stored(last)).sourceEpoch, (await stored(last)).inherited], [9, 2]);
  assert.equal(last.snapshot.btc, 5, "the current epoch's own pile never leaks into a ticket (D19)");

  // (iii) epoch 9 is empty but 7 has runs: the source is 7 (hemi wins the tie against btc? no — btc and hemi tie, btc is earlier).
  await seedWorld(db, env, { genesis, epochSeconds, piles: { 7: { btc: 4, eth: 1, hemi: 4, runs: 2 }, 3: { btc: 0, eth: 50, hemi: 0, runs: 1 } } });
  const gap = await issue();
  assert.equal(gap.sourceEpoch, 7);
  assert.equal(gap.inherited, 1, "a tie goes to the earlier token");
  assert.deepEqual(gap.snapshot, { btc: 4, eth: 1, hemi: 4, runs: 2, dominant: 1 });
  assert.equal(gap.snapshotHash, snapshotHashOf(10n, 7n, { btc: 4n, eth: 1n, hemi: 4n }));

  // The edge of the lookback: epoch 10 − 8 = 2 is the oldest source; 1 is not.
  await seedWorld(db, env, { genesis, epochSeconds, piles: { 2: { btc: 0, eth: 0, hemi: 7, runs: 1 } } });
  const edge = await issue();
  assert.equal(SNAPSHOT_LOOKBACK, 8);
  assert.equal(edge.sourceEpoch, 2);
  assert.equal(edge.inherited, 3);
  assert.equal(edge.snapshotHash, snapshotHashOf(10n, 2n, { btc: 0n, eth: 0n, hemi: 7n }));

  // (iv) only epochs older than the lookback have runs: nothing inherited, and the hash says so.
  await seedWorld(db, env, { genesis, epochSeconds, piles: { 1: { btc: 0, eth: 0, hemi: 7, runs: 1 }, 0: { btc: 9, eth: 0, hemi: 0, runs: 9 } } });
  const old = await issue();
  assert.equal(old.sourceEpoch, null);
  assert.equal(old.inherited, 0);
  assert.deepEqual(old.snapshot, { btc: 0, eth: 0, hemi: 0, runs: 0, dominant: 0 });
  assert.equal(old.snapshotHash, snapshotHashOf(10n, 0n, ZERO_PILE));
  assert.equal(old.snapshotHash, empty.snapshotHash, "nothing inherited hashes like an empty world");

  // A source epoch of zero-feed runs is a source that teaches nothing.
  await seedWorld(db, env, { genesis, epochSeconds, piles: { 9: { btc: 0, eth: 0, hemi: 0, runs: 2 } } });
  const zero = await issue();
  assert.equal(zero.sourceEpoch, 9);
  assert.equal(zero.inherited, 0);
  assert.equal(zero.snapshotHash, snapshotHashOf(10n, 9n, ZERO_PILE));
  assert.notEqual(zero.snapshotHash, empty.snapshotHash, "but it is a different world from no source at all");
  assert.equal(KEPT_EPOCHS, SNAPSHOT_LOOKBACK + 1, "the indexer keeps the lookback's piles and one more, so the ledger's oldest epoch knows its own inheritance");
});

test("a ticket's epoch follows the env immutables when the indexer has not run", async (t) => {
  const { call, clock } = await harness(t, { env: { DNFI_GENESIS: String(START_MS / 1_000 - 10 * 3_600), DNFI_EPOCH_SECONDS: "3600" } });
  assert.equal((await call("/api/chain/ticket", { method: "POST", body: {} })).body.epoch, 10);
  clock.nowMs += 3_600_000;
  assert.equal((await call("/api/chain/ticket", { method: "POST", body: {} })).body.epoch, 11);
});

test("tickets are limited to 30 a minute per IP", async (t) => {
  const { call, clock } = await harness(t);
  for (let i = 0; i < TICKET_LIMIT_PER_MINUTE; i++) {
    assert.equal((await call("/api/chain/ticket", { method: "POST", body: {} })).status, 200, `ticket ${i + 1}`);
  }
  const limited = await call("/api/chain/ticket", { method: "POST", body: {} });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "rate_limited");
  assert.equal(limited.response.headers.get("Retry-After"), "60");
  assert.equal((await call("/api/chain/ticket", { method: "POST", body: {}, ip: "198.51.100.9" })).status, 200, "another address is another bucket");
  clock.nowMs += 60_000;
  assert.equal((await call("/api/chain/ticket", { method: "POST", body: {} })).status, 200, "the window has passed");
});

/* ------------------------------------------------------------------ *
 * attest
 * ------------------------------------------------------------------ */

test("attest replays a frozen shift, signs it and stores exactly one attestation", async (t) => {
  const { call, db, env, clock } = await harness(t);
  const trace = fixtures.traces[1];
  const { runId, snapshotHash } = await fixtureTicket(db, trace, clock.nowMs);
  clock.nowMs += 5 * 60_000;
  const nowSeconds = Math.floor(clock.nowMs / 1_000);
  const { status, body } = await call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace) });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(Object.keys(body).sort(), ["result", "typedData", "verifierSignature"]);
  const result = resultFromJson(body.result);
  assert.equal(result.runId, runId);
  assert.equal(result.player, PLAYER);
  assert.equal(result.gameVersion, gameVersionId(GAME_VERSION));
  assert.equal(result.score, BigInt(trace.expect.score));
  assert.equal(result.totalFeeds, trace.expect.totalFeeds);
  assert.equal(result.btcFed + result.ethFed + result.hemiFed, result.totalFeeds);
  assert.equal(result.durationTicks, trace.endTick);
  assert.equal(result.cause, 0);
  assert.equal(result.seed, seedToBytes32(trace.seed));
  assert.equal(result.traceHash, traceHash(trace.commands, trace.endTick));
  assert.equal(result.snapshotHash, snapshotHash);
  assert.equal(result.deadline, BigInt(nowSeconds + DEADLINE_SECONDS));
  assert.equal(body.result.score, String(trace.expect.score), "bigints travel as decimal strings");
  assert.equal(typeof body.result.deadline, "string");

  const typed = attestationTypedData(result, env.DNFI_CONTRACT_ADDRESS, CHAIN_ID);
  assert.equal(await verifyTypedData({ ...typed, address: VERIFIER, signature: body.verifierSignature }), true);
  assert.equal(body.typedData.primaryType, "RunResult");
  assert.deepEqual(body.typedData.domain, { name: "Do Not Feed It", version: "1", chainId: CHAIN_ID, verifyingContract: env.DNFI_CONTRACT_ADDRESS });
  assert.deepEqual(body.typedData.message, body.result, "the player signs exactly the result returned");
  assert.equal(body.typedData.types.RunResult.length, 18);
  assert.deepEqual(body.typedData.types.EIP712Domain.map((f) => f.name), ["name", "version", "chainId", "verifyingContract"]);
  // The payload is complete for eth_signTypedData_v4, and viem hashes it to the digest the verifier attested.
  assert.equal(hashTypedData({ ...body.typedData, message: result }), typed.message.resultHash);

  const stored = await readRunTicket(db, runId);
  assert.equal(stored.player, PLAYER);
  assert.equal(stored.verifierSignature, body.verifierSignature);
  assert.equal(stored.attestedAt, nowSeconds);
  assert.equal(stored.payloadHash, payloadHashOf(runId, result.traceHash, trace.endTick));
  assert.deepEqual(JSON.parse(stored.resultJson), body.result);
  assert.equal(stored.expiresAt, nowSeconds + 2 * SIGNATURE_WINDOW_SECONDS, "once attested the row outlives the ticket's 40 minutes by the re-sign window");
});

test("attest replays an inherited shift with the ticket's trait, never the request's", async (t) => {
  const { call, db, clock } = await harness(t);
  for (const trace of fixtures.traces.filter((tr) => tr.inherited)) {
    const { runId } = await fixtureTicket(db, trace, clock.nowMs, { sourceEpoch: 4, snapshotHash: snapshotHashOf(5n, 4n, { btc: 1n, eth: 2n, hemi: 3n }) });
    assert.equal((await readRunTicket(db, runId)).inherited, INHERITED_CODE[trace.inherited]);
    // The request has no say: an `inherited` field in the body is ignored.
    const { status, body } = await call("/api/chain/attest", { method: "POST", body: { ...attestBody(runId, trace), inherited: null } });
    assert.equal(status, 200, `${trace.inherited}: ${JSON.stringify(body)}`);
    const result = resultFromJson(body.result);
    assert.equal(result.score, BigInt(trace.expect.score), `${trace.inherited}: the fixture's numbers`);
    assert.equal(result.totalFeeds, trace.expect.totalFeeds);
    assert.equal(result.durationTicks, trace.endTick);
    assert.equal(result.snapshotHash, snapshotHashOf(5n, 4n, { btc: 1n, eth: 2n, hemi: 3n }), "the ticket's world is in the signed result");
  }
  // A plain trace on a ticket that inherited metal is another creature: the shots do not land.
  const metal = await fixtureTicket(db, plainTrace, clock.nowMs, { inherited: 1 });
  const wrong = await call("/api/chain/attest", { method: "POST", body: attestBody(metal.runId, plainTrace) });
  assert.equal(wrong.status, 422);
  assert.ok(["invalid_trace", "run_not_over"].includes(wrong.body.error.code), wrong.body.error.code);
  assert.equal((await readRunTicket(db, metal.runId)).verifierSignature, null);
  // And an inherited trace on a plain ticket likewise.
  const balloon = fixtures.traces.find((tr) => tr.inherited === "balloon");
  const plain = await fixtureTicket(db, balloon, clock.nowMs, { inherited: 0 });
  const wrongWay = await call("/api/chain/attest", { method: "POST", body: attestBody(plain.runId, balloon) });
  assert.equal(wrongWay.status, 422);
  // A row issued before migration 0002 (null inherited) reads as nothing inherited.
  const legacy = await fixtureTicket(db, plainTrace, clock.nowMs, { inherited: null });
  assert.equal((await call("/api/chain/attest", { method: "POST", body: attestBody(legacy.runId, plainTrace) })).status, 200);
});

test("attest checks the player's EIP-55 checksum and normalises the address", async (t) => {
  const { call, db, clock } = await harness(t);
  const bad = await call("/api/chain/attest", { method: "POST", body: attestBody(`0x${"ab".repeat(32)}`, plainTrace, "0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045") });
  assert.equal(bad.status, 400, "mixed case with a wrong checksum");
  assert.equal(bad.body.error.code, "bad_request");
  assert.match(bad.body.error.message, /checksum/);
  const { runId } = await fixtureTicket(db, plainTrace, clock.nowMs);
  const lower = await call("/api/chain/attest", { method: "POST", body: attestBody(runId, plainTrace, PLAYER.toLowerCase()) });
  assert.equal(lower.status, 200, "all-lowercase is accepted");
  assert.equal(lower.body.result.player, PLAYER, "and comes back checksummed");
  assert.equal((await readRunTicket(db, runId)).player, PLAYER);
  const upper = await call("/api/chain/attest", { method: "POST", body: attestBody(runId, plainTrace, PLAYER.toUpperCase().replace("0X", "0x")) });
  assert.equal(upper.status, 400, "all-uppercase hex is a mixed-case address with a wrong checksum");
});

test("attest is idempotent for the same payload and player, 409 for another trace, and 409 for another wallet: a run belongs to the wallet it was first signed for", async (t) => {
  const { call, db, clock } = await harness(t);
  const trace = fixtures.traces[0];
  const { runId } = await fixtureTicket(db, trace, clock.nowMs);
  const first = await call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace) });
  assert.equal(first.status, 200);
  clock.nowMs += 90_000;
  const again = await call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace) });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, first.body, "same signature, same result, same deadline");

  const shorter = { ...attestBody(runId, trace), commands: trace.commands.slice(0, -1) };
  const otherTrace = await call("/api/chain/attest", { method: "POST", body: shorter });
  assert.equal(otherTrace.status, 409, "a different trace on an attested ticket is refused before any replay");
  assert.equal(otherTrace.body.error.code, "payload_conflict");
  const otherTick = await call("/api/chain/attest", { method: "POST", body: { ...attestBody(runId, trace, OTHER), endTick: trace.endTick + 1 } });
  assert.equal(otherTick.status, 409, "another endTick is another payload, whoever asks");
  assert.equal((await readRunTicket(db, runId)).player, PLAYER);

  // The same run from another wallet — the player switched accounts, or someone who learned the run id and fetched its
  // trace — is refused: the attestation stays the first wallet's, and the message names it so the player can switch back.
  clock.nowMs += 1_000;
  const switched = await call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace, OTHER) });
  assert.equal(switched.status, 409, JSON.stringify(switched.body));
  assert.equal(switched.body.error.code, "player_conflict");
  assert.match(switched.body.error.message, new RegExp(`${PLAYER.slice(0, 6)}…${PLAYER.slice(-4)}`));
  const row = await readRunTicket(db, runId);
  assert.equal(row.player, PLAYER, "the row still holds the first wallet");
  assert.equal(row.verifierSignature, first.body.verifierSignature, "and its signature");
  assert.equal(row.payloadHash, payloadHashOf(runId, first.body.result.traceHash, trace.endTick), "the payload hash has no player in it");
  const lower = await call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace, PLAYER.toLowerCase()) });
  assert.equal(lower.status, 200, "the same wallet in another case is the same wallet");
  assert.deepEqual(lower.body, first.body);

  // Nineteen minutes on, the stored signature has under two minutes to live: the same payload is re-dated and re-signed for the same wallet.
  clock.nowMs += 19 * 60_000 - 1_000;
  const late = await call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace) });
  assert.equal(late.status, 200);
  assert.notEqual(late.body.verifierSignature, first.body.verifierSignature, "a fresh signature");
  assert.notEqual(late.body.result.deadline, first.body.result.deadline, "a fresh deadline");
  assert.deepEqual({ ...late.body.result, deadline: first.body.result.deadline }, first.body.result, "every other field unchanged");
  assert.equal(Number(late.body.result.deadline), Math.floor(clock.nowMs / 1000) + 20 * 60);
  const typed = attestationTypedData(resultFromJson(late.body.result), (await harnessContract(call)), CHAIN_ID);
  assert.equal(await verifyTypedData({ ...typed, address: VERIFIER, signature: late.body.verifierSignature }), true, "signed by the verifier");
  assert.equal((await readRunTicket(db, runId)).verifierSignature, late.body.verifierSignature, "the row holds the new one");
  const repeat = await call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace) });
  assert.deepEqual(repeat.body, late.body, "and is idempotent again");
  assert.equal((await call("/api/chain/attest", { method: "POST", body: shorter })).status, 409, "a different payload is still a conflict after the re-sign");
  assert.equal((await call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace, OTHER) })).status, 409, "and another wallet still is");
});

/** The contract the harness resolved, read back from config. */
async function harnessContract(call) { return (await call("/api/chain/config")).body.contractAddress; }

test("once attested, a ticket's row outlives its 40 minutes so the re-sign path keeps working for an hour", async (t) => {
  const { call, db, clock } = await harness(t);
  const trace = fixtures.traces[0];
  const { runId } = await fixtureTicket(db, trace, clock.nowMs);
  const issuedAt = Math.floor(clock.nowMs / 1_000);
  clock.nowMs += 35 * 60_000; // attested with five minutes of ticket left
  const first = await call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace) });
  assert.equal(first.status, 200);
  const attestedAt = Math.floor(clock.nowMs / 1_000);
  assert.equal((await readRunTicket(db, runId)).expiresAt, attestedAt + 2 * SIGNATURE_WINDOW_SECONDS, "max(expiresAt, attestedAt + 60 min)");
  assert.ok(attestedAt + 2 * SIGNATURE_WINDOW_SECONDS > issuedAt + TICKET_SECONDS);

  clock.nowMs += 19 * 60_000; // 54 minutes after issue: the ticket's own life is over, the signature is about to expire
  const resigned = await call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace) });
  assert.equal(resigned.status, 200, JSON.stringify(resigned.body));
  assert.notEqual(resigned.body.verifierSignature, first.body.verifierSignature, "re-dated and re-signed, the row still there");
  clock.nowMs += 5 * 60_000;
  const switched = await call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace, OTHER) });
  assert.equal(switched.status, 409, "and another wallet still cannot take it over");
  assert.equal(switched.body.error.code, "player_conflict");
  // A ticket issued alongside sweeps nothing of it; one issued past the hour does.
  await call("/api/chain/ticket", { method: "POST", body: {} });
  assert.ok(await readRunTicket(db, runId), "not swept while kept");
  clock.nowMs = (attestedAt + 2 * SIGNATURE_WINDOW_SECONDS + 1) * 1_000;
  const gone = await call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace) });
  assert.equal(gone.status, 410, "past the hour: expired");
  await call("/api/chain/ticket", { method: "POST", body: {} });
  assert.equal(await readRunTicket(db, runId), null, "and swept");
  // A ticket never attested keeps its 40 minutes.
  const fresh = await fixtureTicket(db, trace, clock.nowMs);
  clock.nowMs += (TICKET_SECONDS + 1) * 1_000;
  assert.equal((await call("/api/chain/attest", { method: "POST", body: attestBody(fresh.runId, trace) })).status, 410);
});

test("two wallets racing the same run on one ticket: exactly one is answered, the other is told whose shift it is", async (t) => {
  const { call, db, deps, clock } = await harness(t);
  const trace = fixtures.traces[0];
  const { runId } = await fixtureTicket(db, trace, clock.nowMs);
  // Every clock read moves a second on, so the two racers build results with different deadlines.
  deps.now = () => (clock.nowMs += 1_000);
  const [a, b] = await Promise.all([
    call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace, PLAYER) }),
    call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace, OTHER) }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.body, b.body]));
  const winner = a.status === 200 ? a : b;
  const loser = a.status === 200 ? b : a;
  assert.equal(loser.body.error.code, "player_conflict");
  const stored = await readRunTicket(db, runId);
  assert.equal(stored.player, winner.body.result.player, "the row holds the first store, whole");
  assert.equal(stored.verifierSignature, winner.body.verifierSignature);
  assert.deepEqual(JSON.parse(stored.resultJson), winner.body.result);
  assert.equal(stored.payloadHash, payloadHashOf(runId, winner.body.result.traceHash, trace.endTick));
  assert.deepEqual((await call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace, stored.player) })).body, winner.body, "repeating the winner is idempotent");
  const again = await call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace, winner === a ? OTHER : PLAYER) });
  assert.equal(again.status, 409, "the loser stays refused, in sequence too");

  const twin = await fixtureTicket(db, trace, clock.nowMs);
  const [c, d] = await Promise.all([
    call("/api/chain/attest", { method: "POST", body: attestBody(twin.runId, trace) }),
    call("/api/chain/attest", { method: "POST", body: attestBody(twin.runId, trace) }),
  ]);
  assert.equal(c.status, 200);
  assert.equal(d.status, 200);
  assert.deepEqual(c.body, d.body, "the same payload racing itself gets one result and one signature");
  assert.equal((await readRunTicket(db, twin.runId)).verifierSignature, c.body.verifierSignature);
});

test("attest refuses an unknown, expired or outdated ticket", async (t) => {
  const { call, db, clock } = await harness(t);
  const trace = fixtures.traces[0];
  const unknown = await call("/api/chain/attest", { method: "POST", body: attestBody(`0x${"ab".repeat(32)}`, trace) });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, "unknown_ticket");

  const { runId } = await fixtureTicket(db, trace, clock.nowMs);
  clock.nowMs += (TICKET_SECONDS + 1) * 1_000;
  const expired = await call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace) });
  assert.equal(expired.status, 410);
  assert.equal(expired.body.error.code, "expired_ticket");

  const old = await fixtureTicket(db, trace, clock.nowMs, { gameVersion: gameVersionId(GAME_VERSION - 1) });
  const outdated = await call("/api/chain/attest", { method: "POST", body: attestBody(old.runId, trace) });
  assert.equal(outdated.status, 410);
  assert.equal(outdated.body.error.code, "expired_ticket");
  assert.match(outdated.body.error.message, /version/);
});

test("attest refuses bad JSON, bad shapes and oversize bodies before any replay", async (t) => {
  const { call } = await harness(t);
  const bad = await call("/api/chain/attest", { method: "POST", raw: "{not json", headers: { "Content-Type": "application/json" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "bad_request");
  assert.equal((await call("/api/chain/attest", { method: "POST", body: [] })).status, 400);
  assert.equal((await call("/api/chain/attest", { method: "POST", body: { runId: "0x12", player: PLAYER, commands: [], endTick: 1 } })).status, 400);
  assert.equal((await call("/api/chain/attest", { method: "POST", body: { runId: `0x${"ab".repeat(32)}`, player: "vitalik.eth", commands: [], endTick: 1 } })).status, 400);
  assert.equal((await call("/api/chain/attest", { method: "POST", body: { runId: `0x${"ab".repeat(32)}`, player: PLAYER, commands: {}, endTick: 1 } })).status, 400);
  assert.equal((await call("/api/chain/attest", { method: "POST", body: { runId: `0x${"ab".repeat(32)}`, player: PLAYER, commands: [], endTick: "1" } })).status, 400);
  const missing = await call("/api/chain/attest", { method: "POST", headers: { "Content-Type": "application/json" } });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error.message, /Missing body/);

  const declared = await call("/api/chain/attest", {
    method: "POST", raw: "{}", headers: { "Content-Type": "application/json", "Content-Length": String(MAX_TRACE_JSON_BYTES + 1) },
  });
  assert.equal(declared.status, 413, "a declared oversize body is refused unread");
  assert.equal(declared.body.error.code, "bad_request");

  const padding = `{"pad":"${"x".repeat(MAX_TRACE_JSON_BYTES)}"}`;
  const oversize = await call("/api/chain/attest", { method: "POST", raw: padding, headers: { "Content-Type": "application/json" } });
  assert.equal(oversize.status, 413, "an undeclared oversize body is cut off at the cap");
});

test("attest rejects a run that is still playing and a trace the rules refuse", async (t) => {
  const { call, db, clock } = await harness(t);
  const trace = fixtures.traces[0];
  const early = await fixtureTicket(db, trace, clock.nowMs);
  const endTick = trace.endTick - 1;
  const notOver = await call("/api/chain/attest", {
    method: "POST", body: { runId: early.runId, player: PLAYER, commands: trace.commands.filter((c) => c.tick <= endTick), endTick },
  });
  assert.equal(notOver.status, 422);
  assert.equal(notOver.body.error.code, "run_not_over");
  assert.equal((await readRunTicket(db, early.runId)).verifierSignature, null, "nothing was stored");

  const forged = await fixtureTicket(db, trace, clock.nowMs);
  const doubled = [trace.commands[0], { ...trace.commands[0], tick: 1 }, ...trace.commands.slice(1)];
  const invalid = await call("/api/chain/attest", { method: "POST", body: { runId: forged.runId, player: PLAYER, commands: doubled, endTick: trace.endTick } });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, "invalid_trace");

  const tooLong = await call("/api/chain/attest", { method: "POST", body: { runId: forged.runId, player: PLAYER, commands: trace.commands, endTick: ARENA.maxTicks + 1 } });
  assert.equal(tooLong.status, 422);
  assert.equal(tooLong.body.error.code, "invalid_trace");

  const wrongSeed = await fixtureTicket(db, { ...trace, seed: trace.seed + 1 }, clock.nowMs);
  const mismatch = await call("/api/chain/attest", { method: "POST", body: attestBody(wrongSeed.runId, trace) });
  assert.equal(mismatch.status, 422, "another seed is another run; the recorded shots do not land");
  assert.ok(["invalid_trace", "run_not_over"].includes(mismatch.body.error.code));

  const happy = await fixtureTicket(db, trace, clock.nowMs);
  assert.equal((await call("/api/chain/attest", { method: "POST", body: attestBody(happy.runId, trace) })).status, 200, "the honest trace still passes");
});

test("attest is limited to 10 a minute per IP", async (t) => {
  const { call } = await harness(t);
  const body = { runId: `0x${"ab".repeat(32)}`, player: PLAYER, commands: [], endTick: 1 };
  for (let i = 0; i < ATTEST_LIMIT_PER_MINUTE; i++) assert.equal((await call("/api/chain/attest", { method: "POST", body })).status, 404);
  const limited = await call("/api/chain/attest", { method: "POST", body });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "rate_limited");
});

/* ------------------------------------------------------------------ *
 * world — a fake JSON-RPC behind viem's http transport
 * ------------------------------------------------------------------ */

const resultRecorded = getAbiItem({ abi: feedRegistryAbi, name: "ResultRecorded" });
const pileFed = getAbiItem({ abi: feedRegistryAbi, name: "PileFed" });
const SELECTOR = { genesis: toFunctionSelector("function GENESIS() view returns (uint64)"), epochSeconds: toFunctionSelector("function EPOCH_SECONDS() view returns (uint64)") };

/** One `PileFed` log, as the contract emits it after a filing's `ResultRecorded` when the filing fed the pile. */
function fedLog(contract, block, logIndex, txIndex, r) {
  const topics = encodeEventTopics({ abi: feedRegistryAbi, eventName: "PileFed", args: { runId: r.runId ?? keccak256(stringToHex(`${block}:${txIndex}`)), player: r.player, epoch: BigInt(r.epoch ?? 0) } });
  const data = encodeAbiParameters(pileFed.inputs.filter((input) => !input.indexed), [r.btcFed ?? 0, r.ethFed ?? 0, r.hemiFed ?? 0]);
  return {
    address: contract, topics, data, blockNumber: toHex(block), transactionHash: keccak256(stringToHex(`tx:${block}:${txIndex}`)),
    transactionIndex: "0x0", blockHash: keccak256(stringToHex(`block:${block}`)), logIndex: toHex(logIndex), removed: false,
  };
}

/** One `ResultRecorded` log as the node would return it. */
function recordedLog(contract, block, logIndex, r) {
  const topics = encodeEventTopics({ abi: feedRegistryAbi, eventName: "ResultRecorded", args: { runId: r.runId ?? keccak256(stringToHex(`${block}:${logIndex}`)), player: r.player, gameVersion: r.gameVersion ?? GAME_VERSION_ID } });
  const data = encodeAbiParameters(resultRecorded.inputs.filter((input) => !input.indexed), [
    BigInt(r.score), r.durationTicks ?? 600, r.btcFed ?? 0, r.ethFed ?? 0, r.hemiFed ?? 0, r.bestCombo ?? 1, r.frenzies ?? 0,
    r.sizeCenti ?? 100, r.ending ?? 0, r.cause ?? 0, BigInt(r.epoch ?? 0), `0x${"00".repeat(32)}`, `0x${"11".repeat(32)}`,
  ]);
  return {
    address: contract, topics, data, blockNumber: toHex(block), transactionHash: keccak256(stringToHex(`tx:${block}:${logIndex}`)),
    transactionIndex: "0x0", blockHash: keccak256(stringToHex(`block:${block}`)), logIndex: toHex(logIndex), removed: false,
  };
}

/** A fake Hemi node: a head, immutables and logs; `down` makes a URL throw. */
function fakeRpc({ contract, genesis, epochSeconds, head = 0 }) {
  const node = { head, logs: [], down: new Set(), calls: [] };
  const answer = (request) => {
    node.calls.push(request.method === "eth_getLogs" ? { method: request.method, from: Number(request.params[0].fromBlock), to: Number(request.params[0].toBlock) } : { method: request.method });
    switch (request.method) {
      case "eth_chainId": return toHex(CHAIN_ID);
      case "eth_blockNumber": return toHex(node.head);
      case "eth_call": {
        const data = request.params[0].data.slice(0, 10);
        if (data === SELECTOR.genesis) return encodeAbiParameters([{ type: "uint64" }], [BigInt(genesis)]);
        if (data === SELECTOR.epochSeconds) return encodeAbiParameters([{ type: "uint64" }], [BigInt(epochSeconds)]);
        throw new Error(`unexpected call ${data}`);
      }
      case "eth_getLogs": {
        const { fromBlock, toBlock, address } = request.params[0];
        assert.equal(address.toLowerCase(), contract.toLowerCase());
        return node.logs.filter((log) => Number(log.blockNumber) >= Number(fromBlock) && Number(log.blockNumber) <= Number(toBlock));
      }
      default: throw new Error(`unexpected method ${request.method}`);
    }
  };
  node.before = null;
  node.fetch = async (url, init) => {
    if (node.down.has(String(url))) throw new TypeError("fetch failed");
    const body = JSON.parse(init.body);
    for (const request of Array.isArray(body) ? body : [body]) if (node.before) await node.before(request);
    const reply = (request) => ({ jsonrpc: "2.0", id: request.id, result: answer(request) });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)), { headers: { "Content-Type": "application/json" } });
  };
  // A filing: its ResultRecorded, then — unless `fed: false` (past the wallet's three for the epoch) — its PileFed.
  // Log indices are spaced so the pair stays together and in order; the transaction hash names the filing.
  node.add = (block, logIndex, r) => {
    node.logs.push({ ...recordedLog(contract, block, logIndex, r), logIndex: toHex(logIndex * 2) });
    if (r.fed !== false) node.logs.push(fedLog(contract, block, logIndex * 2 + 1, logIndex, r));
  };
  return node;
}

test("world: the pile is what PileFed says — a filing past a wallet's three ranks but feeds nothing", async (t) => {
  const contract = nextContract();
  const epochSeconds = 3_600;
  const genesis = START_MS / 1_000 - 2 * epochSeconds - 100; // now is 100 s into epoch 2
  const rpc = fakeRpc({ contract, genesis, epochSeconds, head: 10 });
  const { call } = await harness(t, { env: { DNFI_CONTRACT_ADDRESS: contract, DNFI_DEPLOY_BLOCK: "3" }, rpc });
  // Epoch 1: PLAYER files four times; the contract fed the pile with the first three (ETH, ETH, ETH) and not the fourth (lots of BTC).
  rpc.add(4, 0, { player: PLAYER, score: 100, ethFed: 5, epoch: 1 });
  rpc.add(4, 1, { player: PLAYER, score: 200, ethFed: 5, epoch: 1 });
  rpc.add(5, 0, { player: PLAYER, score: 300, ethFed: 5, epoch: 1 });
  rpc.add(6, 0, { player: PLAYER, score: 999, btcFed: 40, epoch: 1, fed: false });
  const { status, body } = await call("/api/chain/world");
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.pile.previous, { btc: 0, eth: 15, hemi: 0, runs: 3 }, "only the three that fed it");
  assert.deepEqual(body.pile.allTime, { btc: 0, eth: 15, hemi: 0, runs: 3 });
  assert.equal(body.inherited, 2, "ETH, not the fourth filing's BTC, is tonight's trait");
  assert.deepEqual(body.top.map((e) => [e.player, e.score]), [[PLAYER, 999]], "the fourth filing is still the best on the board");
});

test("world ranks one best per player, sums the pile per epoch and advances the cursor", async (t) => {
  const contract = nextContract();
  const epochSeconds = 3_600;
  const genesis = START_MS / 1_000 - 2 * epochSeconds - 100; // now is 100 s into epoch 2
  const rpc = fakeRpc({ contract, genesis, epochSeconds, head: 10 });
  const { call, db, env, clock } = await harness(t, { env: { DNFI_CONTRACT_ADDRESS: contract, DNFI_DEPLOY_BLOCK: "3" }, rpc });
  rpc.add(4, 0, { player: PLAYER, score: 500, btcFed: 10, ethFed: 2, hemiFed: 1, epoch: 0 });
  rpc.add(5, 0, { player: OTHER, score: 900, btcFed: 1, ethFed: 20, hemiFed: 3, epoch: 1, durationTicks: 999, bestCombo: 7, sizeCenti: 222, ending: 2 });
  rpc.add(5, 1, { player: PLAYER, score: 700, btcFed: 4, ethFed: 4, hemiFed: 30, epoch: 1 });
  rpc.add(6, 0, { player: PLAYER, score: 650, btcFed: 1, ethFed: 1, hemiFed: 1, epoch: 1 });
  rpc.add(7, 0, { player: OTHER, score: 100, btcFed: 5, ethFed: 0, hemiFed: 0, epoch: 1, gameVersion: gameVersionId(GAME_VERSION + 1) });

  const { status, body } = await call("/api/chain/world");
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.stale, false);
  assert.equal(body.gameVersionId, GAME_VERSION_ID);
  assert.equal(body.epoch, 2);
  assert.equal(body.epochSeconds, epochSeconds);
  assert.equal(body.sourceEpoch, 1, "the title's prediction: the last epoch with runs");
  assert.equal(body.inherited, 3, "hemi dominates epoch 1");
  assert.deepEqual(Object.keys(body).sort(), ["cursor", "epoch", "epochSeconds", "epochs", "gameVersionId", "genesis", "inherited", "pile", "sourceEpoch", "stale", "top", "updatedAt"]);
  assert.equal(body.genesis, genesis);
  assert.equal(body.cursor, 10);
  assert.equal(body.updatedAt, Math.floor(clock.nowMs / 1_000));
  assert.deepEqual(body.pile, {
    current: { btc: 0, eth: 0, hemi: 0, runs: 0 },
    previous: { btc: 11, eth: 25, hemi: 34, runs: 4 },
    allTime: { btc: 21, eth: 27, hemi: 35, runs: 5 },
  }, "every version feeds the pile");
  assert.deepEqual(body.top.map((e) => [e.player, e.score]), [[OTHER, 900], [PLAYER, 700]], "one best per player, best first; other versions do not rank");
  assert.deepEqual(body.top[0], {
    player: OTHER, score: 900, durationTicks: 999, btcFed: 1, ethFed: 20, hemiFed: 3, bestCombo: 7, sizeCenti: 222, ending: 2, epoch: 1,
    runId: keccak256(stringToHex("5:0")), txHash: keccak256(stringToHex("tx:5:0")), blockNumber: 5,
  });
  // The ledger: the current epoch first (nobody has filed in it yet), then each epoch with runs, newest first.
  assert.deepEqual(body.epochs.map((e) => [e.epoch, e.runs, e.dominant, e.sourceEpoch, e.inherited]), [
    [2, 0, 0, 1, 3],      // now: nothing fed yet; its creature inherited turbo breath from epoch 1
    [1, 4, 3, 0, 1],      // epoch 1: hemi on top (34); its creature inherited HODL jaws from epoch 0
    [0, 1, 1, null, 0],   // epoch 0: btc; nothing before it to inherit
  ]);
  assert.deepEqual(body.epochs[1].top.map((e) => [e.player, e.score, e.epoch]), [[OTHER, 900, 1], [PLAYER, 700, 1]], "epoch 1's own board: one best per player in that epoch, current version only");
  assert.deepEqual(body.epochs[2].top.map((e) => [e.player, e.score]), [[PLAYER, 500]], "a player's lower all-time run still leads the epoch it was filed in");
  assert.deepEqual(body.epochs[0].top, []);
  assert.deepEqual({ btc: body.epochs[1].btc, eth: body.epochs[1].eth, hemi: body.epochs[1].hemi }, { btc: 11, eth: 25, hemi: 34 });
  const scanned = rpc.calls.filter((c) => c.method === "eth_getLogs");
  assert.deepEqual(scanned, [{ method: "eth_getLogs", from: 3, to: 10 }], "from the deploy block to the head");
  const row = await readLeaderboardSnapshot(db, { chainId: CHAIN_ID, contractAddress: contract, gameVersion: GAME_VERSION_ID });
  assert.equal(row.cursor, 10);
  assert.equal(JSON.parse(row.snapshotJson).genesis, genesis);

  // Within 20 s: served from the cache, the node is not asked.
  const before = rpc.calls.length;
  clock.nowMs += REFRESH_INTERVAL_MS - 1_000;
  const cached = await call("/api/chain/world");
  assert.equal(cached.body.cursor, 10);
  assert.equal(rpc.calls.length, before, "throttled");

  // After 20 s: only the new blocks are scanned, and a better run replaces the player's best.
  clock.nowMs += 2_000;
  rpc.head = 12;
  rpc.add(12, 0, { player: PLAYER, score: 950, btcFed: 1, ethFed: 0, hemiFed: 0, epoch: 2 });
  const next = await call("/api/chain/world");
  assert.equal(next.body.cursor, 12);
  assert.deepEqual(rpc.calls.filter((c) => c.method === "eth_getLogs").slice(-1), [{ method: "eth_getLogs", from: 11, to: 12 }]);
  assert.deepEqual(next.body.top.map((e) => [e.player, e.score]), [[PLAYER, 950], [OTHER, 900]]);
  assert.deepEqual(next.body.pile.current, { btc: 1, eth: 0, hemi: 0, runs: 1 });
  assert.deepEqual(next.body.epochs[0].top.map((e) => [e.player, e.score]), [[PLAYER, 950]], "the current epoch's board fills as it is fed");
  assert.equal(next.body.epochs.length, 3);
  assert.equal(rpc.calls.filter((c) => c.method === "eth_call").length, 2, "the immutables are read once");

  // The ticket now inherits from the cache: epoch 2, the source is epoch 1, hemi.
  const ticket = await call("/api/chain/ticket", { method: "POST", body: {} });
  assert.equal(ticket.body.epoch, 2);
  assert.equal(ticket.body.sourceEpoch, 1);
  assert.equal(ticket.body.inherited, 3);
  assert.deepEqual(ticket.body.snapshot, { btc: 11, eth: 25, hemi: 34, runs: 4, dominant: 3 });
  assert.equal(ticket.body.snapshotHash, snapshotHashOf(2n, 1n, { btc: 11n, eth: 25n, hemi: 34n }));
  const issued = await readRunTicket(db, ticket.body.runId);
  assert.deepEqual([issued.epoch, issued.sourceEpoch, issued.inherited], [2, 1, 3]);
  void env;
});

test("world scans only to head − DNFI_CONFIRMATIONS (default 16), and a malformed value is a server fault", async (t) => {
  const contract = nextContract();
  const rpc = fakeRpc({ contract, genesis: 0, epochSeconds: 86_400, head: 100 });
  const { call, env, clock } = await harness(t, { env: { DNFI_CONTRACT_ADDRESS: contract, DNFI_DEPLOY_BLOCK: "10" }, rpc });
  delete env.DNFI_CONFIRMATIONS;
  assert.equal(DEFAULT_CONFIRMATIONS, 16);
  rpc.add(84, 0, { player: PLAYER, score: 1, epoch: 0 });
  rpc.add(85, 0, { player: OTHER, score: 2, epoch: 0 });
  const first = await call("/api/chain/world");
  assert.equal(first.status, 200);
  assert.equal(first.body.cursor, 84, "16 blocks behind the head");
  assert.deepEqual(rpc.calls.filter((c) => c.method === "eth_getLogs").map((c) => [c.from, c.to]), [[10, 84]]);
  assert.deepEqual(first.body.top.map((e) => e.score), [1], "the unconfirmed block is not on the board yet");

  clock.nowMs += REFRESH_INTERVAL_MS + 1_000;
  rpc.head = 100;
  const same = await call("/api/chain/world");
  assert.equal(same.body.cursor, 84, "nothing new to scan: the cursor holds");
  assert.equal(same.body.stale, false);
  assert.equal(rpc.calls.filter((c) => c.method === "eth_getLogs").length, 1, "no empty range is asked for");

  clock.nowMs += REFRESH_INTERVAL_MS + 1_000;
  rpc.head = 101;
  const next = await call("/api/chain/world");
  assert.equal(next.body.cursor, 85);
  assert.deepEqual(rpc.calls.filter((c) => c.method === "eth_getLogs").map((c) => [c.from, c.to]).at(-1), [85, 85]);
  assert.deepEqual(next.body.top.map((e) => e.score), [2, 1]);

  // Fewer confirmations than the deploy block is behind the head: nothing scanned, the cursor parks before the deploy block.
  const young = nextContract();
  const youngRpc = fakeRpc({ contract: young, genesis: 0, epochSeconds: 86_400, head: 12 });
  const h2 = await harness(t, { env: { DNFI_CONTRACT_ADDRESS: young, DNFI_DEPLOY_BLOCK: "10", DNFI_CONFIRMATIONS: "5" }, rpc: youngRpc });
  const parked = await h2.call("/api/chain/world");
  assert.equal(parked.body.cursor, 9);
  assert.equal(youngRpc.calls.filter((c) => c.method === "eth_getLogs").length, 0);

  env.DNFI_CONFIRMATIONS = "-1";
  const malformed = await call("/api/chain/world");
  assert.equal(malformed.status, 503);
  assert.equal(malformed.body.error.code, "unavailable");
  env.DNFI_CONFIRMATIONS = "sixteen";
  assert.equal((await call("/api/chain/world")).status, 503);
  env.DNFI_CONFIRMATIONS = "0";
  clock.nowMs += REFRESH_INTERVAL_MS + 1_000;
  assert.equal((await call("/api/chain/world")).body.cursor, 101, "zero scans to the head (the local e2e)");
});

test("world refreshes under a lease: two concurrent calls make one scan, the other serves the cache", async (t) => {
  const contract = nextContract();
  const rpc = fakeRpc({ contract, genesis: START_MS / 1_000 - 50, epochSeconds: 86_400, head: 5 });
  const { call, db, clock } = await harness(t, { env: { DNFI_CONTRACT_ADDRESS: contract }, rpc });
  rpc.add(3, 0, { player: PLAYER, score: 77, btcFed: 2, epoch: 0 });
  // Hold every eth_getLogs until the test lets go, so the second call surely overlaps the first's scan.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  rpc.before = async (request) => { if (request.method === "eth_getLogs") await gate; };
  const pending = Promise.all([call("/api/chain/world"), call("/api/chain/world")]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const key = { chainId: CHAIN_ID, contractAddress: contract, gameVersion: GAME_VERSION_ID };
  const leased = await readLeaderboardSnapshot(db, key);
  assert.equal(leased.refreshLeaseUntil, clock.nowMs + REFRESH_LEASE_MS, "the placeholder row carries the lease while the scan runs");
  assert.equal(leased.updatedAt, 0);
  release();
  const [a, b] = await pending;
  const scanned = a.body.cursor === 5 ? a : b;
  const served = scanned === a ? b : a;
  assert.equal(scanned.status, 200);
  assert.equal(scanned.body.stale, false);
  assert.deepEqual(scanned.body.top.map((e) => e.score), [77]);
  assert.equal(served.status, 200);
  assert.equal(served.body.stale, true, "the one without the lease serves the (empty, never-written) cache");
  assert.equal(served.body.cursor, -1);
  assert.deepEqual(served.body.top, []);
  assert.equal(rpc.calls.filter((c) => c.method === "eth_getLogs").length, 1, "one scan for two calls");
  assert.equal((await readLeaderboardSnapshot(db, key)).refreshLeaseUntil, 0, "released after the scan");

  // Within the interval the cache is served without a claim; after it, the lease is free and the next call scans.
  const calls = rpc.calls.length;
  clock.nowMs += REFRESH_INTERVAL_MS - 1_000;
  assert.deepEqual((await call("/api/chain/world")).body.top.map((e) => e.score), [77]);
  assert.equal(rpc.calls.length, calls);
  clock.nowMs += 2_000;
  rpc.head = 6;
  assert.equal((await call("/api/chain/world")).body.cursor, 6);
  assert.equal(rpc.calls.filter((c) => c.method === "eth_getLogs").length, 2);

  // A failed scan keeps the lease until the retry time, so no other isolate hits the dead node meanwhile.
  clock.nowMs += REFRESH_INTERVAL_MS + 1_000;
  rpc.down.add("http://rpc.test/").add("http://rpc-fallback.test/");
  const failed = await call("/api/chain/world");
  assert.equal(failed.body.stale, true);
  assert.equal((await readLeaderboardSnapshot(db, key)).refreshLeaseUntil, clock.nowMs + REFRESH_INTERVAL_MS, "held for one interval");
  const attempts = rpc.calls.length;
  clock.nowMs += REFRESH_INTERVAL_MS - 1_000;
  rpc.down.clear();
  const held = await call("/api/chain/world");
  assert.equal(held.body.stale, true, "still under the failed lease: the cache, marked stale");
  assert.equal(held.body.cursor, 6, "the last good snapshot");
  assert.equal(rpc.calls.length, attempts, "no RPC call under another holder's lease");
  clock.nowMs += 2_000;
  assert.equal((await call("/api/chain/world")).body.stale, false, "and it recovers once the lease has passed");
});

test("world serves the cached snapshot with stale: true when the node is down, and uses the fallback URL", async (t) => {
  const contract = nextContract();
  const rpc = fakeRpc({ contract, genesis: START_MS / 1_000 - 50, epochSeconds: 86_400, head: 2 });
  const { call, clock } = await harness(t, { env: { DNFI_CONTRACT_ADDRESS: contract }, rpc });
  rpc.add(1, 0, { player: PLAYER, score: 42, btcFed: 1, epoch: 0 });

  rpc.down.add("http://rpc.test/");
  const viaFallback = await call("/api/chain/world");
  assert.equal(viaFallback.status, 200);
  assert.equal(viaFallback.body.stale, false, "the fallback URL answered");
  assert.equal(viaFallback.body.top[0].score, 42);
  const updatedAt = viaFallback.body.updatedAt;

  clock.nowMs += REFRESH_INTERVAL_MS + 1_000;
  rpc.down.add("http://rpc-fallback.test/");
  const stale = await call("/api/chain/world");
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.updatedAt, updatedAt, "the age of the cached snapshot is reported");
  assert.equal(stale.body.cursor, 2);
  assert.equal(stale.body.top[0].score, 42, "the cached board is still served");
  assert.deepEqual(stale.body.pile.allTime, { btc: 1, eth: 0, hemi: 0, runs: 1 });
  assert.equal(stale.body.epoch, 0, "the epoch still comes from the cached immutables");

  // A ticket still issues while the node is down.
  const ticket = await call("/api/chain/ticket", { method: "POST", body: {} });
  assert.equal(ticket.status, 200);
  assert.equal(ticket.body.epoch, 0);

  // The failure is remembered for 20 s, then retried.
  const attempts = rpc.calls.length;
  await call("/api/chain/world");
  assert.equal(rpc.calls.length, attempts, "a dead node is not hit on every request");
  clock.nowMs += REFRESH_INTERVAL_MS + 1_000;
  rpc.down.clear();
  const back = await call("/api/chain/world");
  assert.equal(back.body.stale, false);
});

test("world with nothing cached and no node is empty, stale and still issues tickets", async (t) => {
  const contract = nextContract();
  const rpc = fakeRpc({ contract, genesis: 0, epochSeconds: 86_400 });
  rpc.down.add("http://rpc.test/").add("http://rpc-fallback.test/");
  const { call } = await harness(t, { env: { DNFI_CONTRACT_ADDRESS: contract }, rpc });
  const { status, body } = await call("/api/chain/world");
  assert.equal(status, 200);
  assert.deepEqual(body, {
    gameVersionId: GAME_VERSION_ID, epoch: null, epochSeconds: 86_400, genesis: null, sourceEpoch: null, inherited: 0,
    pile: { current: { btc: 0, eth: 0, hemi: 0, runs: 0 }, previous: { btc: 0, eth: 0, hemi: 0, runs: 0 }, allTime: { btc: 0, eth: 0, hemi: 0, runs: 0 } },
    top: [], epochs: [], updatedAt: 0, cursor: -1, stale: true,
  });
  assert.deepEqual(await call("/api/chain/world").then((r) => r.body), body, "a second call under the failed lease says the same");
  const ticket = await call("/api/chain/ticket", { method: "POST", body: {} });
  assert.equal(ticket.status, 200);
  assert.equal(ticket.body.epoch, 0);
});

test("world scans in batches of at most 2,000 blocks and at most 20,000 per refresh", async (t) => {
  const contract = nextContract();
  const rpc = fakeRpc({ contract, genesis: 0, epochSeconds: 86_400, head: 45_000 });
  const { call, clock } = await harness(t, { env: { DNFI_CONTRACT_ADDRESS: contract, DNFI_DEPLOY_BLOCK: "1000" }, rpc });
  rpc.add(1_500, 0, { player: PLAYER, score: 1, epoch: 0 });
  rpc.add(20_999, 0, { player: OTHER, score: 2, epoch: 0 });
  rpc.add(21_000, 0, { player: OTHER, score: 3, epoch: 0 });
  rpc.add(44_000, 0, { player: PLAYER, score: 4, epoch: 0 });

  const first = await call("/api/chain/world");
  assert.equal(first.body.cursor, 1000 + MAX_BLOCKS_PER_REFRESH - 1);
  assert.equal(first.body.stale, true, "a bounded scan is incomplete until it reaches the confirmed head");
  const ranges = rpc.calls.filter((c) => c.method === "eth_getLogs").map((c) => [c.from, c.to]);
  assert.equal(ranges.length, MAX_BLOCKS_PER_REFRESH / LOG_BATCH_BLOCKS);
  assert.deepEqual(ranges[0], [1000, 2999]);
  assert.deepEqual(ranges.at(-1), [19_000, 20_999]);
  assert.ok(ranges.every(([from, to]) => to - from + 1 <= LOG_BATCH_BLOCKS));
  assert.deepEqual(first.body.top.map((e) => e.score), [2, 1]);
  const cached = await call("/api/chain/world");
  assert.equal(cached.body.stale, true, "the persisted catch-up status survives a cached response");
  assert.equal(rpc.calls.filter((c) => c.method === "eth_getLogs").length, ranges.length, "the cached response still respects the refresh throttle");

  clock.nowMs += REFRESH_INTERVAL_MS + 1_000;
  const second = await call("/api/chain/world");
  assert.equal(second.body.cursor, 40_999);
  assert.equal(second.body.stale, true);
  assert.deepEqual(second.body.top.map((e) => e.score), [3, 1]);

  clock.nowMs += REFRESH_INTERVAL_MS + 1_000;
  const third = await call("/api/chain/world");
  assert.equal(third.body.cursor, 45_000);
  assert.equal(third.body.stale, false);
  assert.deepEqual(third.body.top.map((e) => e.score), [4, 3]);
  assert.equal(third.body.pile.allTime.runs, 4);
});

test("filing verification accepts events only from the expected registry and requested run", () => {
  const registry = nextContract();
  const impostor = nextContract();
  const runId = `0x${"ab".repeat(32)}`;
  const otherRunId = `0x${"cd".repeat(32)}`;
  const genuine = recordedLog(registry, 1, 0, { runId, player: PLAYER, score: 1 });
  const forged = recordedLog(impostor, 1, 1, { runId, player: PLAYER, score: 999 });
  const otherRun = recordedLog(registry, 1, 2, { runId: otherRunId, player: OTHER, score: 2 });
  assert.deepEqual(recordedEventsIn([forged], registry, runId), [], "an event with the same ABI from another contract proves nothing");
  const selected = recordedEventsIn([forged, genuine, otherRun], registry, runId);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].runId, runId);
  assert.equal(selected[0].score, 1n);
  assert.equal(recordedEventsIn([genuine, otherRun], registry).length, 2, "an ambiguous transaction must not silently select its last event");
});

test("world keeps the top 25 and ranks ties by who filed first", async (t) => {
  const contract = nextContract();
  const rpc = fakeRpc({ contract, genesis: 0, epochSeconds: 86_400, head: 100 });
  const { call } = await harness(t, { env: { DNFI_CONTRACT_ADDRESS: contract }, rpc });
  for (let i = 0; i < 30; i++) rpc.add(10 + i, 0, { player: `0x${(i + 1).toString(16).padStart(40, "0")}`, score: 1000 - i, epoch: 0 });
  rpc.add(50, 0, { player: `0x${"ee".repeat(20)}`, score: 1000, epoch: 0 });
  const { body } = await call("/api/chain/world");
  assert.equal(body.top.length, 25);
  assert.equal(body.top[0].player.toLowerCase(), `0x${"1".padStart(40, "0")}`, "the earlier 1000 ranks first");
  assert.equal(body.top[1].player.toLowerCase(), `0x${"ee".repeat(20)}`, "players come back checksummed");
  assert.equal(body.top.at(-1).score, 977);
  assert.equal(body.pile.allTime.runs, 31);
});

test("the trace behind an attestation is kept for good and served for anyone to replay", async (t) => {
  const { call, db, clock } = await harness(t);
  const trace = fixtures.traces.find((x) => x.inherited === "metal") ?? plainTrace;
  const { runId, snapshotHash } = await fixtureTicket(db, trace, clock.nowMs);
  const missing = await call(`/api/chain/trace?runId=${runId}`);
  assert.equal(missing.status, 404, "nothing before the attestation");
  assert.equal((await call("/api/chain/trace?runId=0x12")).status, 400, "a malformed run id");
  const attested = await call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace) });
  assert.equal(attested.status, 200);
  const served = await call(`/api/chain/trace?runId=${runId}`);
  assert.equal(served.status, 200);
  assert.equal(served.response.headers.get("Cache-Control"), "public, max-age=300");
  const body = served.body;
  assert.equal(body.runId, runId);
  assert.equal(body.seed, trace.seed);
  assert.equal(body.inherited, codeOf(trace));
  assert.equal(body.trait, trace.inherited ?? null);
  assert.equal(body.endTick, trace.endTick);
  assert.deepEqual(body.commands, trace.commands, "the commands decode back to what was attested");
  assert.equal(body.traceHash.toLowerCase(), traceHash(trace.commands, trace.endTick).toLowerCase());
  assert.equal(keccak256(body.trace).toLowerCase(), body.traceHash.toLowerCase(), "the bytes hash to the trace hash the contract holds");
  assert.equal(body.snapshotHash.toLowerCase(), snapshotHash.toLowerCase());
  assert.equal(snapshotHashOf(BigInt(body.snapshot.epoch), BigInt(body.snapshot.sourceEpoch ?? 0), { btc: BigInt(body.snapshot.btc), eth: BigInt(body.snapshot.eth), hemi: BigInt(body.snapshot.hemi) }).toLowerCase(), body.snapshotHash.toLowerCase(), "the snapshot preimage recomputes the hash");
  assert.deepEqual(body.attested, attested.body.result, "what the verifier attested from it");
  // A repeat attestation (re-dated) never changes the kept trace; another wallet is refused and changes nothing either.
  clock.nowMs += 19 * 60_000;
  assert.equal((await call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace, OTHER) })).status, 409);
  const again = await call("/api/chain/attest", { method: "POST", body: attestBody(runId, trace) });
  assert.equal(again.status, 200);
  assert.notEqual(again.body.verifierSignature, attested.body.verifierSignature, "re-dated");
  const after = (await call(`/api/chain/trace?runId=${runId}`)).body;
  assert.equal(after.trace, body.trace);
  assert.equal(after.storedAt, body.storedAt);
  assert.deepEqual(after.attested, body.attested, "the first attestation stays the record; the chain has the rest");
  // The trace outlives the ticket's sweep.
  clock.nowMs += 2 * 60 * 60_000;
  await call("/api/chain/ticket", { method: "POST", body: {} });
  assert.equal((await call(`/api/chain/trace?runId=${runId}`)).status, 200, "kept after the ticket is gone");
  for (let i = 0; i < 60; i++) await call(`/api/chain/trace?runId=${runId}`);
  assert.equal((await call(`/api/chain/trace?runId=${runId}`)).status, 429, "rate limited at 60 a minute");
});

test("world re-indexes a snapshot of an older shape from the deploy block instead of failing", async (t) => {
  const contract = nextContract();
  const epochSeconds = 3_600;
  const genesis = START_MS / 1_000 - epochSeconds - 100;
  const rpc = fakeRpc({ contract, genesis, epochSeconds, head: 9 });
  const { call, db } = await harness(t, { env: { DNFI_CONTRACT_ADDRESS: contract, DNFI_DEPLOY_BLOCK: "3" }, rpc });
  rpc.add(4, 0, { player: PLAYER, score: 500, btcFed: 10, ethFed: 2, hemiFed: 1, epoch: 0 });
  rpc.add(8, 0, { player: OTHER, score: 800, btcFed: 1, ethFed: 9, hemiFed: 1, epoch: 1 });
  // A version-1 row far ahead (cursor 50): the monotonic cursor guard alone would refuse anything lower.
  const old = { version: 1, genesis, epochSeconds, cursor: 50, top: [], piles: { 0: { btc: 99, eth: 0, hemi: 0, runs: 9 } }, allTime: { btc: 99, eth: 0, hemi: 0, runs: 9 } };
  await writeLeaderboardSnapshot(db, { chainId: CHAIN_ID, contractAddress: contract, gameVersion: GAME_VERSION_ID, cursor: 50, snapshotJson: JSON.stringify(old), updatedAt: 1 });
  const ticketBefore = await call("/api/chain/ticket", { method: "POST", body: {} });
  assert.equal(ticketBefore.status, 200, "an outdated row never breaks a ticket: it reads as empty");
  const { status, body } = await call("/api/chain/world");
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.cursor, 9, "re-scanned from the deploy block to the head");
  assert.deepEqual(rpc.calls.filter((c) => c.method === "eth_getLogs"), [{ method: "eth_getLogs", from: 3, to: 9 }]);
  assert.deepEqual(body.pile.allTime, { btc: 11, eth: 11, hemi: 2, runs: 2 }, "the old totals are gone, the chain's are back");
  assert.deepEqual(body.epochs.map((e) => [e.epoch, e.top.map((x) => x.score)]), [[1, [800]], [0, [500]]]);
  const row = await readLeaderboardSnapshot(db, { chainId: CHAIN_ID, contractAddress: contract, gameVersion: GAME_VERSION_ID });
  assert.equal(JSON.parse(row.snapshotJson).version, 2);
  assert.equal(row.cursor, 9);
});
