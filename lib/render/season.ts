/**
 * Seasons: presentation that changes with the calendar. Nothing here is read
 * by the rules or recorded in a trace.
 *
 * Halloween runs October 15 to November 2 in the viewer's own time zone, so
 * the judging stream (October 29, the hosts in costume) gets it. `?season=
 * halloween` forces it on for a preview, `?season=none` forces it off (the
 * capture harnesses use that, so a capture does not change with the date).
 */

export type Season = 'halloween' | null;

export function seasonFor(date: Date, search = ''): Season {
  const forced = new URLSearchParams(search).get('season');
  if (forced === 'halloween') return 'halloween';
  if (forced === 'none') return null;
  const month = date.getMonth(), day = date.getDate();
  return (month === 9 && day >= 15) || (month === 10 && day <= 2) ? 'halloween' : null;
}

/** A stable 0–1 value for an integer, so the flicker is the same on every machine and every capture. */
const hash = (n: number) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

/** How long between the starts of two flicker bursts, at most, in seconds. */
const PERIOD = 8;
/** One burst: two dips, the second deeper, over about three quarters of a second. [start, end, depth]. */
const DIPS: readonly [number, number, number][] = [[0, 0.18, 0.55], [0.5, 0.74, 1]];
/** The most the title darkens at the bottom of the deepest dip. */
export const FLICKER_DARKEST = 0.28;

/**
 * The title lamps' flicker at `time` seconds: 0 is steady, 1 the deepest dip.
 * One burst somewhere in every eight seconds, two dips each — well under the
 * three-flashes-a-second line — and only ever darker, never a bright flash.
 * Callers skip it under reduced motion.
 */
export function flickerAt(time: number): number {
  const k = Math.floor(time / PERIOD);
  const local = time - k * PERIOD - (1 + hash(k) * (PERIOD - 2.5));
  for (const [a, b, depth] of DIPS) if (local >= a && local <= b) return depth * Math.sin((Math.PI * (local - a)) / (b - a));
  return 0;
}
