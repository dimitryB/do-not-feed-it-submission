/**
 * The chain's shared vocabulary: Hemi, the signed RunResult (EIP-712), the
 * registry ABI and the JSON codec. Used by the Worker, the client and the
 * tests. See docs/CHAIN.md §4–5; the field order here *is* the typehash.
 *
 * Built on the domain-bound signed result flow of the author's Proof of Patience.
 */
import { defineChain, hashTypedData, keccak256, parseAbi, stringToHex, toHex, type Address, type Hex } from "viem";
import { GAME_VERSION, type Ingredient } from "../game/arcade.ts";

export const HEMI_CHAIN_ID = 43_111;
export const HEMI_RPC_URL = "https://rpc.hemi.network/rpc";
export const HEMI_EXPLORER_URL = "https://explorer.hemi.xyz";
export const DOMAIN_NAME = "Do Not Feed It";
export const DOMAIN_VERSION = "1";

/** Seconds a ticket stays usable: twelve minutes of play and time to idle and sign. */
export const TICKET_SECONDS = 40 * 60;
/** How far ahead of now the verifier dates a signature; the contract allows 30 minutes. */
export const DEADLINE_SECONDS = 20 * 60;
export const SIGNATURE_WINDOW_SECONDS = 30 * 60;

export const hemiChain = defineChain({
  id: HEMI_CHAIN_ID,
  name: "Hemi Mainnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [HEMI_RPC_URL] } },
  blockExplorers: { default: { name: "Hemi Explorer", url: HEMI_EXPLORER_URL } },
});

/** The signed rules identity for an arcade version number. */
export function gameVersionId(version: number = GAME_VERSION): Hex {
  if (!Number.isSafeInteger(version) || version < 0) throw new Error("Invalid game version");
  return keccak256(stringToHex(`do-not-feed-it/arcade/${version}`));
}
export const GAME_VERSION_ID = gameVersionId(GAME_VERSION);

export const CAUSES = ["empty-belly", "kitchen-destroyed", "outgrew-the-kitchen"] as const;
export type Cause = (typeof CAUSES)[number];
export function causeCode(cause: Cause | null): number {
  const index = cause === null ? -1 : CAUSES.indexOf(cause);
  if (index < 0) throw new Error("Unknown cause");
  return index;
}

/** The result, as the contract sees it. Field order matches RESULT_TYPEHASH. */
export interface RunResult {
  runId: Hex; gameVersion: Hex; player: Address;
  score: bigint; durationTicks: number; totalFeeds: number;
  btcFed: number; ethFed: number; hemiFed: number;
  bestCombo: number; frenzies: number; sizeCenti: number;
  ending: number; cause: number;
  seed: Hex; traceHash: Hex; snapshotHash: Hex; deadline: bigint;
}

export const resultTypes = {
  RunResult: [
    { name: "runId", type: "bytes32" }, { name: "gameVersion", type: "bytes32" }, { name: "player", type: "address" },
    { name: "score", type: "uint64" }, { name: "durationTicks", type: "uint32" }, { name: "totalFeeds", type: "uint32" },
    { name: "btcFed", type: "uint32" }, { name: "ethFed", type: "uint32" }, { name: "hemiFed", type: "uint32" },
    { name: "bestCombo", type: "uint32" }, { name: "frenzies", type: "uint32" }, { name: "sizeCenti", type: "uint32" },
    { name: "ending", type: "uint8" }, { name: "cause", type: "uint8" },
    { name: "seed", type: "bytes32" }, { name: "traceHash", type: "bytes32" }, { name: "snapshotHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;
export const attestationTypes = { VerifierAttestation: [{ name: "resultHash", type: "bytes32" }] } as const;

export function domainFor(verifyingContract: Address, chainId = HEMI_CHAIN_ID) {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract } as const;
}
export function resultTypedData(result: RunResult, verifyingContract: Address, chainId = HEMI_CHAIN_ID) {
  return { domain: domainFor(verifyingContract, chainId), types: resultTypes, primaryType: "RunResult" as const, message: result };
}
export function resultHash(result: RunResult, verifyingContract: Address, chainId = HEMI_CHAIN_ID): Hex {
  return hashTypedData(resultTypedData(result, verifyingContract, chainId));
}
export function attestationTypedData(result: RunResult, verifyingContract: Address, chainId = HEMI_CHAIN_ID) {
  return {
    domain: domainFor(verifyingContract, chainId), types: attestationTypes,
    primaryType: "VerifierAttestation" as const, message: { resultHash: resultHash(result, verifyingContract, chainId) },
  };
}

/** A uint32 arcade seed as the contract's bytes32. */
export function seedToBytes32(seed: number): Hex {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Invalid seed");
  return toHex(BigInt(seed), { size: 32 });
}

export const feedRegistryAbi = parseAbi([
  "struct RunResult { bytes32 runId; bytes32 gameVersion; address player; uint64 score; uint32 durationTicks; uint32 totalFeeds; uint32 btcFed; uint32 ethFed; uint32 hemiFed; uint32 bestCombo; uint32 frenzies; uint32 sizeCenti; uint8 ending; uint8 cause; bytes32 seed; bytes32 traceHash; bytes32 snapshotHash; uint64 deadline; }",
  "function submitResult(RunResult result, bytes playerSignature, bytes verifierSignature)",
  "function bestScore(address player) view returns (uint64)",
  "function bestUptime(address player) view returns (uint32)",
  "function runs(address player) view returns (uint32)",
  "function usedRunIds(bytes32 runId) view returns (bool)",
  "function activeGameVersion() view returns (bytes32)",
  "function verifier() view returns (address)",
  "function GENESIS() view returns (uint64)",
  "function EPOCH_SECONDS() view returns (uint64)",
  "function currentEpoch() view returns (uint64)",
  "function epochOf(uint64 timestamp) view returns (uint64)",
  "function diet(uint64 epoch) view returns (uint64 btc, uint64 eth, uint64 hemi, uint64 runs)",
  "function allTimeDiet() view returns (uint64 btc, uint64 eth, uint64 hemi, uint64 runs)",
  "function dominant(uint64 epoch) view returns (uint8)",
  "function filingsIn(uint64 epoch, address player) view returns (uint32)",
  "function PILE_FILINGS_PER_EPOCH() view returns (uint32)",
  "function paused() view returns (bool)",
  "event ResultRecorded(bytes32 indexed runId, address indexed player, bytes32 indexed gameVersion, uint64 score, uint32 durationTicks, uint32 btcFed, uint32 ethFed, uint32 hemiFed, uint32 bestCombo, uint32 frenzies, uint32 sizeCenti, uint8 ending, uint8 cause, uint64 epoch, bytes32 snapshotHash, bytes32 traceHash)",
  "event PileFed(bytes32 indexed runId, address indexed player, uint64 indexed epoch, uint32 btcFed, uint32 ethFed, uint32 hemiFed)",
  "event VerifierChanged(address indexed previousVerifier, address indexed nextVerifier)",
  "event GameVersionChanged(bytes32 indexed previousVersion, bytes32 indexed nextVersion)",
  "error InvalidResult()",
  "error InvalidSignature()",
  "error DuplicateRun()",
  "error WrongVersion()",
  "error Expired()",
]);

/** The result over the wire: bigints as decimal strings. */
export interface RunResultJson extends Omit<RunResult, "score" | "deadline"> { score: string; deadline: string }
export function resultToJson(result: RunResult): RunResultJson {
  return { ...result, score: result.score.toString(), deadline: result.deadline.toString() };
}
const HEX32 = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const u32 = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`Invalid ${name}`);
  return value;
};
const u8 = (value: unknown, name: string): number => { const n = u32(value, name); if (n > 255) throw new Error(`Invalid ${name}`); return n; };
const hex32 = (value: unknown, name: string): Hex => { if (typeof value !== "string" || !HEX32.test(value)) throw new Error(`Invalid ${name}`); return value as Hex; };
const u64 = (value: unknown, name: string): bigint => {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) throw new Error(`Invalid ${name}`);
  const n = BigInt(value); if (n > 0xffffffffffffffffn) throw new Error(`Invalid ${name}`); return n;
};
/** Strict decode; throws on any missing, extra-typed or out-of-range field. */
export function resultFromJson(input: unknown): RunResult {
  if (!input || typeof input !== "object") throw new Error("Invalid result");
  const r = input as Record<string, unknown>;
  if (typeof r.player !== "string" || !ADDRESS.test(r.player)) throw new Error("Invalid player");
  return {
    runId: hex32(r.runId, "runId"), gameVersion: hex32(r.gameVersion, "gameVersion"), player: r.player as Address,
    score: u64(r.score, "score"), durationTicks: u32(r.durationTicks, "durationTicks"), totalFeeds: u32(r.totalFeeds, "totalFeeds"),
    btcFed: u32(r.btcFed, "btcFed"), ethFed: u32(r.ethFed, "ethFed"), hemiFed: u32(r.hemiFed, "hemiFed"),
    bestCombo: u32(r.bestCombo, "bestCombo"), frenzies: u32(r.frenzies, "frenzies"), sizeCenti: u32(r.sizeCenti, "sizeCenti"),
    ending: u8(r.ending, "ending"), cause: u8(r.cause, "cause"),
    seed: hex32(r.seed, "seed"), traceHash: hex32(r.traceHash, "traceHash"), snapshotHash: hex32(r.snapshotHash, "snapshotHash"),
    deadline: u64(r.deadline, "deadline"),
  };
}

/** The pile: coins fed by token over a window, as the contract keeps it. */
export interface Pile { btc: bigint; eth: bigint; hemi: bigint; runs: bigint }
export const DOMINANT = ["none", "btc", "eth", "hemi"] as const;
/** The contract's `dominant` rule: the largest share; a tie goes to the earlier token (btc, eth, hemi). */
export function dominantOf(pile: Pick<Pile, "btc" | "eth" | "hemi">): number {
  const shares = [pile.btc, pile.eth, pile.hemi];
  let best = 0;
  for (let i = 1; i < shares.length; i++) if (shares[i] > shares[best]) best = i;
  return shares[best] > 0n ? best + 1 : 0;
}
/** The inherited trait for a dominant code: btc → metal (HODL jaws), eth → balloon (gas belly), hemi → pepper (turbo breath). */
export const INHERITED: readonly (Ingredient | null)[] = [null, "metal", "balloon", "pepper"];
export function inheritedOf(dominant: number): Ingredient | null {
  return INHERITED[dominant] ?? null;
}

/**
 * The world a ticket was issued in (docs/CHAIN.md §7, §10.1): the ticket's
 * epoch, the source epoch whose pile the creature inherits (0 and a zero pile
 * when nothing is inherited), that pile's dominant token and its three totals.
 */
export function snapshotHashOf(epoch: bigint, sourceEpoch: bigint, pile: Pick<Pile, "btc" | "eth" | "hemi">): Hex {
  const dominant = dominantOf(pile);
  const packed = stringToHex("dnfi/snapshot/2") + toHex(epoch, { size: 8 }).slice(2) + toHex(sourceEpoch, { size: 8 }).slice(2)
    + toHex(dominant, { size: 1 }).slice(2)
    + toHex(pile.btc, { size: 8 }).slice(2) + toHex(pile.eth, { size: 8 }).slice(2) + toHex(pile.hemi, { size: 8 }).slice(2);
  return keccak256(packed as Hex);
}

/** A wallet's first this-many filings in an epoch feed the pile (FeedRegistry.PILE_FILINGS_PER_EPOCH). */
export const PILE_FILINGS_PER_EPOCH = 3;

/** The largest epoch below `epoch` with runs, looking back at most `lookback`; null when there is none. docs/CHAIN.md §10.1. */
export const SNAPSHOT_LOOKBACK = 8;
export function sourceEpochOf(epoch: bigint, piles: ReadonlyMap<bigint, Pick<Pile, "runs">> | ((e: bigint) => Pick<Pile, "runs"> | undefined), lookback = SNAPSHOT_LOOKBACK): bigint | null {
  const read = typeof piles === "function" ? piles : (e: bigint) => piles.get(e);
  for (let e = epoch - 1n, i = 0; e >= 0n && i < lookback; e -= 1n, i += 1) {
    const pile = read(e);
    if (pile && pile.runs > 0n) return e;
  }
  return null;
}
