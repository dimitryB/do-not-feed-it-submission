/**
 * The replay-and-sign core. Pure: no HTTP, no D1, no clock of its own, so the
 * tests call it directly and the route is a thin shell around it.
 *
 * The one rule that matters (docs/CHAIN.md §2): nothing is signed that did not
 * come out of a successful replay of the authoritative rules. Every number in
 * the RunResult is derived here from `replayArcade`; the client's claims are
 * only the trace and the tick it says the run ended on, and the replay checks
 * even that. The inherited trait (§10) comes from the ticket row, never from
 * the request.
 */
import { encodePacked, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARENA, FOODS, replayArcade, TUNING, type ArcadeCommand, type ArcadeState, type Ingredient } from "../lib/game/arcade.ts";
import { traceHash, validateTrace } from "../lib/chain/trace.ts";
import {
  attestationTypedData, causeCode, DEADLINE_SECONDS, GAME_VERSION_ID, seedToBytes32,
  type RunResult,
} from "../lib/chain/types.ts";

export type VerifyErrorCode = "invalid_trace" | "run_not_over" | "out_of_bounds";

/** A rejection the client caused; anything else thrown here is a server fault. */
export class VerifyError extends Error {
  readonly code: VerifyErrorCode;
  constructor(code: VerifyErrorCode, message: string) {
    super(message);
    this.name = "VerifyError";
    this.code = code;
  }
}

/** What the replay says about a run: the signed numbers, plus the hash of what was replayed. */
export interface RunMetrics {
  score: bigint; durationTicks: number; totalFeeds: number;
  btcFed: number; ethFed: number; hemiFed: number;
  bestCombo: number; frenzies: number; sizeCenti: number;
  ending: number; cause: number;
  traceHash: Hex;
}

export interface VerifyRunInput {
  seed: number; commands: unknown; endTick: unknown;
  /** The trait the ticket was issued with (docs/CHAIN.md §10.3); null inherits nothing. */
  inherited?: Ingredient | null;
}

/**
 * Replay the trace from the seed, with the ticket's inherited trait. Rejects a
 * malformed trace, a trace the rules refuse (a launch on cooldown, a hatch
 * that was not ready), a run that is still playing at `endTick`, an `endTick`
 * past the tick the run actually ended on, and a result the registry's bounds
 * would refuse. Returns the metrics the contract will see.
 */
export function verifyRun(input: VerifyRunInput): RunMetrics {
  const { seed, commands, endTick } = input;
  const inherited = input.inherited ?? null;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Invalid seed");
  if (inherited !== null && !FOODS.includes(inherited)) throw new Error("Invalid inherited trait");
  let state: ArcadeState;
  let hash: Hex;
  try {
    validateTrace(commands, endTick);
    hash = traceHash(commands, endTick as number);
    state = replayArcade(seed, commands, endTick as number, inherited);
  } catch (error) {
    throw new VerifyError("invalid_trace", error instanceof Error ? error.message : "Invalid trace");
  }
  if (state.phase !== "lost") throw new VerifyError("run_not_over", "The run is still playing at endTick");
  if (state.tick !== endTick) throw new VerifyError("invalid_trace", "endTick is past the tick the run ended on");
  const metrics = metricsOf(state, hash);
  assertContractBounds(metrics);
  return metrics;
}

function metricsOf(state: ArcadeState, hash: Hex): RunMetrics {
  if (!Number.isSafeInteger(state.score) || state.score < 0) throw new Error("Replay produced a non-integer score");
  return {
    score: BigInt(state.score),
    durationTicks: state.tick,
    totalFeeds: state.totalFeeds,
    btcFed: state.servings.metal,
    ethFed: state.servings.balloon,
    hemiFed: state.servings.pepper,
    bestCombo: state.bestCombo,
    frenzies: state.frenzies,
    sizeCenti: Math.round(state.size * 100),
    ending: state.ending,
    cause: causeCode(state.failureReason),
    traceHash: hash,
  };
}

/**
 * The registry's bounds (contracts/FeedRegistry.sol, docs/CHAIN.md §5), each
 * derived from the same rules constant the contract names in its comment, so
 * a retune that moves a constant moves the mirror with it. The two the rules
 * do not define — the size and score ceilings — are the contract's own loose
 * numbers, copied.
 */
export const CONTRACT_BOUNDS = Object.freeze({
  /** MAX_DURATION_TICKS: ARENA.maxTicks. */
  maxDurationTicks: ARENA.maxTicks,
  /** FEED_COOLDOWN_TICKS: the shortest gap between two launches. */
  feedCooldownTicks: ARENA.frenzyCooldownTicks,
  /** CRATE_COINS: coins a broken crate pours in with no launch. */
  crateCoins: TUNING.crateCoins,
  /** CRATE_GAP_MIN: the shortest gap between two crates. */
  crateGapMin: TUNING.crateGapMin,
  /** FEEDS_PER_FRENZY: catches in a row that start a frenzy. */
  feedsPerFrenzy: TUNING.frenzyAt,
  /** MAX_SIZE_CENTI: loose; TUNING.sizeMax × 100 is far below it. */
  maxSizeCenti: 1_000,
  maxEnding: 3,
  maxCause: 2,
  /** MAX_SCORE_PER_TICK: loose; the theoretical maximum per tick is far lower. */
  maxScorePerTick: 4_000n,
});

/** The most feeds a run of `durationTicks` can hold: one launch per cooldown, plus every crate's coins. */
export function maxFeedsFor(durationTicks: number): number {
  const b = CONTRACT_BOUNDS;
  return Math.floor(durationTicks / b.feedCooldownTicks) + 1 + b.crateCoins * (Math.floor(durationTicks / b.crateGapMin) + 1);
}

/** The most frenzies `totalFeeds` catches can start. */
export function maxFrenziesFor(totalFeeds: number): number {
  return Math.floor(totalFeeds / CONTRACT_BOUNDS.feedsPerFrenzy) + 1;
}

/**
 * The contract's bounds, mirrored so the verifier never signs a result the
 * registry would refuse. The rules cannot produce such a result; a replay
 * that does is refused as `out_of_bounds` (422) rather than retried forever.
 */
export function assertContractBounds(m: RunMetrics): void {
  const b = CONTRACT_BOUNDS;
  const fail = (what: string) => { throw new VerifyError("out_of_bounds", `Replay result outside the contract bounds: ${what}`); };
  if (m.durationTicks < 1 || m.durationTicks > b.maxDurationTicks) fail("durationTicks");
  if (m.totalFeeds > maxFeedsFor(m.durationTicks)) fail("totalFeeds");
  if (m.btcFed + m.ethFed + m.hemiFed !== m.totalFeeds) fail("diet sum");
  if (m.bestCombo > m.totalFeeds) fail("bestCombo");
  if (m.frenzies > maxFrenziesFor(m.totalFeeds)) fail("frenzies");
  if (m.sizeCenti > b.maxSizeCenti) fail("sizeCenti");
  if (m.ending < 0 || m.ending > b.maxEnding) fail("ending");
  if (m.cause < 0 || m.cause > b.maxCause) fail("cause");
  if (m.score > BigInt(m.durationTicks) * b.maxScorePerTick) fail("score");
}

/** The ticket fields a result is built from; the route reads them from D1. */
export interface TicketForResult { runId: Hex; seed: number; snapshotHash: Hex }

/** Assemble the RunResult the verifier signs. `nowSeconds` dates the deadline. */
export function buildResult(ticket: TicketForResult, player: Address, metrics: RunMetrics, nowSeconds: number): RunResult {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw new Error("Invalid clock");
  return {
    runId: ticket.runId,
    gameVersion: GAME_VERSION_ID,
    player,
    score: metrics.score,
    durationTicks: metrics.durationTicks,
    totalFeeds: metrics.totalFeeds,
    btcFed: metrics.btcFed,
    ethFed: metrics.ethFed,
    hemiFed: metrics.hemiFed,
    bestCombo: metrics.bestCombo,
    frenzies: metrics.frenzies,
    sizeCenti: metrics.sizeCenti,
    ending: metrics.ending,
    cause: metrics.cause,
    seed: seedToBytes32(ticket.seed),
    traceHash: metrics.traceHash,
    snapshotHash: ticket.snapshotHash,
    deadline: BigInt(nowSeconds + DEADLINE_SECONDS),
  };
}

/** The verifier's EIP-712 signature over `VerifierAttestation(resultHash)`. */
export async function signAttestation(result: RunResult, verifyingContract: Address, chainId: number, privateKey: Hex): Promise<Hex> {
  const account = privateKeyToAccount(privateKey);
  return account.signTypedData(attestationTypedData(result, verifyingContract, chainId));
}

/**
 * The idempotency key of an attest request (docs/CHAIN.md §6): which ticket,
 * what was replayed. The player is deliberately not in it — a player who
 * switched wallets re-signs the same run for the new address (§6, L8) — and
 * is kept on the row beside it.
 */
export function payloadHashOf(runId: Hex, hash: Hex, endTick: number): Hex {
  return keccak256(encodePacked(["bytes32", "bytes32", "uint32"], [runId, hash, endTick]));
}

/** Shape-check a trace and hash it without replaying; the cheap half of `verifyRun`. */
export function hashTrace(commands: unknown, endTick: unknown): Hex {
  try {
    validateTrace(commands, endTick);
  } catch (error) {
    throw new VerifyError("invalid_trace", error instanceof Error ? error.message : "Invalid trace");
  }
  return traceHash(commands as ArcadeCommand[], endTick as number);
}
