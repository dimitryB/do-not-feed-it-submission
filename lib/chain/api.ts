/**
 * The Worker's chain routes, as the browser calls them (docs/CHAIN.md §6).
 * Four calls, each with its own timeout and a typed error; nothing here
 * touches a wallet or a key. `fetchWorld` retries once; nothing else does —
 * a ticket that takes longer than 1.5 s means a practice shift, not a wait.
 */
import type { Address, Hex } from "viem";
import { HEMI_CHAIN_ID, HEMI_EXPLORER_URL, HEMI_RPC_URL, TICKET_SECONDS, resultFromJson, type RunResult, type RunResultJson } from "./types.ts";
import type { ArcadeCommand } from "../game/arcade.ts";

export const CONFIG_TIMEOUT_MS = 4_000;
export const WORLD_TIMEOUT_MS = 4_000;
export const TICKET_TIMEOUT_MS = 1_500;
export const ATTEST_TIMEOUT_MS = 20_000;

/** The Worker's error codes (§6), plus the client's own for a timeout, a network failure and a malformed answer. */
export type ChainApiCode =
  | "disabled" | "rate_limited" | "bad_request" | "unknown_ticket" | "expired_ticket" | "invalid_trace"
  | "run_not_over" | "payload_conflict" | "player_conflict" | "out_of_bounds" | "unavailable"
  | "timeout" | "network" | "bad_response";

export class ChainApiError extends Error {
  readonly code: ChainApiCode;
  readonly status: number;
  constructor(code: ChainApiCode, message: string, status = 0) {
    super(message);
    this.name = "ChainApiError";
    this.code = code;
    this.status = status;
  }
}

/** `GET /api/chain/config`. Fields the Worker may omit fall back to Hemi's constants in `chainFromConfig`. */
export interface ChainConfig {
  enabled: boolean;
  chainId: number;
  rpcUrl: string | null;
  contractAddress: Address | null;
  explorerUrl: string | null;
  gameVersion: number | null;
  gameVersionId: Hex | null;
  epochSeconds: number | null;
  ticketSeconds: number;
  /** Why it is off, when the Worker says (the scaffold did). */
  reason: string | null;
}

/**
 * `POST /api/chain/ticket`. Times are unix seconds. `snapshot` is the source
 * epoch's pile (docs/CHAIN.md §10.1), `inherited` its dominant token as the
 * contract codes it (0 none, 1 btc, 2 eth, 3 hemi) and `sourceEpoch` which
 * epoch that was; null and 0 when nothing is inherited.
 */
export interface Ticket {
  runId: Hex;
  seed: number;
  issuedAt: number;
  expiresAt: number;
  epoch: number;
  snapshotHash: Hex;
  sourceEpoch: number | null;
  inherited: number;
  snapshot: { btc: bigint; eth: bigint; hemi: bigint; runs: bigint; dominant: number };
}

export interface AttestRequest { runId: Hex; player: Address; commands: readonly ArcadeCommand[]; endTick: number }

/** `POST /api/chain/attest`: the result decoded strictly, the server's own JSON kept for the comparison, and its signature. */
export interface AttestResponse {
  result: RunResult;
  resultJson: RunResultJson;
  verifierSignature: Hex;
  /** The typed data as the server built it, when it sends one; the client rebuilds its own and compares. */
  typedData: unknown;
}

export interface PileJson { btc: bigint; eth: bigint; hemi: bigint; runs: bigint }

export interface Keeper {
  player: Address;
  score: bigint;
  durationTicks: number;
  btcFed: number; ethFed: number; hemiFed: number;
  bestCombo: number; sizeCenti: number; ending: number;
  epoch: number;
  /** The filing's run id, the key of its public trace; null from an older Worker. */
  runId: Hex | null;
  txHash: Hex | null;
}

/** One epoch on the ledger page (docs/CHAIN.md §6 `epochs`). */
export interface LedgerEpoch {
  epoch: number;
  pile: PileJson;
  /** The coin the pile had most of (0 none, 1 btc, 2 eth, 3 hemi): what it passes on, provisional while the epoch is current. */
  dominant: number;
  /** The trait its own creature came in with, and from which epoch; null when the snapshot no longer reaches that far back. */
  inherited: number | null;
  sourceEpoch: number | null;
  /** The epoch's own board: one best per player in that epoch. */
  top: Keeper[];
}

/** `GET /api/chain/world`. */
export interface World {
  gameVersionId: Hex | null;
  epoch: number;
  epochSeconds: number;
  pile: { current: PileJson; previous: PileJson; allTime: PileJson };
  top: Keeper[];
  /** The current epoch first, then the most recent epochs with runs, newest first; [] from an older Worker. */
  epochs: LedgerEpoch[];
  /** The contract's GENESIS (unix seconds), for the epochs' dates; null until the indexer has read it. */
  genesis: number | null;
  /** What a shift started in the current epoch inherits (0 none, 1 btc, 2 eth, 3 hemi) and from which epoch; the ticket is the authority for a shift. */
  inherited: number;
  sourceEpoch: number | null;
  /** Unix seconds when the snapshot was taken. */
  updatedAt: number;
  stale: boolean;
  /** Unix milliseconds when the client received it (set by `fetchWorld`), so "as of N min ago" is computed without a clock in render. */
  fetchedAt: number;
}

// ---- decoding, leniently where the shape is the Worker's to settle (numbers or decimal strings), strictly for hashes and addresses.

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object";
function big(value: unknown, fallback: bigint | null = 0n): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (fallback === null) throw new ChainApiError("bad_response", "Expected an integer");
  return fallback;
}
function num(value: unknown, fallback: number | null = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (fallback === null) throw new ChainApiError("bad_response", "Expected a number");
  return fallback;
}
function hex32(value: unknown, name: string): Hex {
  if (typeof value !== "string" || !HEX32.test(value)) throw new ChainApiError("bad_response", `Expected ${name} to be bytes32`);
  return value as Hex;
}
function address(value: unknown): Address | null {
  return typeof value === "string" && ADDRESS.test(value) ? (value as Address) : null;
}
function pile(value: unknown): PileJson {
  const p = isRecord(value) ? value : {};
  return { btc: big(p.btc), eth: big(p.eth), hemi: big(p.hemi), runs: big(p.runs) };
}
/** The inherited code, 0–3; anything else (missing, out of range) is nothing inherited. */
function inheritedCode(value: unknown): number {
  const n = num(value, 0);
  return Number.isInteger(n) && n >= 0 && n <= 3 ? n : 0;
}
/** A source epoch, or null when missing or not a whole number. */
function epochOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = num(value, -1);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function decodeConfig(input: unknown): ChainConfig {
  if (!isRecord(input)) throw new ChainApiError("bad_response", "Config is not an object");
  const contract = address(input.contractAddress);
  return {
    enabled: input.enabled === true && contract !== null,
    chainId: num(input.chainId, HEMI_CHAIN_ID),
    rpcUrl: typeof input.rpcUrl === "string" && input.rpcUrl ? input.rpcUrl : null,
    contractAddress: contract,
    explorerUrl: typeof input.explorerUrl === "string" && input.explorerUrl ? input.explorerUrl.replace(/\/+$/, "") : null,
    gameVersion: typeof input.gameVersion === "number" ? input.gameVersion : null,
    gameVersionId: typeof input.gameVersionId === "string" && HEX32.test(input.gameVersionId) ? (input.gameVersionId as Hex) : null,
    epochSeconds: typeof input.epochSeconds === "number" ? input.epochSeconds : null,
    ticketSeconds: num(input.ticketSeconds, TICKET_SECONDS),
    reason: typeof input.reason === "string" ? input.reason : null,
  };
}

export function decodeTicket(input: unknown): Ticket {
  if (!isRecord(input)) throw new ChainApiError("bad_response", "Ticket is not an object");
  const seed = num(input.seed, null);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new ChainApiError("bad_response", "Ticket seed is not a uint32");
  const snapshot = isRecord(input.snapshot) ? input.snapshot : {};
  return {
    runId: hex32(input.runId, "runId"),
    seed,
    issuedAt: num(input.issuedAt, null),
    expiresAt: num(input.expiresAt, null),
    epoch: num(input.epoch),
    snapshotHash: hex32(input.snapshotHash, "snapshotHash"),
    sourceEpoch: epochOrNull(input.sourceEpoch),
    inherited: inheritedCode(input.inherited),
    snapshot: { btc: big(snapshot.btc), eth: big(snapshot.eth), hemi: big(snapshot.hemi), runs: big(snapshot.runs), dominant: num(snapshot.dominant) },
  };
}

export function decodeAttest(input: unknown): AttestResponse {
  if (!isRecord(input) || !isRecord(input.result)) throw new ChainApiError("bad_response", "Attestation is not an object");
  let result: RunResult;
  try { result = resultFromJson(input.result); } catch (error) { throw new ChainApiError("bad_response", (error as Error).message); }
  const signature = input.verifierSignature;
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new ChainApiError("bad_response", "Verifier signature is not 65 bytes");
  return { result, resultJson: input.result as unknown as RunResultJson, verifierSignature: signature as Hex, typedData: input.typedData ?? null };
}

/** A board's rows; a malformed row is dropped, not fatal. */
function keepers(value: unknown): Keeper[] {
  const top: Keeper[] = [];
  if (Array.isArray(value)) {
    for (const row of value) {
      if (!isRecord(row)) continue;
      const player = address(row.player);
      if (!player) continue;
      top.push({
        player, score: big(row.score), durationTicks: num(row.durationTicks),
        btcFed: num(row.btcFed), ethFed: num(row.ethFed), hemiFed: num(row.hemiFed),
        bestCombo: num(row.bestCombo), sizeCenti: num(row.sizeCenti), ending: num(row.ending), epoch: num(row.epoch),
        runId: typeof row.runId === "string" && HEX32.test(row.runId) ? (row.runId as Hex) : null,
        txHash: typeof row.txHash === "string" && HEX32.test(row.txHash) ? (row.txHash as Hex) : null,
      });
    }
  }
  return top;
}

function ledgerEpochs(value: unknown): LedgerEpoch[] {
  if (!Array.isArray(value)) return [];
  const epochs: LedgerEpoch[] = [];
  for (const row of value) {
    if (!isRecord(row) || !Number.isSafeInteger(row.epoch) || (row.epoch as number) < 0) continue;
    epochs.push({
      epoch: row.epoch as number,
      pile: pile(row),
      dominant: inheritedCode(row.dominant),
      inherited: row.inherited === null ? null : inheritedCode(row.inherited),
      sourceEpoch: epochOrNull(row.sourceEpoch),
      top: keepers(row.top),
    });
  }
  return epochs;
}

export function decodeWorld(input: unknown, fetchedAt = 0): World {
  if (!isRecord(input)) throw new ChainApiError("bad_response", "World is not an object");
  const piles = isRecord(input.pile) ? input.pile : {};
  const top = keepers(input.top);
  return {
    gameVersionId: typeof input.gameVersionId === "string" && HEX32.test(input.gameVersionId) ? (input.gameVersionId as Hex) : null,
    epoch: num(input.epoch),
    epochSeconds: num(input.epochSeconds),
    pile: { current: pile(piles.current), previous: pile(piles.previous), allTime: pile(piles.allTime) },
    top,
    epochs: ledgerEpochs(input.epochs),
    genesis: epochOrNull(input.genesis),
    inherited: inheritedCode(input.inherited),
    sourceEpoch: epochOrNull(input.sourceEpoch),
    updatedAt: num(input.updatedAt),
    stale: input.stale === true,
    fetchedAt,
  };
}

// ---- the calls.

export interface CallOptions { signal?: AbortSignal; baseUrl?: string }

/** One fetch with a timeout, the Worker's `{ error: { code, message } }` turned into a ChainApiError. */
export async function callChain(path: string, init: RequestInit, timeoutMs: number, options: CallOptions = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch(`${options.baseUrl ?? ""}${path}`, { ...init, signal: controller.signal, cache: "no-store" });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (controller.signal.aborted) throw new ChainApiError("timeout", `${path} took longer than ${timeoutMs} ms`);
      throw new ChainApiError("network", (error as Error).message || "Network error");
    }
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      const error = isRecord(body) && isRecord(body.error) ? body.error : null;
      const code = (error && typeof error.code === "string" ? error.code : response.status === 429 ? "rate_limited" : response.status === 503 ? "unavailable" : "bad_response") as ChainApiCode;
      const message = error && typeof error.message === "string" ? error.message : `${path} answered ${response.status}`;
      throw new ChainApiError(code, message, response.status);
    }
    return body;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}

export async function fetchConfig(options: CallOptions = {}): Promise<ChainConfig> {
  return decodeConfig(await callChain("/api/chain/config", { method: "GET" }, CONFIG_TIMEOUT_MS, options));
}

export async function requestTicket(options: CallOptions = {}): Promise<Ticket> {
  const body = await callChain("/api/chain/ticket", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, TICKET_TIMEOUT_MS, options);
  return decodeTicket(body);
}

export async function attest(request: AttestRequest, options: CallOptions = {}): Promise<AttestResponse> {
  const body = JSON.stringify({ runId: request.runId, player: request.player, commands: request.commands, endTick: request.endTick });
  return decodeAttest(await callChain("/api/chain/attest", { method: "POST", headers: { "Content-Type": "application/json" }, body }, ATTEST_TIMEOUT_MS, options));
}

/** The world, with one retry: the title reads it on every visit and a single dropped request should not blank the strip. */
export async function fetchWorld(options: CallOptions = {}): Promise<World> {
  try {
    return decodeWorld(await callChain("/api/chain/world", { method: "GET" }, WORLD_TIMEOUT_MS, options), Date.now());
  } catch (error) {
    if (options.signal?.aborted || !(error instanceof ChainApiError) || (error.code !== "timeout" && error.code !== "network" && error.code !== "unavailable")) throw error;
    return decodeWorld(await callChain("/api/chain/world", { method: "GET" }, WORLD_TIMEOUT_MS, options), Date.now());
  }
}

// ---- the chain, built from the config so a local chain (Hardhat's 31337) works in the end-to-end run.

export interface ChainInfo {
  id: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string | null;
  /** "Hemi" on Hemi, else the chain's name: the copy says "Pending on Hemi" only when it is. */
  label: string;
}

export function chainFromConfig(config: Pick<ChainConfig, "chainId" | "rpcUrl" | "explorerUrl"> | null): ChainInfo {
  const id = config?.chainId ?? HEMI_CHAIN_ID;
  const hemi = id === HEMI_CHAIN_ID;
  const name = hemi ? "Hemi Mainnet" : id === 31337 ? "Hardhat" : `Chain ${id}`;
  return {
    id, name,
    rpcUrl: config?.rpcUrl ?? (hemi ? HEMI_RPC_URL : ""),
    explorerUrl: config?.explorerUrl ?? (hemi ? HEMI_EXPLORER_URL : null),
    label: hemi ? "Hemi" : name,
  };
}

/** The explorer page for a transaction, or null when the chain has no explorer (the Worker sends `explorerUrl: null` off Hemi). */
export const txUrl = (chain: ChainInfo, txHash: Hex): string | null => (chain.explorerUrl ? `${chain.explorerUrl}/tx/${txHash}` : null);
/** The explorer page for an address (the registry, when a filing has no transaction of its own to point at). */
export const addressUrl = (chain: ChainInfo, address: Address): string | null => (chain.explorerUrl ? `${chain.explorerUrl}/address/${address}` : null);

/** A ticket is reusable while it is well inside its window: under five minutes old (L6: a spare ticket's snapshot should be the world the shift is about to start in). */
export const TICKET_REUSE_SECONDS = 5 * 60;
export const ticketIsFresh = (ticket: Ticket, nowSeconds: number) => nowSeconds - ticket.issuedAt < TICKET_REUSE_SECONDS && nowSeconds < ticket.expiresAt;
