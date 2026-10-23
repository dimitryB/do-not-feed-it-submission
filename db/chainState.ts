/**
 * The Worker's D1 state: run tickets with their one attestation, the shared
 * rate-limit counters and the indexed world snapshot. Raw prepared statements
 * on purpose (small, explicit and easy to audit); the drizzle
 * definitions in `schema.ts` describe the same tables for the migrations.
 */
export type D1Value = string | number | null | ArrayBuffer | ArrayBufferView;

export interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results?: T[];
  meta?: { changes?: number };
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<Array<D1Result<T>>>;
}

interface RunTicketRow {
  run_id: string;
  issued_at: number;
  seed: string;
  expires_at: number;
  payload_hash: string | null;
  verifier_signature: string | null;
  attested_at: number | null;
  game_version: string | null;
  epoch: number | null;
  snapshot_hash: string | null;
  player: string | null;
  result_json: string | null;
  source_epoch: number | null;
  inherited: number | null;
  snapshot_json: string | null;
}

export interface RunTicketRecord {
  runId: string;
  issuedAt: number;
  seed: string;
  expiresAt: number;
  payloadHash: string | null;
  verifierSignature: string | null;
  attestedAt: number | null;
  gameVersion: string | null;
  epoch: number | null;
  snapshotHash: string | null;
  player: string | null;
  resultJson: string | null;
  /** The epoch whose pile the creature inherits; null when nothing is inherited. */
  sourceEpoch: number | null;
  /** 0 none, 1 btc, 2 eth, 3 hemi; null on a row issued before migration 0002 (reads as 0). */
  inherited: number | null;
  /** The snapshot hash's preimage as JSON (epoch, sourceEpoch, btc, eth, hemi, runs); null before migration 0003. */
  snapshotJson: string | null;
}

const TICKET_COLUMNS = `run_id, issued_at, seed, expires_at,
              payload_hash, verifier_signature, attested_at,
              game_version, epoch, snapshot_hash, player, result_json,
              source_epoch, inherited, snapshot_json`;

function toRunTicket(row: RunTicketRow): RunTicketRecord {
  return {
    runId: row.run_id,
    issuedAt: Number(row.issued_at),
    seed: row.seed,
    expiresAt: Number(row.expires_at),
    payloadHash: row.payload_hash,
    verifierSignature: row.verifier_signature,
    attestedAt: row.attested_at === null ? null : Number(row.attested_at),
    gameVersion: row.game_version,
    epoch: row.epoch === null ? null : Number(row.epoch),
    snapshotHash: row.snapshot_hash,
    player: row.player,
    resultJson: row.result_json,
    sourceEpoch: row.source_epoch === null ? null : Number(row.source_epoch),
    inherited: row.inherited === null ? null : Number(row.inherited),
    snapshotJson: row.snapshot_json ?? null,
  };
}

export interface IssueRunTicketInput {
  runId: string;
  issuedAt: number;
  seed: string;
  expiresAt: number;
  gameVersion: string;
  epoch: number;
  snapshotHash: string;
  sourceEpoch: number | null;
  inherited: number;
  /** JSON of the snapshot hash's preimage, kept so anyone can recompute the hash later. */
  snapshotJson: string;
}

/** Insert a ticket and sweep expired tickets and counters on the way. */
export async function issueRunTicket(db: D1Database, input: IssueRunTicketInput) {
  await db.batch([
    db.prepare("DELETE FROM dnfi_run_tickets WHERE expires_at < ?").bind(input.issuedAt),
    db.prepare("DELETE FROM dnfi_rate_limits WHERE expires_at < ?").bind(input.issuedAt),
    db
      .prepare(
        `INSERT INTO dnfi_run_tickets
          (run_id, issued_at, seed, expires_at, game_version, epoch, snapshot_hash, source_epoch, inherited, snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.runId, input.issuedAt, input.seed, input.expiresAt, input.gameVersion, input.epoch, input.snapshotHash,
        input.sourceEpoch, input.inherited, input.snapshotJson,
      ),
  ]);
}

export async function readRunTicket(db: D1Database, runId: string) {
  const row = await db
    .prepare(`SELECT ${TICKET_COLUMNS} FROM dnfi_run_tickets WHERE run_id = ?`)
    .bind(runId)
    .first<RunTicketRow>();
  return row ? toRunTicket(row) : null;
}

export type StoreAttestationResult =
  | { status: "stored"; record: RunTicketRecord }
  | { status: "conflict" }
  | { status: "missing" };

export interface StoreAttestationInput {
  runId: string;
  payloadHash: string;
  verifierSignature: string;
  attestedAt: number;
  player: string;
  resultJson: string;
  /**
   * The row lives at least until this (seconds) once attested, so the re-sign
   * path — which needs the row — outlasts the ticket's play window. The
   * caller passes `attestedAt + 2 × SIGNATURE_WINDOW_SECONDS` (docs/CHAIN.md §6).
   */
  keepUntil: number;
}

/**
 * Store the first attestation of a run ID and return the row as it stands.
 *
 * The conditional update is the serialization point: exactly one request
 * writes the row while it has no signature. The row is then returned whoever
 * wrote it, so the caller can tell a same-payload repeat (the stored result is
 * the answer, or the base for a re-sign for another player) from a different
 * payload (`conflict`). The first successful store also extends `expires_at`
 * to `keepUntil` when that is later.
 */
export async function storeAttestation(db: D1Database, input: StoreAttestationInput): Promise<StoreAttestationResult> {
  await db
    .prepare(
      `UPDATE dnfi_run_tickets
          SET payload_hash = ?, verifier_signature = ?, attested_at = ?, player = ?, result_json = ?,
              expires_at = MAX(expires_at, ?)
        WHERE run_id = ?
          AND expires_at >= ?
          AND verifier_signature IS NULL`,
    )
    .bind(
      input.payloadHash,
      input.verifierSignature,
      input.attestedAt,
      input.player,
      input.resultJson,
      input.keepUntil,
      input.runId,
      input.attestedAt,
    )
    .run();

  const stored = await readRunTicket(db, input.runId);
  if (!stored || stored.expiresAt < input.attestedAt || !stored.verifierSignature) {
    return { status: "missing" };
  }
  if (stored.payloadHash !== input.payloadHash) return { status: "conflict" };
  return { status: "stored", record: stored };
}

/**
 * Replace a stored attestation of the same payload: a fresh result (a new
 * deadline, possibly another player) and signature. Compare-and-swap on the
 * signature the caller saw, so two racing replacements converge: the loser
 * reads a signature that is not its own and decides again on the row as it
 * stands. Returns the row afterwards, whoever won.
 */
export async function refreshAttestation(
  db: D1Database,
  input: {
    runId: string; payloadHash: string; previousSignature: string;
    verifierSignature: string; attestedAt: number; player: string; resultJson: string;
  },
): Promise<RunTicketRecord | null> {
  await db
    .prepare(
      `UPDATE dnfi_run_tickets
          SET verifier_signature = ?, attested_at = ?, player = ?, result_json = ?
        WHERE run_id = ? AND payload_hash = ? AND verifier_signature = ? AND expires_at >= ?`,
    )
    .bind(
      input.verifierSignature, input.attestedAt, input.player, input.resultJson,
      input.runId, input.payloadHash, input.previousSignature, input.attestedAt,
    )
    .run();
  return readRunTicket(db, input.runId);
}

/** Atomic fixed-window limiter shared by every Worker isolate and location. */
export async function consumeRateLimit(
  db: D1Database,
  input: { bucketKey: string; limit: number; nowMs: number },
) {
  const now = Math.floor(input.nowMs / 1_000);
  const windowStart = Math.floor(now / 60) * 60;
  const expiresAt = windowStart + 120;
  const row = await db
    .prepare(
      `INSERT INTO dnfi_rate_limits (bucket_key, window_start, count, expires_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(bucket_key, window_start) DO UPDATE SET
         count = dnfi_rate_limits.count + 1,
         expires_at = excluded.expires_at
       WHERE dnfi_rate_limits.count < ?
       RETURNING count`,
    )
    .bind(input.bucketKey, windowStart, expiresAt, input.limit)
    .first<{ count: number }>();
  return row !== null;
}

/** One snapshot row per chain, contract and game version. */
export interface SnapshotKey {
  chainId: number;
  contractAddress: string;
  gameVersion: string;
}

interface SnapshotRow {
  cursor: number;
  snapshot_json: string;
  updated_at: number;
  refresh_lease_until: number;
}

export interface LeaderboardSnapshotRecord {
  cursor: number;
  snapshotJson: string;
  updatedAt: number;
  /** Unix ms until which a refresh lease is held; 0 when free. */
  refreshLeaseUntil: number;
}

export async function readLeaderboardSnapshot(db: D1Database, key: SnapshotKey): Promise<LeaderboardSnapshotRecord | null> {
  const row = await db
    .prepare(
      `SELECT cursor, snapshot_json, updated_at, refresh_lease_until
         FROM dnfi_leaderboard_snapshots
        WHERE chain_id = ? AND contract_address = ? AND game_version = ?`,
    )
    .bind(key.chainId, key.contractAddress.toLowerCase(), key.gameVersion.toLowerCase())
    .first<SnapshotRow>();
  return row
    ? { cursor: Number(row.cursor), snapshotJson: row.snapshot_json, updatedAt: Number(row.updated_at), refreshLeaseUntil: Number(row.refresh_lease_until) }
    : null;
}

/** A stale concurrent refresh may repeat work, but it cannot move the cursor backwards. The lease column is left alone. */
export async function writeLeaderboardSnapshot(
  db: D1Database,
  input: SnapshotKey & { cursor: number; snapshotJson: string; updatedAt: number },
) {
  await db
    .prepare(
      `INSERT INTO dnfi_leaderboard_snapshots
        (chain_id, contract_address, game_version, cursor, snapshot_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain_id, contract_address, game_version) DO UPDATE SET
         cursor = excluded.cursor,
         snapshot_json = excluded.snapshot_json,
         updated_at = excluded.updated_at
       WHERE excluded.cursor >= dnfi_leaderboard_snapshots.cursor`,
    )
    .bind(
      input.chainId,
      input.contractAddress.toLowerCase(),
      input.gameVersion.toLowerCase(),
      input.cursor,
      input.snapshotJson,
      input.updatedAt,
    )
    .run();
}

/**
 * Claim the row's refresh lease until `leaseUntilMs` if it is free (its lease
 * has passed `nowMs`). The conditional update is atomic across every Worker
 * isolate, so one refresh runs at a time per row. With no row yet, a
 * placeholder (`placeholderJson`, cursor −1, never updated) is inserted to
 * lease on; `writeLeaderboardSnapshot` replaces it like any older snapshot.
 * Returns true when this call holds the lease.
 */
export async function claimRefreshLease(
  db: D1Database,
  input: SnapshotKey & { nowMs: number; leaseUntilMs: number; placeholderJson: string },
): Promise<boolean> {
  const bound = [input.chainId, input.contractAddress.toLowerCase(), input.gameVersion.toLowerCase()] as const;
  const [, claimed] = await db.batch<{ refresh_lease_until: number }>([
    db
      .prepare(
        `INSERT OR IGNORE INTO dnfi_leaderboard_snapshots
          (chain_id, contract_address, game_version, cursor, snapshot_json, updated_at, refresh_lease_until)
         VALUES (?, ?, ?, -1, ?, 0, 0)`,
      )
      .bind(...bound, input.placeholderJson),
    db
      .prepare(
        `UPDATE dnfi_leaderboard_snapshots
            SET refresh_lease_until = ?
          WHERE chain_id = ? AND contract_address = ? AND game_version = ?
            AND refresh_lease_until < ?
          RETURNING refresh_lease_until`,
      )
      .bind(input.leaseUntilMs, ...bound, input.nowMs),
  ]);
  return (claimed.results?.length ?? 0) > 0;
}

/**
 * Hand the lease back (or shorten it), only if this call still holds it
 * (`heldUntilMs` is what `claimRefreshLease` was given). A finished refresh
 * sets it to 0 so the next one waits only for the throttle; a failed one
 * keeps it until the retry time so a dead RPC is not hit from every isolate.
 */
export async function releaseRefreshLease(
  db: D1Database,
  input: SnapshotKey & { heldUntilMs: number; untilMs: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE dnfi_leaderboard_snapshots
          SET refresh_lease_until = ?
        WHERE chain_id = ? AND contract_address = ? AND game_version = ? AND refresh_lease_until = ?`,
    )
    .bind(input.untilMs, input.chainId, input.contractAddress.toLowerCase(), input.gameVersion.toLowerCase(), input.heldUntilMs)
    .run();
}

/** The owner's re-index: drop the row and the next refresh starts from the deploy block. */
export async function clearLeaderboardSnapshot(db: D1Database, key: SnapshotKey) {
  await db
    .prepare(`DELETE FROM dnfi_leaderboard_snapshots WHERE chain_id = ? AND contract_address = ? AND game_version = ?`)
    .bind(key.chainId, key.contractAddress.toLowerCase(), key.gameVersion.toLowerCase())
    .run();
}

/**
 * Start a row over — cursor -1, never written, an empty snapshot — keeping
 * its lease. For a snapshot of an older shape: the refresh that holds the
 * lease resets the row and re-indexes from the deploy block, which the
 * monotonic cursor guard of `writeLeaderboardSnapshot` would otherwise refuse.
 */
export async function resetLeaderboardSnapshot(db: D1Database, input: SnapshotKey & { placeholderJson: string }) {
  await db
    .prepare(
      `UPDATE dnfi_leaderboard_snapshots SET cursor = -1, snapshot_json = ?, updated_at = 0
        WHERE chain_id = ? AND contract_address = ? AND game_version = ?`,
    )
    .bind(input.placeholderJson, input.chainId, input.contractAddress.toLowerCase(), input.gameVersion.toLowerCase())
    .run();
}

/* ------------------------------------------------------------------ *
 * Traces: the record behind every attestation, kept for good
 * ------------------------------------------------------------------ */

export interface RunTraceInput {
  runId: string;
  gameVersion: string;
  seed: string;
  inherited: number;
  epoch: number;
  sourceEpoch: number | null;
  snapshotJson: string;
  snapshotHash: string;
  endTick: number;
  traceHash: string;
  /** The canonical trace bytes (lib/chain/trace.ts `encodeTrace`). */
  trace: Uint8Array;
  resultJson: string;
  storedAt: number;
}

export interface RunTraceRecord extends Omit<RunTraceInput, "trace"> { trace: Uint8Array }

interface RunTraceRow {
  run_id: string; game_version: string; seed: string; inherited: number; epoch: number; source_epoch: number | null;
  snapshot_json: string; snapshot_hash: string; end_tick: number; trace_hash: string; trace: ArrayBuffer | Uint8Array | number[];
  result_json: string; stored_at: number;
}

/**
 * Keep a trace. Immutable: the first write for a run id wins (the trace is
 * the payload the attestation was keyed on, so a repeat carries the same bytes).
 * Tickets are swept once expired; traces never are — they are the record
 * anyone can replay against the hash the contract holds.
 */
export async function storeRunTrace(db: D1Database, input: RunTraceInput): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO dnfi_run_traces
        (run_id, game_version, seed, inherited, epoch, source_epoch, snapshot_json, snapshot_hash, end_tick, trace_hash, trace, result_json, stored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.runId, input.gameVersion, input.seed, input.inherited, input.epoch, input.sourceEpoch, input.snapshotJson,
      input.snapshotHash, input.endTick, input.traceHash, input.trace, input.resultJson, input.storedAt,
    )
    .run();
}

export async function readRunTrace(db: D1Database, runId: string): Promise<RunTraceRecord | null> {
  const row = await db
    .prepare(
      `SELECT run_id, game_version, seed, inherited, epoch, source_epoch, snapshot_json, snapshot_hash, end_tick, trace_hash, trace, result_json, stored_at
         FROM dnfi_run_traces WHERE run_id = ?`,
    )
    .bind(runId)
    .first<RunTraceRow>();
  if (!row) return null;
  const raw = row.trace;
  const trace = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
  return {
    runId: row.run_id, gameVersion: row.game_version, seed: row.seed, inherited: Number(row.inherited), epoch: Number(row.epoch),
    sourceEpoch: row.source_epoch === null ? null : Number(row.source_epoch), snapshotJson: row.snapshot_json,
    snapshotHash: row.snapshot_hash, endTick: Number(row.end_tick), traceHash: row.trace_hash, trace, resultJson: row.result_json,
    storedAt: Number(row.stored_at),
  };
}
