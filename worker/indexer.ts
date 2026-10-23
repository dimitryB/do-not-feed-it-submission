/**
 * The world, indexed from the registry's events (docs/CHAIN.md §6–7): the
 * board from `ResultRecorded`, the piles from `PileFed` — the contract emits
 * it only for the filings that fed the pile (a wallet's first
 * `PILE_FILINGS_PER_EPOCH` in an epoch), so the indexer never re-derives the
 * cap and always agrees with `diet(epoch)`.
 *
 * One D1 row per chain, contract and game version holds a JSON snapshot and
 * the cursor — the last block fully scanned. A refresh scans forward from the
 * cursor in bounded batches, up to `DNFI_CONFIRMATIONS` blocks behind the
 * head, folds every event into the snapshot (the pile per epoch, the all-time
 * pile, the top keepers) and writes it back under the monotonic-cursor guard.
 * One refresh runs at a time per row: a lease on the row (claimed with a
 * conditional update, so it holds across every isolate and location) gates
 * the scan; a request that does not get the lease serves the cached snapshot.
 * The fold is deterministic, so a repeated batch is harmless.
 *
 * There is no automatic reorg rewind: the confirmation lag is the defence. A
 * reorg deeper than that below the cursor leaves the snapshot wrong until the
 * owner clears the row (`clearLeaderboardSnapshot`), after which the next
 * refresh starts again from `DNFI_DEPLOY_BLOCK`.
 */
import { createPublicClient, fallback, getAbiItem, http, type Address, type Hex } from "viem";
import { feedRegistryAbi, GAME_VERSION_ID, HEMI_CHAIN_ID, HEMI_RPC_URL, SNAPSHOT_LOOKBACK } from "../lib/chain/types.ts";
import {
  claimRefreshLease, readLeaderboardSnapshot, releaseRefreshLease, resetLeaderboardSnapshot, writeLeaderboardSnapshot, type D1Database, type SnapshotKey,
} from "../db/chainState.ts";

/** The part of the Worker's env the indexer reads. */
export interface IndexerEnv {
  HEMI_RPC_URL?: string;
  HEMI_RPC_FALLBACKS?: string;
  DNFI_CONTRACT_ADDRESS?: string;
  DNFI_CHAIN_ID?: string;
  DNFI_DEPLOY_BLOCK?: string;
  DNFI_GENESIS?: string;
  DNFI_EPOCH_SECONDS?: string;
  /** Blocks behind the head the scan stops; default 16. The local e2e sets 0. */
  DNFI_CONFIRMATIONS?: string;
}

/** Blocks per `eth_getLogs`; public RPCs refuse wider ranges. */
export const LOG_BATCH_BLOCKS = 2_000;
/** Blocks one refresh may cover; the rest waits for the next call. */
export const MAX_BLOCKS_PER_REFRESH = 20_000;
/** A refresh is attempted at most this often per row. */
export const REFRESH_INTERVAL_MS = 20_000;
/** How long one refresh holds the row's lease; longer than any scan should take. */
export const REFRESH_LEASE_MS = 30_000;
/** Blocks behind the head the scan stops when `DNFI_CONFIRMATIONS` is unset. */
export const DEFAULT_CONFIRMATIONS = 16;
/** The all-time board's length. */
export const TOP_N = 25;
/** Each kept epoch's own board's length (the ledger page). */
export const EPOCH_TOP_N = 10;
/**
 * How many recent epochs with runs keep their own pile and board; `allTime`
 * keeps the rest. One more than the ticket's look-back (docs/CHAIN.md §10.1),
 * so the oldest epoch the ledger shows still knows which epoch it inherited from.
 */
export const KEPT_EPOCHS = SNAPSHOT_LOOKBACK + 1;
/** Bumped when the snapshot's shape changes; an older row is re-indexed from `DNFI_DEPLOY_BLOCK` (`readWorld` → `outdated`). */
export const SNAPSHOT_VERSION = 2;

export interface PileTotals { btc: number; eth: number; hemi: number; runs: number }
export interface WorldEntry {
  player: Address; score: number; durationTicks: number;
  btcFed: number; ethFed: number; hemiFed: number;
  bestCombo: number; sizeCenti: number; ending: number; epoch: number;
  /** The filing's run id: the key of its public trace (`GET /api/chain/trace?runId=…`). */
  runId: Hex;
  txHash: Hex; blockNumber: number; logIndex: number;
}
export interface WorldSnapshot {
  version: typeof SNAPSHOT_VERSION;
  /** The contract's immutables, read once; null until the RPC has answered. */
  genesis: number | null;
  epochSeconds: number | null;
  /** The last block fully scanned; -1 when nothing has been scanned yet. */
  cursor: number;
  /** A bounded scan has not reached the confirmed head yet. Absent on older, complete snapshots. */
  catchingUp?: boolean;
  top: WorldEntry[];
  /** Per-epoch piles for the last `KEPT_EPOCHS` epochs with runs, keyed by the decimal epoch. */
  piles: Record<string, PileTotals>;
  /** Each kept epoch's board: one entry per player, their best in that epoch, `EPOCH_TOP_N` long. Same keys as `piles`. */
  epochTop: Record<string, WorldEntry[]>;
  allTime: PileTotals;
}
export interface WorldView {
  snapshot: WorldSnapshot;
  /** Seconds; 0 when nothing has ever been written. */
  updatedAt: number;
  /** True when this call could not confirm the snapshot against the chain. */
  stale: boolean;
  /** The stored row is an older snapshot version: served as empty, and the next refresh re-indexes from the deploy block. */
  outdated?: boolean;
}

export const emptyPile = (): PileTotals => ({ btc: 0, eth: 0, hemi: 0, runs: 0 });
export function emptySnapshot(): WorldSnapshot {
  return { version: SNAPSHOT_VERSION, genesis: null, epochSeconds: null, cursor: -1, top: [], piles: {}, epochTop: {}, allTime: emptyPile() };
}

/** Env parsing shared with the routes. Throws on a malformed value; absent is allowed. */
export function parseIntegerEnv(value: string | undefined, name: string): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}
export function chainIdOf(env: IndexerEnv): number { return parseIntegerEnv(env.DNFI_CHAIN_ID, "DNFI_CHAIN_ID") ?? HEMI_CHAIN_ID; }
export function confirmationsOf(env: IndexerEnv): number { return parseIntegerEnv(env.DNFI_CONFIRMATIONS, "DNFI_CONFIRMATIONS") ?? DEFAULT_CONFIRMATIONS; }
/** Required once the chain is on (docs/CHAIN.md §6); `resolve` in chain.ts reports a missing one. */
export function deployBlockOf(env: IndexerEnv): number | null { return parseIntegerEnv(env.DNFI_DEPLOY_BLOCK, "DNFI_DEPLOY_BLOCK"); }
export function rpcUrlsOf(env: IndexerEnv): string[] {
  const fallbacks = (env.HEMI_RPC_FALLBACKS ?? "").split(",").map((url) => url.trim()).filter(Boolean);
  return [env.HEMI_RPC_URL?.trim() || HEMI_RPC_URL, ...fallbacks];
}
export function snapshotKeyOf(env: IndexerEnv): SnapshotKey {
  if (!env.DNFI_CONTRACT_ADDRESS) throw new Error("DNFI_CONTRACT_ADDRESS is not set");
  return { chainId: chainIdOf(env), contractAddress: env.DNFI_CONTRACT_ADDRESS, gameVersion: GAME_VERSION_ID };
}

/** The epoch a timestamp falls in, or null when the immutables are unknown. */
export function epochAt(world: Pick<WorldSnapshot, "genesis" | "epochSeconds">, nowSeconds: number): number | null {
  if (world.genesis === null || world.epochSeconds === null || world.epochSeconds <= 0) return null;
  return Math.max(0, Math.floor((nowSeconds - world.genesis) / world.epochSeconds));
}

/** The immutables: the snapshot's if read, else the env's, else unknown. */
export function immutablesOf(env: IndexerEnv, snapshot: WorldSnapshot | null): Pick<WorldSnapshot, "genesis" | "epochSeconds"> {
  return {
    genesis: snapshot?.genesis ?? parseIntegerEnv(env.DNFI_GENESIS, "DNFI_GENESIS"),
    epochSeconds: snapshot?.epochSeconds ?? parseIntegerEnv(env.DNFI_EPOCH_SECONDS, "DNFI_EPOCH_SECONDS"),
  };
}

export function parseSnapshot(json: string): WorldSnapshot {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== SNAPSHOT_VERSION) {
    throw new Error("Unknown world snapshot version");
  }
  return parsed as WorldSnapshot;
}

/**
 * Read the cached world without touching the RPC; what the ticket route uses.
 * A row never written (the lease placeholder) reads as empty; so does a row
 * of an older snapshot version, flagged `outdated` so the next refresh
 * re-indexes it rather than folding new events into an old shape.
 */
export async function readWorld(env: IndexerEnv, db: D1Database): Promise<WorldView> {
  const row = await readLeaderboardSnapshot(db, snapshotKeyOf(env));
  if (!row) return { snapshot: emptySnapshot(), updatedAt: 0, stale: true };
  let snapshot: WorldSnapshot;
  try {
    snapshot = parseSnapshot(row.snapshotJson);
  } catch {
    return { snapshot: emptySnapshot(), updatedAt: 0, stale: true, outdated: true };
  }
  if (row.updatedAt === 0) return { snapshot, updatedAt: 0, stale: true };
  return { snapshot, updatedAt: row.updatedAt, stale: snapshot.catchingUp === true };
}

const resultRecordedEvent = getAbiItem({ abi: feedRegistryAbi, name: "ResultRecorded" });
const pileFedEvent = getAbiItem({ abi: feedRegistryAbi, name: "PileFed" });

/** One decoded `ResultRecorded`, with where it was found. */
export interface RecordedResult {
  runId: Hex; player: Address; gameVersion: Hex;
  score: bigint; durationTicks: number; btcFed: number; ethFed: number; hemiFed: number;
  bestCombo: number; frenzies: number; sizeCenti: number; ending: number; cause: number; epoch: bigint;
  txHash: Hex; blockNumber: bigint; logIndex: number;
}

/** One decoded `PileFed`: what a filing added to its epoch's pile. */
export interface PileContribution { epoch: bigint; btcFed: number; ethFed: number; hemiFed: number; blockNumber: bigint; logIndex: number }

/** The registry's events in chain order. */
export type RegistryEvent = { kind: "recorded"; result: RecordedResult } | { kind: "fed"; fed: PileContribution };

const toCount = (value: bigint | number): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Counter out of range");
  return n;
};

function addPile(pile: PileTotals, fed: PileContribution): void {
  pile.btc += fed.btcFed; pile.eth += fed.ethFed; pile.hemi += fed.hemiFed; pile.runs += 1;
}

function compareEntries(a: WorldEntry, b: WorldEntry): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
  return a.logIndex - b.logIndex;
}

/** Fold one `PileFed` into the piles: whatever version it was filed under, it fed the same creature. */
export function foldPile(snapshot: WorldSnapshot, fed: PileContribution): void {
  const epochKey = fed.epoch.toString();
  snapshot.piles[epochKey] ??= emptyPile();
  addPile(snapshot.piles[epochKey], fed);
  addPile(snapshot.allTime, fed);
}

/** Fold one `ResultRecorded` into the board: only the current version ranks. The pile comes from `PileFed`. */
export function foldResult(snapshot: WorldSnapshot, r: RecordedResult): void {
  if (r.gameVersion.toLowerCase() !== GAME_VERSION_ID.toLowerCase()) return;
  const epochKey = r.epoch.toString();
  const entry: WorldEntry = {
    player: r.player, score: toCount(r.score), durationTicks: r.durationTicks,
    btcFed: r.btcFed, ethFed: r.ethFed, hemiFed: r.hemiFed,
    bestCombo: r.bestCombo, sizeCenti: r.sizeCenti, ending: r.ending, epoch: toCount(r.epoch),
    runId: r.runId, txHash: r.txHash, blockNumber: toCount(r.blockNumber), logIndex: r.logIndex,
  };
  rank(snapshot.top, entry, TOP_N);
  snapshot.epochTop[epochKey] ??= [];
  rank(snapshot.epochTop[epochKey], { ...entry }, EPOCH_TOP_N);
}

/** One entry per player, their best; sorted by score (ties to the earlier filing); at most `limit` long. */
function rank(board: WorldEntry[], entry: WorldEntry, limit: number): void {
  const key = entry.player.toLowerCase();
  const existing = board.findIndex((e) => e.player.toLowerCase() === key);
  if (existing >= 0) {
    if (compareEntries(entry, board[existing]) >= 0) return;
    board[existing] = entry;
  } else {
    board.push(entry);
  }
  board.sort(compareEntries);
  if (board.length > limit) board.length = limit;
}

/**
 * Keep the last `KEPT_EPOCHS` piles with runs; `allTime` already holds the
 * rest. The ticket's source epoch — the greatest epoch below the current one
 * with runs, within the lookback — is always among the most recent epochs
 * with runs, so this is enough for docs/CHAIN.md §10.1.
 */
export function prunePiles(snapshot: WorldSnapshot): void {
  const epochs = Object.keys(snapshot.piles).map(Number).sort((a, b) => b - a);
  for (const epoch of epochs.slice(KEPT_EPOCHS)) delete snapshot.piles[String(epoch)];
  for (const key of Object.keys(snapshot.epochTop)) if (!(key in snapshot.piles)) delete snapshot.epochTop[key];
}

export interface RefreshOptions {
  /** Ignore the 20 s throttle (the lease still applies). */
  force?: boolean;
  /** The clock, in ms. */
  nowMs?: number;
  /** The fetch the RPC transport uses; tests pass a fake. */
  fetchFn?: typeof fetch;
}

type Client = ReturnType<typeof createPublicClient>;

function makeClient(env: IndexerEnv, fetchFn: typeof fetch | undefined): Client {
  const transports = rpcUrlsOf(env).map((url) => http(url, { fetchFn, timeout: 10_000 }));
  return createPublicClient({ transport: fallback(transports, { retryCount: 1, retryDelay: 250 }) });
}

async function readImmutables(client: Client, address: Address): Promise<Pick<WorldSnapshot, "genesis" | "epochSeconds">> {
  const [genesis, epochSeconds] = await Promise.all([
    client.readContract({ address, abi: feedRegistryAbi, functionName: "GENESIS" }),
    client.readContract({ address, abi: feedRegistryAbi, functionName: "EPOCH_SECONDS" }),
  ]);
  return { genesis: toCount(genesis), epochSeconds: toCount(epochSeconds) };
}

async function fetchEvents(client: Client, address: Address, fromBlock: number, toBlock: number): Promise<RegistryEvent[]> {
  const logs = await client.getLogs({ address, events: [resultRecordedEvent, pileFedEvent], fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock), strict: true });
  const events: RegistryEvent[] = [];
  for (const log of logs) {
    if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) continue;
    if (log.eventName === "ResultRecorded") {
      const a = log.args;
      events.push({ kind: "recorded", result: {
        runId: a.runId, player: a.player, gameVersion: a.gameVersion,
        score: a.score, durationTicks: a.durationTicks, btcFed: a.btcFed, ethFed: a.ethFed, hemiFed: a.hemiFed,
        bestCombo: a.bestCombo, frenzies: a.frenzies, sizeCenti: a.sizeCenti, ending: a.ending, cause: a.cause, epoch: a.epoch,
        txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex,
      } });
    } else if (log.eventName === "PileFed") {
      const a = log.args;
      events.push({ kind: "fed", fed: { epoch: a.epoch, btcFed: a.btcFed, ethFed: a.ethFed, hemiFed: a.hemiFed, blockNumber: log.blockNumber, logIndex: log.logIndex } });
    }
  }
  const at = (e: RegistryEvent) => (e.kind === "recorded" ? e.result : e.fed);
  events.sort((x, y) => {
    const a = at(x), b = at(y);
    return a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber);
  });
  return events;
}

/** Older than the refresh interval, or never written: what `stale` means for a request that did not scan. */
const isOld = (view: WorldView, nowMs: number) => view.updatedAt === 0 || nowMs - view.updatedAt * 1_000 >= REFRESH_INTERVAL_MS;

/**
 * Serve the cached world, refreshing it from the chain when it is older than
 * `REFRESH_INTERVAL_MS` (or empty, or `force`) and this call wins the row's
 * lease. Never throws for an RPC failure: the cached snapshot comes back with
 * `stale: true`. A malformed env value (`DNFI_CONFIRMATIONS`,
 * `DNFI_DEPLOY_BLOCK`, the chain id) does throw — that is a server fault.
 */
export async function refreshWorld(env: IndexerEnv, db: D1Database, options: RefreshOptions = {}): Promise<WorldView> {
  const key = snapshotKeyOf(env);
  const confirmations = confirmationsOf(env);
  const deployBlock = deployBlockOf(env) ?? 0;
  const nowMs = options.nowMs ?? Date.now();
  const cached = await readWorld(env, db);
  if (!options.force && !isOld(cached, nowMs)) return cached;
  const leaseUntilMs = nowMs + REFRESH_LEASE_MS;
  const claimed = await claimRefreshLease(db, { ...key, nowMs, leaseUntilMs, placeholderJson: JSON.stringify(emptySnapshot()) });
  if (!claimed) return { ...cached, stale: cached.stale || isOld(cached, nowMs) };
  // An older snapshot shape: start over from the deploy block (the cursor guard would refuse a lower cursor otherwise).
  if (cached.outdated) await resetLeaderboardSnapshot(db, { ...key, placeholderJson: JSON.stringify(emptySnapshot()) });
  try {
    const view = await scanForward(env, db, key, cached, { nowMs, confirmations, deployBlock, fetchFn: options.fetchFn });
    await releaseRefreshLease(db, { ...key, heldUntilMs: leaseUntilMs, untilMs: 0 });
    return view;
  } catch (error) {
    // Keep the lease until the next retry time, so a dead RPC is hit once per interval from all isolates together.
    await releaseRefreshLease(db, { ...key, heldUntilMs: leaseUntilMs, untilMs: nowMs + REFRESH_INTERVAL_MS }).catch(() => undefined);
    console.warn(`[dnfi] world refresh failed: ${error instanceof Error ? error.name : "unknown error"}`);
    return { ...cached, stale: true };
  }
}

interface ScanOptions { nowMs: number; confirmations: number; deployBlock: number; fetchFn: typeof fetch | undefined }

async function scanForward(env: IndexerEnv, db: D1Database, key: SnapshotKey, cached: WorldView, o: ScanOptions): Promise<WorldView> {
  const client = makeClient(env, o.fetchFn);
  const address = key.contractAddress as Address;
  const snapshot: WorldSnapshot = structuredClone(cached.snapshot);
  if (snapshot.genesis === null || snapshot.epochSeconds === null) Object.assign(snapshot, await readImmutables(client, address));
  const head = toCount(await client.getBlockNumber());
  const confirmed = head - o.confirmations;
  const start = snapshot.cursor < 0 ? o.deployBlock : snapshot.cursor + 1;
  const end = Math.min(confirmed, start + MAX_BLOCKS_PER_REFRESH - 1);
  let updatedAt = Math.floor(o.nowMs / 1_000);
  if (end < start) {
    snapshot.cursor = Math.max(snapshot.cursor, start - 1);
    snapshot.catchingUp = false;
    await persist(db, key, snapshot, updatedAt);
    return { snapshot, updatedAt, stale: false };
  }
  for (let from = start; from <= end; from += LOG_BATCH_BLOCKS) {
    const to = Math.min(end, from + LOG_BATCH_BLOCKS - 1);
    for (const event of await fetchEvents(client, address, from, to)) {
      if (event.kind === "recorded") foldResult(snapshot, event.result);
      else foldPile(snapshot, event.fed);
    }
    prunePiles(snapshot);
    snapshot.cursor = to;
    snapshot.catchingUp = to < confirmed;
    updatedAt = Math.floor(o.nowMs / 1_000);
    await persist(db, key, snapshot, updatedAt);
  }
  return { snapshot, updatedAt, stale: snapshot.catchingUp === true };
}

async function persist(db: D1Database, key: SnapshotKey, snapshot: WorldSnapshot, updatedAt: number): Promise<void> {
  await writeLeaderboardSnapshot(db, { ...key, cursor: Math.max(0, snapshot.cursor), snapshotJson: JSON.stringify(snapshot), updatedAt });
}
