"use client";
import type { World } from "../../lib/chain/api";
import Link from "next/link";
import { LEDGER, LEDGER_PAGE } from "../../lib/render/lore";

/**
 * TOP KEEPERS: the five best filed shifts, under the diet line on the title.
 * Address, score, uptime — the three numbers the fiction says anyone checks.
 * Nothing when the world is unavailable; a small "(as of N min ago)" when the
 * Worker served a stale snapshot because Hemi's RPC did not answer.
 */
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const clock = (ticks: number) => {
  const total = Math.max(0, Math.floor(ticks / 60));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

export function TopKeepers({ world }: { world: World | null }) {
  if (!world || !world.top.length) return null;
  const rows = world.top.slice(0, 5);
  // The age is measured when the world arrived, not on every render: a stale board says how old it was when it was served.
  const minutes = world.stale ? Math.max(1, Math.round((world.fetchedAt / 1000 - world.updatedAt) / 60)) : 0;
  return (
    <div className="top-keepers" aria-label={LEDGER.top.title}>
      <span className="top-keepers-title">{LEDGER.top.title}{world.stale && <em>{LEDGER.top.stale(minutes)}</em>}<Link className="top-keepers-link" href="/ledger">{LEDGER_PAGE.link}</Link></span>
      <ol>
        {rows.map((keeper, index) => (
          <li key={keeper.player}>
            <b>{index + 1}</b>
            <span className="keeper-address" title={keeper.player}>{shortAddress(keeper.player)}</span>
            <span className="keeper-score">{keeper.score.toLocaleString("en-US")}</span>
            <span className="keeper-uptime">{clock(keeper.durationTicks)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
