/**
 * What the ledger page derives from the world, kept pure so it can be tested
 * without a browser: shares that add up to 100, the dates an epoch covers,
 * the trait a dominant coin becomes, and the default selection.
 */
import type { Ingredient } from "../game/arcade.ts";
import type { LedgerEpoch, PileJson } from "./api.ts";
import { inheritedOf } from "./types.ts";

export interface Share { coin: "btc" | "eth" | "hemi"; ingredient: Ingredient; count: bigint; percent: number }

const COINS = [
  { coin: "btc", ingredient: "metal" },
  { coin: "eth", ingredient: "balloon" },
  { coin: "hemi", ingredient: "pepper" },
] as const;

/**
 * Each coin's share of a pile in whole percent, by largest remainder so the
 * three always add up to exactly 100 (or are all 0 for an empty pile). Ties
 * in the remainder go to the earlier coin, as the contract's `dominant` does.
 */
export function sharesOf(pile: Pick<PileJson, "btc" | "eth" | "hemi">): Share[] {
  const counts = COINS.map(({ coin }) => pile[coin]);
  const total = counts.reduce((a, b) => a + b, 0n);
  if (total <= 0n) return COINS.map(({ coin, ingredient }) => ({ coin, ingredient, count: 0n, percent: 0 }));
  const floors = counts.map((c) => Number((c * 100n) / total));
  const remainders = counts.map((c, i) => ({ i, r: Number((c * 100n) % total) }));
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  for (const { i } of [...remainders].sort((a, b) => b.r - a.r || a.i - b.i)) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return COINS.map(({ coin, ingredient }, i) => ({ coin, ingredient, count: counts[i], percent: floors[i] }));
}

/** The trait a dominant / inherited code stands for (1 btc → HODL jaws …); null for none. */
export const traitOf = (code: number | null): Ingredient | null => (code === null ? null : inheritedOf(code));

/** The span an epoch covers, as unix seconds; null when the genesis is not known yet. */
export function epochSpan(genesis: number | null, epochSeconds: number, epoch: number): { from: number; to: number } | null {
  if (genesis === null || !Number.isFinite(epochSeconds) || epochSeconds <= 0) return null;
  const from = genesis + epoch * epochSeconds;
  return { from, to: from + epochSeconds };
}

/** "Oct 22, 14:05 → Oct 23, 14:05", in the viewer's time zone; a day-long epoch is the common case. */
export function formatSpan(span: { from: number; to: number } | null, locale = "en-US", timeZone?: string): string | null {
  if (!span) return null;
  const f = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, ...(timeZone ? { timeZone } : {}) });
  return `${f.format(new Date(span.from * 1000))} → ${f.format(new Date(span.to * 1000))}`;
}

/** Which board opens: the current epoch's when anyone has filed in it, else all time. */
export function defaultBoard(epochs: readonly LedgerEpoch[], currentEpoch: number | null): number | "all" {
  const current = epochs.find((e) => e.epoch === currentEpoch);
  return current && current.top.length > 0 ? current.epoch : "all";
}

/** Uptime as m:ss from ticks (60 a second). */
export function uptime(ticks: number): string {
  const total = Math.max(0, Math.floor(ticks / 60));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
