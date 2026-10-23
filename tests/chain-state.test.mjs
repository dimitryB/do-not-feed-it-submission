import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { Miniflare } from "miniflare";

import {
  claimRefreshLease,
  clearLeaderboardSnapshot,
  consumeRateLimit,
  issueRunTicket,
  readLeaderboardSnapshot,
  readRunTicket,
  refreshAttestation,
  releaseRefreshLease,
  storeAttestation,
  writeLeaderboardSnapshot,
} from "../db/chainState.ts";

/** Every migration under drizzle/, in order, as production applies them. */
async function applyMigrations(db) {
  const dir = new URL("../drizzle/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  assert.deepEqual(files, ["0000_dnfi_chain_state.sql", "0001_dnfi_chain_v1.sql", "0002_dnfi_chain_v2.sql", "0003_dnfi_chain_traces.sql"], "the migrations this test knows");
  for (const file of files) {
    const migration = await readFile(new URL(file, dir), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await db.prepare(statement).run();
    }
  }
}

async function testDatabase() {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: crypto.randomUUID() },
  });
  const db = await miniflare.getD1Database("DB");
  await applyMigrations(db);
  return { db, miniflare };
}

const TICKET = { gameVersion: "0xversion", epoch: 3, snapshotHash: "0xsnapshot", sourceEpoch: 2, inherited: 1, snapshotJson: "{\"epoch\":3,\"sourceEpoch\":2,\"btc\":\"5\",\"eth\":\"1\",\"hemi\":\"0\",\"runs\":\"2\"}" };
const KEY = { chainId: 43111, contractAddress: "0xABC", gameVersion: "0xV5" };
const ATTEST = { payloadHash: "0xaaa", verifierSignature: "0xsignature-one", attestedAt: 1_500, player: "0xplayer", resultJson: '{"score":"1"}', keepUntil: 1_500 + 3_600 };

test("run tickets keep their issue-time fields (the inherited world included) and one idempotent attestation", async (t) => {
  const { db, miniflare } = await testDatabase();
  t.after(() => miniflare.dispose());

  await issueRunTicket(db, { runId: "run-1", issuedAt: 1_000, seed: "seed-1", expiresAt: 2_000, ...TICKET });
  const issued = await readRunTicket(db, "run-1");
  assert.equal(issued?.seed, "seed-1");
  assert.equal(issued?.gameVersion, "0xversion");
  assert.equal(issued?.epoch, 3);
  assert.equal(issued?.snapshotHash, "0xsnapshot");
  assert.equal(issued?.sourceEpoch, 2);
  assert.equal(issued?.inherited, 1);
  assert.equal(issued?.player, null);
  assert.equal(issued?.resultJson, null);

  await issueRunTicket(db, { runId: "run-none", issuedAt: 1_000, seed: "s", expiresAt: 2_000, ...TICKET, sourceEpoch: null, inherited: 0 });
  assert.equal((await readRunTicket(db, "run-none"))?.sourceEpoch, null, "nothing inherited is a null source epoch");
  assert.equal((await readRunTicket(db, "run-none"))?.inherited, 0);

  const first = await storeAttestation(db, { runId: "run-1", ...ATTEST });
  const retry = await storeAttestation(db, { runId: "run-1", ...ATTEST, verifierSignature: "0xsignature-two", attestedAt: 1_501, resultJson: '{"score":"2"}' });

  assert.equal(first.status, "stored");
  assert.equal(first.record.verifierSignature, "0xsignature-one");
  assert.equal(first.record.resultJson, '{"score":"1"}');
  assert.equal(first.record.player, "0xplayer");
  assert.equal(first.record.attestedAt, 1_500);
  assert.deepEqual(retry, first, "the second same-payload write returns the first result and signature");
  assert.equal((await readRunTicket(db, "run-1"))?.attestedAt, 1_500);
});

test("the first attestation keeps the row alive until keepUntil, never shortening it", async (t) => {
  const { db, miniflare } = await testDatabase();
  t.after(() => miniflare.dispose());

  await issueRunTicket(db, { runId: "short", issuedAt: 1_000, seed: "s", expiresAt: 2_000, ...TICKET });
  await storeAttestation(db, { runId: "short", ...ATTEST, keepUntil: 5_100 });
  assert.equal((await readRunTicket(db, "short"))?.expiresAt, 5_100, "extended to keepUntil");

  await issueRunTicket(db, { runId: "long", issuedAt: 1_000, seed: "s", expiresAt: 9_000, ...TICKET });
  await storeAttestation(db, { runId: "long", ...ATTEST, keepUntil: 5_100 });
  assert.equal((await readRunTicket(db, "long"))?.expiresAt, 9_000, "a later expiry is kept");

  // The extension survives the sweep a later ticket runs, and a repeat sees the same row.
  await issueRunTicket(db, { runId: "sweeper", issuedAt: 4_000, seed: "s", expiresAt: 5_000, ...TICKET });
  assert.ok(await readRunTicket(db, "short"), "still there after a sweep at 4,000");
  assert.deepEqual(await storeAttestation(db, { runId: "short", ...ATTEST, attestedAt: 4_500, keepUntil: 9_999 }), await storeAttestation(db, { runId: "short", ...ATTEST, attestedAt: 4_500, keepUntil: 9_999 }));
  assert.equal((await readRunTicket(db, "short"))?.expiresAt, 5_100, "only the first store extends");
});

test("a run ticket cannot attest a different payload", async (t) => {
  const { db, miniflare } = await testDatabase();
  t.after(() => miniflare.dispose());

  await issueRunTicket(db, { runId: "run-2", issuedAt: 1_000, seed: "seed-2", expiresAt: 2_000, ...TICKET });
  await storeAttestation(db, { runId: "run-2", ...ATTEST, player: "0xp1", resultJson: "{}" });

  assert.deepEqual(
    await storeAttestation(db, { runId: "run-2", ...ATTEST, payloadHash: "0xbbb", verifierSignature: "0xsignature-two", attestedAt: 1_501, player: "0xp2", resultJson: "{}" }),
    { status: "conflict" },
  );
  assert.equal((await readRunTicket(db, "run-2"))?.player, "0xp1", "the loser's player is not written");
});

test("the same payload from another player is reported with the row, and refreshAttestation swaps it in by CAS", async (t) => {
  const { db, miniflare } = await testDatabase();
  t.after(() => miniflare.dispose());

  await issueRunTicket(db, { runId: "run-4", issuedAt: 1_000, seed: "s", expiresAt: 2_000, ...TICKET });
  await storeAttestation(db, { runId: "run-4", ...ATTEST, player: "0xp1" });
  const lost = await storeAttestation(db, { runId: "run-4", ...ATTEST, verifierSignature: "0xsignature-p2", player: "0xp2", resultJson: '{"player":"p2"}' });
  assert.equal(lost.status, "stored");
  assert.equal(lost.record.player, "0xp1", "the store reports who holds the row");

  const swapped = await refreshAttestation(db, {
    runId: "run-4", payloadHash: "0xaaa", previousSignature: "0xsignature-one", verifierSignature: "0xsignature-p2",
    attestedAt: 1_600, player: "0xp2", resultJson: '{"player":"p2"}',
  });
  assert.equal(swapped?.verifierSignature, "0xsignature-p2");
  assert.equal(swapped?.player, "0xp2");
  assert.equal(swapped?.resultJson, '{"player":"p2"}');
  assert.equal(swapped?.attestedAt, 1_600);
  assert.equal(swapped?.payloadHash, "0xaaa", "the payload never changes");

  const stale = await refreshAttestation(db, {
    runId: "run-4", payloadHash: "0xaaa", previousSignature: "0xsignature-one", verifierSignature: "0xsignature-p3",
    attestedAt: 1_700, player: "0xp3", resultJson: "{}",
  });
  assert.equal(stale?.verifierSignature, "0xsignature-p2", "a CAS on a signature that is no longer there changes nothing");
  assert.equal(stale?.player, "0xp2");
  const wrongPayload = await refreshAttestation(db, {
    runId: "run-4", payloadHash: "0xbbb", previousSignature: "0xsignature-p2", verifierSignature: "0xsignature-p3",
    attestedAt: 1_700, player: "0xp3", resultJson: "{}",
  });
  assert.equal(wrongPayload?.verifierSignature, "0xsignature-p2", "another payload cannot replace it either");
  const expired = await refreshAttestation(db, {
    runId: "run-4", payloadHash: "0xaaa", previousSignature: "0xsignature-p2", verifierSignature: "0xsignature-p3",
    attestedAt: 99_999, player: "0xp3", resultJson: "{}",
  });
  assert.equal(expired?.verifierSignature, "0xsignature-p2", "nor past the row's expiry");
});

test("an expired or unknown ticket stores nothing", async (t) => {
  const { db, miniflare } = await testDatabase();
  t.after(() => miniflare.dispose());

  await issueRunTicket(db, { runId: "run-3", issuedAt: 1_000, seed: "seed-3", expiresAt: 2_000, ...TICKET });
  const late = { runId: "run-3", ...ATTEST, attestedAt: 2_001, keepUntil: 9_000 };
  assert.deepEqual(await storeAttestation(db, late), { status: "missing" });
  assert.deepEqual(await storeAttestation(db, { ...late, runId: "run-nope", attestedAt: 1_500 }), { status: "missing" });
  assert.equal((await readRunTicket(db, "run-3"))?.verifierSignature, null);
  assert.equal((await readRunTicket(db, "run-3"))?.expiresAt, 2_000, "a refused store does not extend the row");
});

test("issuing a ticket sweeps expired tickets", async (t) => {
  const { db, miniflare } = await testDatabase();
  t.after(() => miniflare.dispose());

  await issueRunTicket(db, { runId: "old", issuedAt: 1_000, seed: "s", expiresAt: 2_000, ...TICKET });
  await issueRunTicket(db, { runId: "new", issuedAt: 2_001, seed: "s", expiresAt: 3_000, ...TICKET });
  assert.equal(await readRunTicket(db, "old"), null);
  assert.ok(await readRunTicket(db, "new"));
});

test("rate limits are shared fixed-window counters", async (t) => {
  const { db, miniflare } = await testDatabase();
  t.after(() => miniflare.dispose());

  assert.equal(await consumeRateLimit(db, { bucketKey: "attest:ip", limit: 2, nowMs: 10_000 }), true);
  assert.equal(await consumeRateLimit(db, { bucketKey: "attest:ip", limit: 2, nowMs: 11_000 }), true);
  assert.equal(await consumeRateLimit(db, { bucketKey: "attest:ip", limit: 2, nowMs: 12_000 }), false);
  assert.equal(await consumeRateLimit(db, { bucketKey: "attest:ip", limit: 2, nowMs: 61_000 }), true);
});

test("world snapshots are keyed by chain, contract and version and never move their cursor backwards", async (t) => {
  const { db, miniflare } = await testDatabase();
  t.after(() => miniflare.dispose());

  await writeLeaderboardSnapshot(db, { ...KEY, cursor: 20, snapshotJson: '{"version":2}', updatedAt: 2 });
  await writeLeaderboardSnapshot(db, { ...KEY, contractAddress: "0xabc", gameVersion: "0xv5", cursor: 10, snapshotJson: '{"version":1}', updatedAt: 3 });
  assert.deepEqual(await readLeaderboardSnapshot(db, { ...KEY, contractAddress: "0xAbC" }), {
    cursor: 20, snapshotJson: '{"version":2}', updatedAt: 2, refreshLeaseUntil: 0,
  });

  await writeLeaderboardSnapshot(db, { ...KEY, cursor: 20, snapshotJson: '{"version":3}', updatedAt: 4 });
  assert.equal((await readLeaderboardSnapshot(db, KEY))?.updatedAt, 4, "an equal cursor still refreshes the row");

  await writeLeaderboardSnapshot(db, { ...KEY, chainId: 31337, cursor: 5, snapshotJson: '{"local":true}', updatedAt: 5 });
  await writeLeaderboardSnapshot(db, { ...KEY, gameVersion: "0xV6", cursor: 6, snapshotJson: '{"next":true}', updatedAt: 6 });
  assert.equal((await readLeaderboardSnapshot(db, { ...KEY, chainId: 31337 }))?.cursor, 5);
  assert.equal((await readLeaderboardSnapshot(db, { ...KEY, gameVersion: "0xv6" }))?.cursor, 6);
  assert.equal((await readLeaderboardSnapshot(db, KEY))?.cursor, 20, "other chains and versions are other rows");

  await clearLeaderboardSnapshot(db, KEY);
  assert.equal(await readLeaderboardSnapshot(db, KEY), null, "clearing the row is the re-index");
  assert.equal((await readLeaderboardSnapshot(db, { ...KEY, chainId: 31337 }))?.cursor, 5);
});

test("the refresh lease is claimed once at a time per row, on a placeholder row when there is none yet", async (t) => {
  const { db, miniflare } = await testDatabase();
  t.after(() => miniflare.dispose());
  const lease = (nowMs, leaseUntilMs = nowMs + 30_000) => claimRefreshLease(db, { ...KEY, nowMs, leaseUntilMs, placeholderJson: '{"placeholder":true}' });

  assert.equal(await lease(1_000), true, "no row: the placeholder is inserted and leased");
  assert.deepEqual(await readLeaderboardSnapshot(db, KEY), { cursor: -1, snapshotJson: '{"placeholder":true}', updatedAt: 0, refreshLeaseUntil: 31_000 });
  assert.equal(await lease(2_000), false, "held");
  assert.equal(await lease(31_000), false, "held until the lease has passed");
  assert.equal(await lease(31_001), true, "then free again");

  // A real snapshot write replaces the placeholder and leaves the lease alone.
  await writeLeaderboardSnapshot(db, { ...KEY, cursor: 0, snapshotJson: '{"version":1}', updatedAt: 40 });
  assert.deepEqual(await readLeaderboardSnapshot(db, KEY), { cursor: 0, snapshotJson: '{"version":1}', updatedAt: 40, refreshLeaseUntil: 61_001 });
  assert.equal(await lease(40_000), false);

  // Releasing needs the lease one holds: a stale holder cannot free a newer lease.
  await releaseRefreshLease(db, { ...KEY, heldUntilMs: 31_000, untilMs: 0 });
  assert.equal((await readLeaderboardSnapshot(db, KEY))?.refreshLeaseUntil, 61_001, "the old holder's release is ignored");
  await releaseRefreshLease(db, { ...KEY, heldUntilMs: 61_001, untilMs: 0 });
  assert.equal((await readLeaderboardSnapshot(db, KEY))?.refreshLeaseUntil, 0);
  assert.equal(await lease(40_001), true, "free right after the release");
  await releaseRefreshLease(db, { ...KEY, heldUntilMs: 70_001, untilMs: 50_000 });
  assert.equal(await lease(49_999), false, "a shortened lease still holds until its new time");
  assert.equal(await lease(50_001), true);

  // Rows are independent; a concurrent pair resolves to exactly one holder.
  const both = await Promise.all([lease(90_000), lease(90_000)]);
  assert.deepEqual(both.sort(), [false, true]);
  assert.equal(await claimRefreshLease(db, { ...KEY, chainId: 1, nowMs: 90_000, leaseUntilMs: 99_000, placeholderJson: "{}" }), true, "another chain is another lease");
});
