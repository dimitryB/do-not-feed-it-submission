/**
 * The ledger: filing a shift on the chain, as a state machine (docs/CHAIN.md
 * §8). `reduce` is pure and `runLedger` walks the steps through injected
 * dependencies, so both are unit-tested without a browser, a wallet or a
 * network (tests/ledger.test.mjs). The React panel (`app/components/Ledger.tsx`)
 * only renders the state and wires the real dependencies in.
 *
 *   off ──────────────────────────────────────────────────────────────┐
 *   ready → connecting → attesting → signing → sending → confirming → filed
 *             │             │           │          │          │
 *             └─────────────┴───────────┴──────────┴──────────┴──→ failed → (retry) ready
 *                                                                        └→ (skip) off
 *
 * What is signed is never what the server sent: the result is decoded
 * strictly (`resultFromJson`), checked against the ticket, the trace, the
 * connected wallet and the numbers the page itself showed on the report
 * (`played`), rebuilt into typed data with `resultTypedData`, and that is
 * what the wallet signs. The server's own typed data, when it sends one,
 * must be identical or nothing is signed.
 */
import type { Address, Hex } from "viem";
import { GAME_VERSION_ID, SIGNATURE_WINDOW_SECONDS, causeCode, resultTypedData, seedToBytes32, type RunResult } from "./types.ts";
import { traceHash } from "./trace.ts";
import { ChainApiError, type AttestRequest, type AttestResponse, type Ticket } from "./api.ts";
import type { ArcadeCommand, ArcadeState } from "../game/arcade.ts";

/** Why a filing stopped. Wallet codes, the Worker's codes, and the machine's own (`mismatch`, `clock`). */
export type FailureCode =
  | "no_wallet" | "rejected" | "wrong_chain" | "insufficient_funds" | "reverted" | "reverted_onchain" | "network" | "unknown"
  | "timeout" | "disabled" | "rate_limited" | "bad_request" | "unknown_ticket" | "expired_ticket" | "invalid_trace"
  | "run_not_over" | "payload_conflict" | "player_conflict" | "out_of_bounds" | "unavailable" | "bad_response" | "mismatch" | "clock"
  | "replaced";
export type RevertName = "InvalidResult" | "InvalidSignature" | "DuplicateRun" | "WrongVersion" | "Expired";
export type Step = "connecting" | "attesting" | "signing" | "sending" | "confirming";

export interface Failure {
  code: FailureCode;
  /** The contract's custom error, when the chain refused it and it decoded. */
  revert: RevertName | null;
  /** The raw message, for the console and the QA notes; never the only thing shown. */
  detail: string;
  /** The step it failed at. */
  at: Step;
  /** A transaction that was sent before the failure (a reverted receipt), for the explorer link. */
  txHash: Hex | null;
}

/**
 * `result` rides from `signing` to `filed` so the report can say what went
 * into the pile; it is null after a resume (the transaction is remembered,
 * the numbers are not). `fedPile` is whether the receipt carried a `PileFed`
 * (a wallet's first three filings in an epoch feed the pile); null when no
 * receipt of ours was read. A filing found already on the chain (`already`: the
 * contract said DuplicateRun and `usedRunIds` agrees) is `filed` with no
 * transaction and no block of its own.
 */
export type LedgerState =
  | { status: "off"; reason: "disabled" | "practice" | "skipped" }
  | { status: "ready" }
  | { status: "connecting" }
  | { status: "attesting"; player: Address }
  | { status: "signing"; player: Address; result: RunResult }
  | { status: "sending"; player: Address; result: RunResult }
  | { status: "confirming"; player: Address | null; txHash: Hex; stalled: boolean; result: RunResult | null }
  | { status: "filed"; player: Address | null; txHash: Hex | null; blockNumber: bigint | null; best: bigint | null; result: RunResult | null; epoch: bigint | null; fedPile: boolean | null }
  | { status: "failed"; failure: Failure };

export type LedgerEvent =
  | { type: "start" }
  | { type: "connected"; player: Address }
  | { type: "attested"; result: RunResult }
  | { type: "signed" }
  | { type: "sent"; txHash: Hex }
  | { type: "stalled" }
  | { type: "filed"; blockNumber: bigint; best: bigint | null; epoch: bigint; fedPile: boolean }
  | { type: "already"; best: bigint | null }
  | { type: "failed"; failure: Failure }
  | { type: "retry" }
  | { type: "skip" }
  | { type: "cancel" }
  | { type: "resume"; txHash: Hex; player: Address | null };

export const OFF_DISABLED: LedgerState = { status: "off", reason: "disabled" };
export const OFF_PRACTICE: LedgerState = { status: "off", reason: "practice" };
export const READY: LedgerState = { status: "ready" };

const ACTIVE: readonly LedgerState["status"][] = ["connecting", "attesting", "signing", "sending", "confirming"];
export const isActive = (state: LedgerState) => ACTIVE.includes(state.status);
/** Before the transaction is out, a step can be cancelled; after it, there is nothing to cancel. */
export const isCancellable = (state: LedgerState) => state.status === "connecting" || state.status === "attesting" || state.status === "signing";

/** Pure. An event that does not apply to the state leaves it unchanged. */
export function reduce(state: LedgerState, event: LedgerEvent): LedgerState {
  switch (event.type) {
    case "start": return state.status === "ready" || state.status === "failed" ? { status: "connecting" } : state;
    case "connected": return state.status === "connecting" ? { status: "attesting", player: event.player } : state;
    case "attested": return state.status === "attesting" ? { status: "signing", player: state.player, result: event.result } : state;
    case "signed": return state.status === "signing" ? { status: "sending", player: state.player, result: state.result } : state;
    case "sent": return state.status === "sending" ? { status: "confirming", player: state.player, txHash: event.txHash, stalled: false, result: state.result } : state;
    case "stalled": return state.status === "confirming" ? { ...state, stalled: true } : state;
    case "filed": return state.status === "confirming" ? { status: "filed", player: state.player, txHash: state.txHash, blockNumber: event.blockNumber, best: event.best, result: state.result, epoch: event.epoch, fedPile: event.fedPile } : state;
    case "already": return state.status === "sending" || state.status === "confirming" ? { status: "filed", player: state.player, txHash: null, blockNumber: null, best: event.best, result: state.result, epoch: null, fedPile: null } : state;
    case "failed": return isActive(state) ? { status: "failed", failure: event.failure } : state;
    case "retry": return state.status === "failed" || (state.status === "confirming" && state.stalled) ? READY : state;
    case "skip": return state.status === "failed" ? { status: "off", reason: "skipped" } : state;
    case "cancel": return isCancellable(state) ? READY : state;
    case "resume": return state.status === "ready" || state.status === "off" || state.status === "failed" ? { status: "confirming", player: event.player, txHash: event.txHash, stalled: false, result: null } : state;
    default: return state;
  }
}

// ---- the driver.

export interface Receipt { status: "success" | "reverted"; blockNumber: bigint; txHash: Hex; recorded: { epoch: bigint; player: Address; fedPile: boolean } | null }

/** A transaction out on the chain, kept across a reload. */
export interface Filing { runId: Hex; txHash: Hex; player: Address | null; status: "pending" | "filed" | "reverted"; blockNumber: string | null; sentAt: number }

export interface FilingStore {
  read(): Filing | null;
  write(filing: Filing | null): void;
}

/** Everything the driver needs from the world, so a test can hand it fakes. */
export interface LedgerDeps {
  /** Connects the wallet and returns the account. */
  connect(signal: AbortSignal): Promise<Address>;
  /** Switches the wallet to the chain, adding it if it must. */
  ensureChain(signal: AbortSignal): Promise<void>;
  attest(request: AttestRequest, signal: AbortSignal): Promise<AttestResponse>;
  sign(typedData: ReturnType<typeof resultTypedData>, player: Address): Promise<Hex>;
  send(result: RunResult, playerSignature: Hex, verifierSignature: Hex, player: Address): Promise<Hex>;
  /** Resolves null when the cap passes without a receipt; `recorded` says whether the mined transaction filed `runId`. */
  waitForReceipt(txHash: Hex, runId: Hex, timeoutMs: number, signal: AbortSignal): Promise<Receipt | null>;
  /** The player's best on the contract after filing; null when it cannot be read (the filing still stands). */
  bestScore(player: Address): Promise<bigint | null>;
  /** `usedRunIds(runId)` on the contract: whether this shift is already on the chain (asked after a DuplicateRun refusal). */
  usedRunId(runId: Hex): Promise<boolean>;
  store: FilingStore;
  /** Unix seconds. */
  now(): number;
  /** The receipt cap; 90 s unless a harness shortens it. */
  receiptTimeoutMs?: number;
}

/** The numbers the report showed, as the contract names them; the verifier's answer must agree with every one. */
export interface PlayedNumbers {
  score: bigint; totalFeeds: number;
  btcFed: number; ethFed: number; hemiFed: number;
  bestCombo: number; frenzies: number; sizeCenti: number;
  ending: number; cause: number;
}

/** The page's final state as `PlayedNumbers` (docs/CHAIN.md §4): servings by token, size in centi-units, the cause as its code (−1 while the shift has not ended). */
export function playedNumbers(state: Pick<ArcadeState, "score" | "totalFeeds" | "servings" | "bestCombo" | "frenzies" | "size" | "ending" | "failureReason">): PlayedNumbers {
  return {
    score: BigInt(Math.round(state.score)), totalFeeds: state.totalFeeds,
    btcFed: state.servings.metal, ethFed: state.servings.balloon, hemiFed: state.servings.pepper,
    bestCombo: state.bestCombo, frenzies: state.frenzies, sizeCenti: Math.round(state.size * 100),
    ending: state.ending, cause: state.failureReason === null ? -1 : causeCode(state.failureReason),
  };
}

export interface LedgerInput {
  ticket: Ticket;
  commands: readonly ArcadeCommand[];
  endTick: number;
  /** What the report shows; a verifier answer with other numbers is never signed (M2). */
  played: PlayedNumbers;
  contractAddress: Address;
  chainId: number;
}

export interface RunOptions {
  input: LedgerInput;
  deps: LedgerDeps;
  /** Called with every state the machine passes through. */
  emit: (state: LedgerState) => void;
  signal: AbortSignal;
  /** Start from a transaction already sent (a reload, or "Check again"). */
  resume?: { txHash: Hex; player: Address | null } | null;
}

export const RECEIPT_TIMEOUT_MS = 90_000;

export class LedgerAbort extends Error { constructor() { super("Ledger cancelled"); this.name = "LedgerAbort"; } }
const checkpoint = (signal: AbortSignal) => { if (signal.aborted) throw new LedgerAbort(); };
/** The contract's DuplicateRun(), as wallet.ts classifies it (`code: "reverted", revert: "DuplicateRun"`). */
const isDuplicateRun = (error: unknown): boolean =>
  (error as { code?: unknown })?.code === "reverted" && (error as { revert?: unknown })?.revert === "DuplicateRun";

/** Any thrown thing as a Failure at the step it happened. */
export function toFailure(error: unknown, at: Step, txHash: Hex | null = null): Failure {
  const detail = String((error as { message?: unknown })?.message ?? error);
  if (error instanceof ChainApiError) return { code: error.code, revert: null, detail, at, txHash };
  const code = (error as { code?: unknown })?.code;
  const revert = (error as { revert?: unknown })?.revert;
  const KNOWN: readonly FailureCode[] = ["no_wallet", "rejected", "wrong_chain", "insufficient_funds", "reverted", "network", "unknown", "mismatch", "clock"];
  if (typeof code === "string" && (KNOWN as readonly string[]).includes(code)) {
    return { code: code as FailureCode, revert: typeof revert === "string" ? (revert as RevertName) : null, detail, at, txHash };
  }
  return { code: "unknown", revert: null, detail, at, txHash };
}

/** Bigints as strings and keys sorted, so two typed-data objects compare as the bytes they would sign. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v) => {
    if (typeof v === "bigint") return v.toString();
    if (v && typeof v === "object" && !Array.isArray(v)) return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
    return v;
  });
}

/** A field of the verifier's answer that disagrees with the shift: `mismatch:<field>`, or `clock` when it is only the deadline against this computer's clock. */
export class MismatchError extends Error {
  readonly code: "mismatch" | "clock";
  readonly field: string;
  constructor(field: string, code: "mismatch" | "clock" = "mismatch") { super(`${code}:${field}`); this.name = "MismatchError"; this.code = code; this.field = field; }
}

/** The fields of the result that are the page's own numbers, compared one by one (M2); the diet before the total it sums to, so the named field is the one that moved. */
const PLAYED_FIELDS: readonly (keyof PlayedNumbers)[] = ["score", "btcFed", "ethFed", "hemiFed", "totalFeeds", "bestCombo", "frenzies", "sizeCenti", "ending", "cause"];

/**
 * The checks between the verifier's answer and the shift that was played.
 * Throws a MismatchError naming the first field that disagrees; returns the
 * typed data to sign, built here, never taken from the response.
 * `receivedSeconds` is the clock when the answer arrived (unix seconds): the
 * deadline is judged against that moment, and a deadline outside the window
 * is a `clock` failure (this computer's clock, most likely), not a mismatch.
 */
export function verifyAttestation(response: AttestResponse, input: LedgerInput, player: Address, receivedSeconds: number) {
  const r = response.result;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!same(r.runId, input.ticket.runId)) throw new MismatchError("runId");
  if (!same(r.player, player)) throw new MismatchError("player");
  if (!same(r.gameVersion, GAME_VERSION_ID)) throw new MismatchError("gameVersion");
  if (!same(r.seed, seedToBytes32(input.ticket.seed))) throw new MismatchError("seed");
  if (!same(r.snapshotHash, input.ticket.snapshotHash)) throw new MismatchError("snapshotHash");
  if (r.durationTicks !== input.endTick) throw new MismatchError("durationTicks");
  if (!same(r.traceHash, traceHash(input.commands, input.endTick))) throw new MismatchError("traceHash");
  if (r.totalFeeds !== r.btcFed + r.ethFed + r.hemiFed) throw new MismatchError("totalFeeds");
  // The numbers on the report are the numbers that get signed, or nothing is.
  for (const field of PLAYED_FIELDS) if (r[field] !== input.played[field]) throw new MismatchError(field);
  const deadline = Number(r.deadline);
  if (deadline < receivedSeconds - 60 || deadline > receivedSeconds + SIGNATURE_WINDOW_SECONDS + 60) throw new MismatchError("deadline", "clock");
  const typedData = resultTypedData(r, input.contractAddress, input.chainId);
  if (response.typedData !== null && response.typedData !== undefined && canonical(stripDomainType(response.typedData)) !== canonical(typedData)) throw new MismatchError("typedData");
  return typedData;
}

/** The `EIP712Domain` entry is the eth_signTypedData_v4 envelope, not a field: the wallet adds it, the Worker may send it, the comparison ignores it. */
function stripDomainType(typedData: unknown): unknown {
  if (!typedData || typeof typedData !== "object") return typedData;
  const t = typedData as Record<string, unknown>;
  if (!t.types || typeof t.types !== "object") return typedData;
  const { EIP712Domain: _domain, ...types } = t.types as Record<string, unknown>;
  void _domain;
  return { ...t, types };
}

/**
 * Walks the steps, emitting each state. Resolves with the final state; a
 * cancellation (the signal) stops between steps without emitting anything
 * more. Never throws for a failure — that is a state.
 */
export async function runLedger({ input, deps, emit, signal, resume = null }: RunOptions): Promise<LedgerState> {
  let state: LedgerState = READY;
  const step = (event: LedgerEvent) => { state = reduce(state, event); emit(state); return state; };
  const cap = deps.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS;
  const fail = (error: unknown, at: Step, txHash: Hex | null = null) => {
    if (error instanceof LedgerAbort || signal.aborted) return state;
    return step({ type: "failed", failure: toFailure(error, at, txHash) });
  };

  const confirm = async (txHash: Hex, player: Address | null): Promise<LedgerState> => {
    try {
      const receipt = await deps.waitForReceipt(txHash, input.ticket.runId, cap, signal);
      checkpoint(signal);
      if (!receipt) return step({ type: "stalled" });
      if (receipt.status === "reverted") {
        deps.store.write({ runId: input.ticket.runId, txHash, player, status: "reverted", blockNumber: receipt.blockNumber.toString(), sentAt: deps.now() });
        return step({ type: "failed", failure: { code: "reverted_onchain", revert: null, detail: `Reverted in block ${receipt.blockNumber}`, at: "confirming", txHash } });
      }
      let best: bigint | null = null;
      if (!receipt.recorded) {
        // Mined, succeeded, and not ours: the wallet replaced the transaction (a cancel, or a speed-up with other
        // calldata) and viem followed the replacement. Nothing was filed by it — unless something else filed the run.
        let used = false;
        try { used = await deps.usedRunId(input.ticket.runId); } catch { used = false; }
        checkpoint(signal);
        if (used) {
          if (player) { try { best = await deps.bestScore(player); } catch { best = null; } }
          checkpoint(signal);
          deps.store.write(null);
          return step({ type: "already", best });
        }
        deps.store.write(null);
        return step({ type: "failed", failure: { code: "replaced", revert: null, detail: `Transaction ${receipt.txHash} mined in block ${receipt.blockNumber} without filing this shift`, at: "confirming", txHash: receipt.txHash } });
      }
      if (player) { try { best = await deps.bestScore(player); } catch { best = null; } }
      checkpoint(signal);
      deps.store.write({ runId: input.ticket.runId, txHash: receipt.txHash, player, status: "filed", blockNumber: receipt.blockNumber.toString(), sentAt: deps.now() });
      return step({ type: "filed", blockNumber: receipt.blockNumber, best, epoch: receipt.recorded.epoch, fedPile: receipt.recorded.fedPile });
    } catch (error) {
      return fail(error, "confirming", txHash);
    }
  };

  if (resume) {
    step({ type: "resume", txHash: resume.txHash, player: resume.player });
    return confirm(resume.txHash, resume.player);
  }

  step({ type: "start" });
  let player: Address;
  try {
    player = await deps.connect(signal);
    checkpoint(signal);
    await deps.ensureChain(signal);
    checkpoint(signal);
  } catch (error) {
    return fail(error, "connecting");
  }
  step({ type: "connected", player });

  let typedData: ReturnType<typeof resultTypedData>;
  let response: AttestResponse;
  try {
    response = await deps.attest({ runId: input.ticket.runId, player, commands: input.commands, endTick: input.endTick }, signal);
    // The clock is read the moment the answer arrives (I5): the deadline is judged against then, not against a later render.
    const receivedAt = deps.now();
    checkpoint(signal);
    typedData = verifyAttestation(response, input, player, receivedAt);
  } catch (error) {
    return fail(error, "attesting");
  }
  step({ type: "attested", result: response.result });

  let playerSignature: Hex;
  try {
    playerSignature = await deps.sign(typedData, player);
    checkpoint(signal);
  } catch (error) {
    return fail(error, "signing");
  }
  step({ type: "signed" });

  let txHash: Hex;
  try {
    txHash = await deps.send(response.result, playerSignature, response.verifierSignature, player);
  } catch (error) {
    // DuplicateRun: the chain already has this shift (another tab, a relayer, a retry after a lost receipt).
    // Ask the contract; if it agrees, the shift is filed — just not by this transaction. A retry could only fail again.
    if (isDuplicateRun(error)) {
      try {
        const used = await deps.usedRunId(input.ticket.runId);
        checkpoint(signal);
        if (used) {
          let best: bigint | null = null;
          try { best = await deps.bestScore(player); } catch { best = null; }
          checkpoint(signal);
          return step({ type: "already", best });
        }
      } catch (lookupError) {
        if (lookupError instanceof LedgerAbort || signal.aborted) return state;
        // The lookup failed: the refusal stands as the reason.
      }
    }
    return fail(error, "sending");
  }
  // The transaction is out: remember it before anything else, so a reload can find it.
  deps.store.write({ runId: input.ticket.runId, txHash, player, status: "pending", blockNumber: null, sentAt: deps.now() });
  if (signal.aborted) return state;
  step({ type: "sent", txHash });
  return confirm(txHash, player);
}

// ---- the store, in sessionStorage.

export const FILING_KEY = "dnfi-ledger-filing";
const HEX32 = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;

/**
 * A store over sessionStorage; silent when storage is unavailable. A record
 * whose `runId` or `txHash` is not a 32-byte hex string is dropped on read
 * (I4): nothing from storage reaches the RPC or an explorer link unchecked.
 */
export function sessionFilingStore(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null): FilingStore {
  return {
    read() {
      try {
        const raw = storage?.getItem(FILING_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<Filing>;
        if (typeof parsed.runId !== "string" || !HEX32.test(parsed.runId) || typeof parsed.txHash !== "string" || !HEX32.test(parsed.txHash)) return null;
        return {
          runId: parsed.runId as Hex, txHash: parsed.txHash as Hex, player: typeof parsed.player === "string" && ADDRESS.test(parsed.player) ? (parsed.player as Address) : null,
          status: parsed.status === "filed" || parsed.status === "reverted" ? parsed.status : "pending",
          blockNumber: typeof parsed.blockNumber === "string" && /^\d{1,20}$/.test(parsed.blockNumber) ? parsed.blockNumber : null, sentAt: typeof parsed.sentAt === "number" ? parsed.sentAt : 0,
        };
      } catch { return null; }
    },
    write(filing) {
      try {
        if (filing) storage?.setItem(FILING_KEY, JSON.stringify(filing)); else storage?.removeItem(FILING_KEY);
      } catch { /* private mode, quota: the filing still happens */ }
    },
  };
}
