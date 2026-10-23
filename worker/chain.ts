/**
 * The chain routes (docs/CHAIN.md §6, §10.3): config, ticket, attest, world.
 *
 * Thin by design. Replay and signing live in `verifier.ts`, the chain scan in
 * `indexer.ts`, the tables in `db/chainState.ts`. This file parses, checks
 * limits, orders the calls and shapes the JSON. It never logs a body, a
 * signature or a key, and it never signs anything `verifyRun` did not produce.
 */
import { bytesToHex, getAddress, isAddress, keccak256, type Address, type Hex } from "viem";
import { GAME_VERSION, type ArcadeCommand } from "../lib/game/arcade.ts";
import { decodeTrace, encodeTrace, MAX_TRACE_JSON_BYTES } from "../lib/chain/trace.ts";
import {
  DEADLINE_SECONDS, dominantOf, GAME_VERSION_ID, HEMI_CHAIN_ID, HEMI_EXPLORER_URL, HEMI_RPC_URL, inheritedOf, resultFromJson,
  resultToJson, resultTypedData, SIGNATURE_WINDOW_SECONDS, snapshotHashOf, sourceEpochOf, TICKET_SECONDS, SNAPSHOT_LOOKBACK, type Pile, type RunResult,
} from "../lib/chain/types.ts";
import {
  consumeRateLimit, issueRunTicket, readRunTicket, readRunTrace, refreshAttestation, storeAttestation, storeRunTrace, type D1Database, type RunTicketRecord,
} from "../db/chainState.ts";
import {
  chainIdOf, deployBlockOf, emptyPile, epochAt, immutablesOf, readWorld, refreshWorld, type PileTotals, type WorldEntry, type WorldSnapshot, type WorldView,
} from "./indexer.ts";
import { buildResult, hashTrace, payloadHashOf, signAttestation, VerifyError, verifyRun } from "./verifier.ts";

/** A stored signature with less than this long to live is re-dated instead of returned. */
const RESIGN_MARGIN_SECONDS = 2 * 60;
/** Once attested, the row is kept at least this long past the attestation, so a re-sign can still find it. */
const KEEP_AFTER_ATTEST_SECONDS = 2 * SIGNATURE_WINDOW_SECONDS;

export interface ChainEnv {
  DB?: D1Database;
  /** The indexer's RPC. Never echoed to clients. */
  HEMI_RPC_URL?: string;
  HEMI_RPC_FALLBACKS?: string;
  /** What `config.rpcUrl` reports — the endpoint browsers read receipts on. Default: Hemi's public RPC. */
  DNFI_PUBLIC_RPC_URL?: string;
  DNFI_CONTRACT_ADDRESS?: string;
  DNFI_VERIFIER_PRIVATE_KEY?: string;
  /** Defaults to Hemi Mainnet (43111); the local e2e sets 31337. */
  DNFI_CHAIN_ID?: string;
  /** Where the indexer starts. Required once the chain is on. */
  DNFI_DEPLOY_BLOCK?: string;
  /** Blocks behind the head the indexer stops; default 16, the local e2e sets 0. */
  DNFI_CONFIRMATIONS?: string;
  /** Optional copies of the contract's immutables, so a ticket's epoch is right before the indexer has run. */
  DNFI_GENESIS?: string;
  DNFI_EPOCH_SECONDS?: string;
  /**
   * Local chains only (ignored on Hemi): seconds added to the Worker's clock,
   * so the e2e can move a Hardhat chain a day ahead and have the Worker's
   * epoch follow it. Never set this against the real network.
   */
  DNFI_TEST_CLOCK_OFFSET_SECONDS?: string;
}

/** The Worker's clock: the test seam, else wall time plus the local-chain-only offset. */
function clockOf(env: ChainEnv, deps: ChainDeps): () => number {
  if (deps.now) return deps.now;
  const raw = env.DNFI_TEST_CLOCK_OFFSET_SECONDS?.trim();
  if (!raw || chainIdOrDefault(env) === HEMI_CHAIN_ID) return Date.now;
  const offset = Number(raw);
  if (!Number.isSafeInteger(offset)) throw new RouteError("unavailable", "DNFI_TEST_CLOCK_OFFSET_SECONDS is malformed");
  return () => Date.now() + offset * 1_000;
}

/** Test seams; production passes nothing. */
export interface ChainDeps {
  now?: () => number;
  fetchFn?: typeof fetch;
}

export type ErrorCode =
  | "disabled" | "rate_limited" | "bad_request" | "unknown_ticket" | "expired_ticket"
  | "invalid_trace" | "run_not_over" | "out_of_bounds" | "payload_conflict" | "player_conflict" | "unavailable";

const STATUS: Record<ErrorCode, number> = {
  disabled: 503, rate_limited: 429, bad_request: 400, unknown_ticket: 404, expired_ticket: 410,
  invalid_trace: 422, run_not_over: 422, out_of_bounds: 422, payload_conflict: 409, player_conflict: 409, unavailable: 503,
};

export const TICKET_LIMIT_PER_MINUTE = 30;
export const ATTEST_LIMIT_PER_MINUTE = 10;
export const TRACE_LIMIT_PER_MINUTE = 60;
/** The design's epoch length, reported until the contract's own value has been read. */
export const DEFAULT_EPOCH_SECONDS = 86_400;

const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const HEX32 = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

class RouteError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string, status = STATUS[code]) {
    super(message);
    this.name = "RouteError";
    this.code = code;
    this.status = status;
  }
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
const failure = (error: RouteError) =>
  json({ error: { code: error.code, message: error.message } }, error.status, error.code === "rate_limited" ? { "Retry-After": "60" } : {});

/** The env with every binding present and well-formed. */
interface Resolved { db: D1Database; contract: Address; privateKey: Hex; chainId: number }

/** Either the resolved env or the one-line reason the chain is off. */
function resolve(env: ChainEnv): Resolved | string {
  const { DB: db, DNFI_CONTRACT_ADDRESS: contract, DNFI_VERIFIER_PRIVATE_KEY: privateKey, DNFI_DEPLOY_BLOCK: deployBlock } = env;
  const missing: string[] = [];
  if (!db) missing.push("DB");
  if (!contract) missing.push("DNFI_CONTRACT_ADDRESS");
  if (!privateKey) missing.push("DNFI_VERIFIER_PRIVATE_KEY");
  if (!deployBlock?.trim()) missing.push("DNFI_DEPLOY_BLOCK");
  if (missing.length) return `Chain features are off: ${missing.join(", ")} not configured.`;
  if (!ADDRESS.test(contract!)) return "Chain features are off: DNFI_CONTRACT_ADDRESS is not an address.";
  if (!PRIVATE_KEY.test(privateKey!)) return "Chain features are off: DNFI_VERIFIER_PRIVATE_KEY is malformed.";
  let chainId: number;
  try { chainId = chainIdOf(env); } catch { return "Chain features are off: DNFI_CHAIN_ID is malformed."; }
  try { deployBlockOf(env); } catch { return "Chain features are off: DNFI_DEPLOY_BLOCK is malformed."; }
  return { db: db!, contract: contract as Address, privateKey: privateKey as Hex, chainId };
}

/** `CF-Connecting-IP` is set by Cloudflare on every request; anything else shares one bucket. */
function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Real-IP") ?? "unknown";
}

/**
 * The rate-limit bucket for a client address: an IPv4 as is, an IPv6 by its
 * /64 (one subscriber is usually handed a whole /64, so per-address buckets
 * would be a free pass), an IPv4-mapped IPv6 as the IPv4 it carries. Anything
 * unparseable is its own literal bucket.
 */
export function rateLimitBucket(ip: string): string {
  const raw = ip.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) return raw;
  if (!raw.includes(":")) return raw;
  const hextets = expandIpv6(raw);
  if (!hextets) return raw;
  const mapped = hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
  if (mapped) return `${hextets[6] >> 8}.${hextets[6] & 0xff}.${hextets[7] >> 8}.${hextets[7] & 0xff}`;
  return `${hextets.slice(0, 4).map((h) => h.toString(16)).join(":")}::/64`;
}

/** Eight hextets, or null when the text is not an IPv6 address. Handles `::` and a trailing dotted quad. */
function expandIpv6(text: string): number[] | null {
  let s = text.toLowerCase();
  const dotted = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const octets = dotted[1].split(".").map(Number);
    if (octets.some((o) => o > 255)) return null;
    s = `${s.slice(0, s.length - dotted[1].length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

/** POST bodies must say they are JSON (415 otherwise); a bare `application/json` or one with a charset. */
function requireJson(request: Request): void {
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new RouteError("bad_request", "Content-Type must be application/json", 415);
}

/** Read at most `max` bytes; refuse the body as a whole beyond that, before any JSON parse. */
async function readJsonBody(request: Request, max: number): Promise<unknown> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > max) throw new RouteError("bad_request", `Body exceeds ${max} bytes`, 413);
  const reader = request.body?.getReader();
  if (!reader) throw new RouteError("bad_request", "Missing body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new RouteError("bad_request", `Body exceeds ${max} bytes`, 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RouteError("bad_request", "Body is not valid JSON");
  }
}

async function limit(db: D1Database, route: string, request: Request, max: number, nowMs: number): Promise<void> {
  if (!(await consumeRateLimit(db, { bucketKey: `${route}:${rateLimitBucket(clientIp(request))}`, limit: max, nowMs }))) {
    throw new RouteError("rate_limited", "Too many requests from this address; try again in a minute");
  }
}

/* ------------------------------------------------------------------ *
 * The ticket's view of the world (docs/CHAIN.md §7, §10.1)
 * ------------------------------------------------------------------ */

/** The epoch a ticket is issued in, the epoch it inherits from (null: nothing), that epoch's pile and its dominant token (0–3). */
export interface TicketWorld { epoch: number; sourceEpoch: number | null; pile: PileTotals; inherited: number }

const asPile = (pile: PileTotals): Pile => ({ btc: BigInt(pile.btc), eth: BigInt(pile.eth), hemi: BigInt(pile.hemi), runs: BigInt(pile.runs) });

/**
 * The inherited world for `epoch` from the cached piles: the source epoch is
 * the greatest earlier epoch with runs within the lookback; its pile's
 * dominant token is the trait. No such epoch (or no cache) → nothing.
 */
export function inheritedWorld(epoch: number, piles: WorldSnapshot["piles"]): Omit<TicketWorld, "epoch"> {
  const source = sourceEpochOf(BigInt(epoch), (e) => { const p = piles[e.toString()]; return p ? { runs: BigInt(p.runs) } : undefined; });
  const pile = (source !== null && piles[source.toString()]) || emptyPile();
  return { sourceEpoch: source === null ? null : Number(source), pile, inherited: source === null ? 0 : dominantOf(asPile(pile)) };
}

/**
 * The epoch the ticket is issued in and what it inherits, from the cached
 * snapshot. With no cache and no env immutables the epoch is 0 and nothing is
 * inherited — the ticket still issues; filing never waits for the indexer.
 */
function ticketWorld(env: ChainEnv, snapshot: WorldSnapshot | null, nowSeconds: number): TicketWorld {
  const epoch = epochAt(immutablesOf(env, snapshot), nowSeconds) ?? 0;
  return { epoch, ...inheritedWorld(epoch, snapshot?.piles ?? {}) };
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

async function config(env: ChainEnv): Promise<Response> {
  const resolved = resolve(env);
  const enabled = typeof resolved !== "string";
  let epochSeconds: number | null = null;
  if (enabled) {
    const cached = await readWorld(env, resolved.db).catch(() => null);
    epochSeconds = immutablesOf(env, cached?.snapshot ?? null).epochSeconds;
  }
  const chainId = enabled ? resolved.chainId : chainIdOrDefault(env);
  return json({
    enabled,
    chainId,
    contractAddress: enabled ? resolved.contract : null,
    explorerUrl: chainId === HEMI_CHAIN_ID ? HEMI_EXPLORER_URL : null,
    rpcUrl: publicRpcUrlOf(env),
    gameVersion: GAME_VERSION,
    gameVersionId: GAME_VERSION_ID,
    epochSeconds: epochSeconds ?? DEFAULT_EPOCH_SECONDS,
    ticketSeconds: TICKET_SECONDS,
    ...(enabled ? {} : { reason: resolved }),
  });
}

/** The public read endpoint browsers poll receipts on. Never the indexer's `HEMI_RPC_URL`, which may be a keyed or private endpoint. */
function publicRpcUrlOf(env: ChainEnv): string {
  const url = env.DNFI_PUBLIC_RPC_URL?.trim();
  return url && /^https?:\/\//.test(url) ? url : HEMI_RPC_URL;
}

function chainIdOrDefault(env: ChainEnv): number {
  try { return chainIdOf(env); } catch { return HEMI_CHAIN_ID; }
}

function randomHex(bytes: number): Hex {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return `0x${Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function randomUint32(): number {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
}

/** The snapshot hash's preimage, as the trace record keeps it so anyone can recompute `snapshotHashOf`. */
export interface SnapshotPreimage { epoch: number; sourceEpoch: number | null; btc: string; eth: string; hemi: string; runs: string }
function snapshotPreimage(world: TicketWorld): SnapshotPreimage {
  return { epoch: world.epoch, sourceEpoch: world.sourceEpoch, btc: String(world.pile.btc), eth: String(world.pile.eth), hemi: String(world.pile.hemi), runs: String(world.pile.runs) };
}

/**
 * Keep the canonical trace behind an attestation (docs/CHAIN.md §3): the
 * bytes whose keccak the contract records, with everything a stranger needs
 * to replay them. Immutable, never swept; a repeat is a no-op.
 */
async function keepTrace(db: D1Database, record: RunTicketRecord, body: AttestBody, resultJson: string, nowSeconds: number): Promise<void> {
  const trace = encodeTrace(body.commands as ArcadeCommand[], body.endTick);
  const fallback: SnapshotPreimage = { epoch: record.epoch ?? 0, sourceEpoch: record.sourceEpoch, btc: "0", eth: "0", hemi: "0", runs: "0" };
  await storeRunTrace(db, {
    runId: body.runId, gameVersion: record.gameVersion ?? GAME_VERSION_ID, seed: record.seed, inherited: record.inherited ?? 0,
    epoch: record.epoch ?? 0, sourceEpoch: record.sourceEpoch, snapshotJson: record.snapshotJson ?? JSON.stringify(fallback),
    snapshotHash: record.snapshotHash ?? "", endTick: body.endTick, traceHash: keccak256(trace), trace, resultJson, storedAt: nowSeconds,
  });
}

async function ticket(env: ChainEnv, r: Resolved, request: Request, deps: ChainDeps): Promise<Response> {
  const nowMs = clockOf(env, deps)();
  await limit(r.db, "ticket", request, TICKET_LIMIT_PER_MINUTE, nowMs);
  requireJson(request);
  const issuedAt = Math.floor(nowMs / 1_000);
  const cached = await readWorld(env, r.db).catch(() => null);
  const world = ticketWorld(env, cached?.snapshot ?? null, issuedAt);
  const snapshotHash = snapshotHashOf(BigInt(world.epoch), BigInt(world.sourceEpoch ?? 0), asPile(world.pile));
  const runId = randomHex(32);
  const seed = randomUint32();
  const expiresAt = issuedAt + TICKET_SECONDS;
  await issueRunTicket(r.db, {
    runId, issuedAt, seed: String(seed), expiresAt, gameVersion: GAME_VERSION_ID, epoch: world.epoch, snapshotHash,
    sourceEpoch: world.sourceEpoch, inherited: world.inherited,
    snapshotJson: JSON.stringify(snapshotPreimage(world)),
  });
  return json({
    runId, seed, issuedAt, expiresAt, epoch: world.epoch, sourceEpoch: world.sourceEpoch, inherited: world.inherited, snapshotHash,
    snapshot: { ...world.pile, dominant: world.inherited },
  });
}

interface AttestBody { runId: Hex; player: Address; commands: unknown; endTick: number }

function parseAttestBody(body: unknown): AttestBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RouteError("bad_request", "Body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b.runId !== "string" || !HEX32.test(b.runId)) throw new RouteError("bad_request", "runId must be a 0x-prefixed 32-byte hex string");
  // Strict: a mixed-case address must carry a valid EIP-55 checksum; all-lowercase is accepted and checksummed here.
  if (typeof b.player !== "string" || !isAddress(b.player, { strict: true })) throw new RouteError("bad_request", "player must be an address (with a valid checksum if mixed-case)");
  if (!Number.isSafeInteger(b.endTick)) throw new RouteError("bad_request", "endTick must be an integer");
  if (!Array.isArray(b.commands)) throw new RouteError("bad_request", "commands must be an array");
  return { runId: b.runId.toLowerCase() as Hex, player: getAddress(b.player), commands: b.commands, endTick: b.endTick as number };
}

function checkTicket(record: RunTicketRecord | null, nowSeconds: number): RunTicketRecord {
  if (!record) throw new RouteError("unknown_ticket", "No such ticket");
  if (record.expiresAt < nowSeconds) throw new RouteError("expired_ticket", "The ticket has expired; start a new shift");
  if ((record.gameVersion ?? "").toLowerCase() !== GAME_VERSION_ID.toLowerCase() || !HEX32.test(record.snapshotHash ?? "")) {
    throw new RouteError("expired_ticket", "The ticket was issued for another version of the rules; start a new shift");
  }
  return record;
}

/** The domain type a raw `eth_signTypedData_v4` call needs; viem adds the same one itself. */
const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" }, { name: "version", type: "string" },
  { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
] as const;

/** The stored result and signature, plus the complete typed-data payload the player signs. */
function attestResponse(r: Resolved, resultJson: string, verifierSignature: string): Response {
  const result = resultFromJson(JSON.parse(resultJson));
  const typed = resultTypedData(result, r.contract, r.chainId);
  return json({
    result: resultToJson(result),
    verifierSignature,
    typedData: {
      domain: typed.domain, types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...typed.types },
      primaryType: typed.primaryType, message: resultToJson(result),
    },
  });
}

const sameAddress = (a: string | null, b: string) => (a ?? "").toLowerCase() === b.toLowerCase();

/** The wallet a run was first attested for, shortened for an error message (never a secret: it is the player's own public address). */
const shortAddress = (address: string | null) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "another wallet");

/** The run is bound to the wallet of its first attestation: nobody — not even the player from a second account — gets it signed for another address. */
function requireSamePlayer(row: RunTicketRecord, stored: RunResult, player: Address): void {
  if (sameAddress(row.player, player) && sameAddress(stored.player, player)) return;
  throw new RouteError("player_conflict", `This shift was signed for ${shortAddress(row.player ?? stored.player)}; switch back to that wallet`);
}

/**
 * The same payload again, on a row that already holds an attestation of it,
 * from the wallet it was attested for (any other wallet is `player_conflict`:
 * a run id that leaks cannot be filed under someone else's name). With time
 * left on the signature: the stored answer. With the window nearly out: the
 * stored result re-dated, re-signed and swapped in with a CAS on the
 * signature the row showed. A lost CAS (a concurrent re-sign) is decided
 * again on the row as it then stands, once; the ticket's expiry caps it all,
 * and the contract refuses the runId twice whatever the deadline says.
 */
async function repeatAttest(r: Resolved, record: RunTicketRecord, body: AttestBody, payloadHash: Hex, nowSeconds: number): Promise<Response> {
  let row = record;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!row.verifierSignature || !row.resultJson) throw new RouteError("expired_ticket", "The ticket expired before the attestation was re-signed");
    if (row.payloadHash !== payloadHash) throw new RouteError("payload_conflict", "This ticket has already attested a different run");
    const stored = resultFromJson(JSON.parse(row.resultJson));
    requireSamePlayer(row, stored, body.player);
    if (stored.deadline >= BigInt(nowSeconds + RESIGN_MARGIN_SECONDS)) return attestResponse(r, row.resultJson, row.verifierSignature);
    const fresh = { ...stored, deadline: BigInt(nowSeconds + DEADLINE_SECONDS) };
    const signature = await signAttestation(fresh, r.contract, r.chainId, r.privateKey);
    const after = await refreshAttestation(r.db, {
      runId: body.runId, payloadHash, previousSignature: row.verifierSignature, verifierSignature: signature,
      attestedAt: nowSeconds, player: body.player, resultJson: JSON.stringify(resultToJson(fresh)),
    });
    if (!after || after.expiresAt < nowSeconds || !after.verifierSignature || !after.resultJson) {
      throw new RouteError("expired_ticket", "The ticket expired before the attestation was re-signed");
    }
    if (after.verifierSignature === signature) return attestResponse(r, after.resultJson, after.verifierSignature);
    row = after; // Someone else re-signed first; decide again on what they stored.
  }
  throw new Error("Lost the attestation re-sign twice");
}

async function attest(env: ChainEnv, r: Resolved, request: Request, deps: ChainDeps): Promise<Response> {
  const nowMs = clockOf(env, deps)();
  const nowSeconds = Math.floor(nowMs / 1_000);
  await limit(r.db, "attest", request, ATTEST_LIMIT_PER_MINUTE, nowMs);
  requireJson(request);
  const body = parseAttestBody(await readJsonBody(request, MAX_TRACE_JSON_BYTES));
  const record = checkTicket(await readRunTicket(r.db, body.runId), nowSeconds);
  const payloadHash = payloadHashOf(body.runId, hashTrace(body.commands, body.endTick), body.endTick);
  if (record.verifierSignature) {
    if (record.payloadHash === payloadHash && record.resultJson) await keepTrace(r.db, record, body, record.resultJson, nowSeconds);
    return repeatAttest(r, record, body, payloadHash, nowSeconds);
  }
  const seed = Number(record.seed);
  // The trait comes from the ticket row (a pre-migration null reads as none), never from the request.
  const metrics = verifyRun({ seed, commands: body.commands, endTick: body.endTick, inherited: inheritedOf(record.inherited ?? 0) });
  const result = buildResult({ runId: body.runId, seed, snapshotHash: record.snapshotHash as Hex }, body.player, metrics, nowSeconds);
  const verifierSignature = await signAttestation(result, r.contract, r.chainId, r.privateKey);
  const stored = await storeAttestation(r.db, {
    runId: body.runId, payloadHash, verifierSignature, attestedAt: nowSeconds, player: body.player,
    resultJson: JSON.stringify(resultToJson(result)), keepUntil: nowSeconds + KEEP_AFTER_ATTEST_SECONDS,
  });
  if (stored.status === "conflict") throw new RouteError("payload_conflict", "This ticket has already attested a different run");
  if (stored.status === "missing") throw new RouteError("expired_ticket", "The ticket expired before the attestation was stored");
  if (!stored.record.resultJson || !stored.record.verifierSignature) throw new Error("Stored attestation has no result");
  await keepTrace(r.db, stored.record, body, stored.record.resultJson, nowSeconds);
  // Lost the first store to the same payload from another wallet: that wallet owns the run now.
  requireSamePlayer(stored.record, resultFromJson(JSON.parse(stored.record.resultJson)), body.player);
  return attestResponse(r, stored.record.resultJson, stored.record.verifierSignature);
}

/**
 * `GET /api/chain/trace?runId=0x…` — the record behind a filed shift, for
 * anyone: the canonical trace bytes (keccak = the `traceHash` on chain), the
 * commands decoded, the seed and the trait, the snapshot's preimage, and what
 * the verifier attested. `scripts/verify-filing.mjs` replays it against the chain.
 */
async function trace(env: ChainEnv, r: Resolved, request: Request, deps: ChainDeps): Promise<Response> {
  const nowMs = clockOf(env, deps)();
  await limit(r.db, "trace", request, TRACE_LIMIT_PER_MINUTE, nowMs);
  const runId = new URL(request.url).searchParams.get("runId") ?? "";
  if (!HEX32.test(runId)) throw new RouteError("bad_request", "runId must be 32 bytes of hex");
  const row = await readRunTrace(r.db, runId.toLowerCase());
  if (!row) throw new RouteError("unknown_ticket", "No trace for this run id", 404);
  const { commands, endTick } = decodeTrace(row.trace);
  const snapshot = JSON.parse(row.snapshotJson) as SnapshotPreimage;
  return json({
    runId: row.runId, gameVersionId: row.gameVersion, chainId: r.chainId, contractAddress: r.contract,
    seed: Number(row.seed), inherited: row.inherited, trait: inheritedOf(row.inherited),
    epoch: row.epoch, sourceEpoch: row.sourceEpoch, snapshot, snapshotHash: row.snapshotHash,
    endTick, commands, traceHash: row.traceHash, trace: bytesToHex(row.trace),
    attested: JSON.parse(row.resultJson), storedAt: row.storedAt,
  }, 200, { "Cache-Control": "public, max-age=300" });
}

/** How many epochs the ledger page lists (the current one first, then the most recent with runs). */
export const LEDGER_EPOCHS = 8;

const entryJson = ({ player, score, durationTicks, btcFed, ethFed, hemiFed, bestCombo, sizeCenti, ending, epoch, runId, txHash, blockNumber }: WorldEntry) =>
  ({ player, score, durationTicks, btcFed, ethFed, hemiFed, bestCombo, sizeCenti, ending, epoch, runId, txHash, blockNumber });

/**
 * The ledger's epochs: the current one (even before anyone filed in it) and
 * the most recent epochs with runs, newest first. Each says what it was fed,
 * the coin it passed on (`dominant`), and the trait its own creature came in
 * with (`inherited`, from `sourceEpoch`) — null when that look-back reaches
 * past what the snapshot still keeps, so "unknown" is never shown as "nothing".
 */
export function ledgerEpochs(snapshot: WorldSnapshot, currentEpoch: number | null) {
  const kept = Object.keys(snapshot.piles).map(Number).sort((a, b) => b - a);
  const listed = currentEpoch !== null && !kept.includes(currentEpoch) ? [currentEpoch, ...kept] : kept;
  const oldestKept = kept.length ? kept[kept.length - 1] : null;
  const keptRuns = kept.reduce((sum, e) => sum + snapshot.piles[String(e)].runs, 0);
  const pruned = snapshot.allTime.runs > keptRuns;
  return listed.filter((e) => currentEpoch === null || e <= currentEpoch).slice(0, LEDGER_EPOCHS).map((e) => {
    const pile = snapshot.piles[String(e)] ?? emptyPile();
    const inh = inheritedWorld(e, snapshot.piles);
    const known = inh.sourceEpoch !== null || !pruned || (oldestKept !== null && e - SNAPSHOT_LOOKBACK >= oldestKept);
    return {
      epoch: e, ...pile, dominant: pile.runs > 0 ? dominantOf(asPile(pile)) : 0,
      sourceEpoch: known ? inh.sourceEpoch : null, inherited: known ? inh.inherited : null,
      top: (snapshot.epochTop[String(e)] ?? []).map(entryJson),
    };
  });
}

function worldResponse(env: ChainEnv, view: WorldView, nowSeconds: number): Response {
  const { snapshot } = view;
  const immutables = immutablesOf(env, snapshot);
  const epoch = epochAt(immutables, nowSeconds);
  const pileAt = (e: number | null) => (e === null || e < 0 ? emptyPile() : snapshot.piles[String(e)] ?? emptyPile());
  const inherited = epoch === null ? { sourceEpoch: null, inherited: 0 } : inheritedWorld(epoch, snapshot.piles);
  return json({
    gameVersionId: GAME_VERSION_ID,
    epoch,
    epochSeconds: immutables.epochSeconds ?? DEFAULT_EPOCH_SECONDS,
    genesis: immutables.genesis,
    sourceEpoch: inherited.sourceEpoch,
    inherited: inherited.inherited,
    pile: { current: pileAt(epoch), previous: pileAt(epoch === null ? null : epoch - 1), allTime: snapshot.allTime },
    top: snapshot.top.map(entryJson),
    epochs: ledgerEpochs(snapshot, epoch),
    updatedAt: view.updatedAt,
    cursor: snapshot.cursor,
    stale: view.stale,
  });
}

async function world(env: ChainEnv, r: Resolved, deps: ChainDeps): Promise<Response> {
  const nowMs = clockOf(env, deps)();
  const view = await refreshWorld(env, r.db, { nowMs, fetchFn: deps.fetchFn });
  return worldResponse(env, view, Math.floor(nowMs / 1_000));
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

const ROUTES: Record<string, "GET" | "POST"> = {
  "/api/chain/config": "GET", "/api/chain/ticket": "POST", "/api/chain/attest": "POST", "/api/chain/world": "GET",
  "/api/chain/trace": "GET",
};

async function dispatch(path: string, request: Request, env: ChainEnv, deps: ChainDeps): Promise<Response> {
  const method = ROUTES[path];
  if (!method) throw new RouteError("bad_request", "No such route", 404);
  if (request.method !== method) throw new RouteError("bad_request", `Use ${method}`, 405);
  if (path === "/api/chain/config") return config(env);
  const resolved = resolve(env);
  if (typeof resolved === "string") throw new RouteError("disabled", resolved);
  if (path === "/api/chain/ticket") return ticket(env, resolved, request, deps);
  if (path === "/api/chain/trace") return trace(env, resolved, request, deps);
  if (path === "/api/chain/attest") return attest(env, resolved, request, deps);
  return world(env, resolved, deps);
}

/** `null` for any path outside `/api/chain/`, so the Worker falls through to the app. */
export async function handleChainRequest(request: Request, env: ChainEnv, deps: ChainDeps = {}): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/chain/")) return null;
  try {
    return await dispatch(path, request, env, deps);
  } catch (error) {
    if (error instanceof RouteError) return failure(error);
    if (error instanceof VerifyError) return failure(new RouteError(error.code, error.message));
    // Server faults only. Never the body, never a signature, never a key.
    console.error(`[dnfi] ${path} failed: ${error instanceof Error ? error.name : "unknown error"}`);
    return failure(new RouteError("unavailable", "The verifier could not complete the request; try again"));
  }
}
