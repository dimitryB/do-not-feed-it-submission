import { blob, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Server-issued run tickets and their optional verifier attestation.
 *
 * Keeping the attestation on the ticket makes `/api/chain/attest` idempotent:
 * a lost HTTP response can return the exact signature that was already issued,
 * while a different payload cannot reuse the same run ID. The trace itself is
 * never stored; `result_json` is the small signed RunResult, kept so a repeat
 * of the same payload returns the same result and signature without a replay.
 *
 * `game_version`, `epoch`, `snapshot_hash`, `source_epoch` and `inherited`
 * are set at issue (docs/CHAIN.md §6–7, §10.3); `player` and `result_json`
 * at attest. They are nullable only because SQLite cannot add NOT NULL
 * columns to a live table; a ticket without a version or snapshot hash never
 * attests (its version cannot match), and a null `inherited` reads as 0.
 */
export const dnfiRunTickets = sqliteTable(
  "dnfi_run_tickets",
  {
    runId: text("run_id").primaryKey(),
    issuedAt: integer("issued_at").notNull(),
    seed: text("seed").notNull(),
    expiresAt: integer("expires_at").notNull(),
    payloadHash: text("payload_hash"),
    verifierSignature: text("verifier_signature"),
    attestedAt: integer("attested_at"),
    gameVersion: text("game_version"),
    epoch: integer("epoch"),
    snapshotHash: text("snapshot_hash"),
    player: text("player"),
    resultJson: text("result_json"),
    /** The epoch whose pile the creature inherits; null when nothing is inherited. */
    sourceEpoch: integer("source_epoch"),
    /** The inherited trait: 0 none, 1 btc, 2 eth, 3 hemi. */
    inherited: integer("inherited"),
    /** JSON preimage of `snapshot_hash` (epoch, sourceEpoch, btc, eth, hemi, runs); null before migration 0003. */
    snapshotJson: text("snapshot_json"),
  },
  (table) => [index("idx_dnfi_run_tickets_expires_at").on(table.expiresAt)],
);

/** One fixed-window counter per route/IP/minute. */
export const dnfiRateLimits = sqliteTable(
  "dnfi_rate_limits",
  {
    bucketKey: text("bucket_key").notNull(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "pk_dnfi_rate_limits_bucket_window",
      columns: [table.bucketKey, table.windowStart],
    }),
    index("idx_dnfi_rate_limits_expires_at").on(table.expiresAt),
  ],
);

/**
 * Durable cursor plus JSON snapshot for the event-indexed world (leaderboard
 * and pile), one row per chain, contract and game version. The cursor is the
 * last block fully scanned; clearing the row re-indexes from the deploy block.
 * `refresh_lease_until` (unix ms) is the cross-isolate refresh lease: one
 * Worker at a time scans the chain for a row.
 */
export const dnfiLeaderboardSnapshots = sqliteTable(
  "dnfi_leaderboard_snapshots",
  {
    chainId: integer("chain_id").notNull(),
    contractAddress: text("contract_address").notNull(),
    gameVersion: text("game_version").notNull(),
    cursor: integer("cursor").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    updatedAt: integer("updated_at").notNull(),
    refreshLeaseUntil: integer("refresh_lease_until").notNull().default(0),
  },
  (table) => [
    primaryKey({
      name: "pk_dnfi_leaderboard_snapshots",
      columns: [table.chainId, table.contractAddress, table.gameVersion],
    }),
  ],
);

/**
 * The trace behind every attestation, kept for good: the canonical bytes
 * whose keccak is the `traceHash` the contract records, with everything
 * needed to replay it (seed, trait, the snapshot's preimage) and what was
 * attested from it. Immutable; never swept.
 */
export const dnfiRunTraces = sqliteTable(
  "dnfi_run_traces",
  {
    runId: text("run_id").primaryKey(),
    gameVersion: text("game_version").notNull(),
    seed: text("seed").notNull(),
    inherited: integer("inherited").notNull(),
    epoch: integer("epoch").notNull(),
    sourceEpoch: integer("source_epoch"),
    snapshotJson: text("snapshot_json").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    endTick: integer("end_tick").notNull(),
    traceHash: text("trace_hash").notNull(),
    trace: blob("trace", { mode: "buffer" }).notNull(),
    resultJson: text("result_json").notNull(),
    storedAt: integer("stored_at").notNull(),
  },
  (table) => [index("idx_dnfi_run_traces_stored_at").on(table.storedAt)],
);
