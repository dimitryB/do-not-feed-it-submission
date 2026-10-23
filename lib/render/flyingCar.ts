/**
 * The flying car. On Oct 20 (Midweek with Max, 1:00:56) a judge said a Hemi
 * flying car "would be a fun maybe addition to one of the games people are
 * working on just for the meme value", so a tiny one crosses the back of the
 * kitchen: now and then while no shift is on (the title, every visit, and
 * the epoch report), and once during a shift, a minute in. His verse is the
 * first visit's, so a fresh browser gets both together.
 *
 * Presentation only, like the PRESS E sign: the shift's crossing is timed off
 * the tick, nothing is scored and nothing is in the trace. It flies through
 * the back room, behind the lamps, the creature, the rail and everything a
 * coin can touch, so it never reads as something to bank off. No caption and
 * no mark on it. Under reduced motion it stays home.
 */

/** The shift's one crossing starts a minute in, between the first two PRESS E signs. */
export const CAR_SHIFT_AT = 60 * 60;
/** Ticks (or sixtieths of a second on the title) it takes to cross the back room. */
export const CAR_TICKS = 240;
/** Between shifts: the first crossing this many seconds after the page opens… */
export const CAR_TITLE_FIRST = 2.5;
/** …then one every twenty seconds while the title or the epoch report is up. */
export const CAR_TITLE_EVERY = 20;

/**
 * The back room, in arena space: the stretch of the painting behind the
 * creature where the car is visible. It comes out from behind the left lamp's
 * shade and goes behind the chain hanging on the right, so the scene clips it
 * to this box. In a shift the creature has usually grown by the time it
 * comes, and its head hides the middle of the crossing: that is the depth.
 */
export const BACK_ROOM = { left: 668, right: 1082, top: 24, bottom: 104 } as const;

/** The car's half length; it starts and ends fully behind the lamps. */
export const CAR_HALF = 30;

/** How far through the shift's crossing at `tick`, 0–1, or null when there is none. */
export function carInShift(tick: number): number | null {
  if (!Number.isFinite(tick)) return null;
  const local = tick - CAR_SHIFT_AT;
  return local >= 0 && local < CAR_TICKS ? local / CAR_TICKS : null;
}

/**
 * How far through a between-shifts crossing at `seconds` since the page
 * opened, 0–1, or null. The same clock runs under the title and the epoch
 * report, so a crossing is never cut short by the screen changing.
 */
export function carIdle(seconds: number): number | null {
  if (!Number.isFinite(seconds) || seconds < CAR_TITLE_FIRST) return null;
  const local = ((seconds - CAR_TITLE_FIRST) % CAR_TITLE_EVERY) * 60;
  return local < CAR_TICKS ? local / CAR_TICKS : null;
}

export interface CarPose {
  /** The car's centre, in arena space. */
  x: number;
  y: number;
  /** Nose up is negative, in radians. */
  tilt: number;
}

/**
 * Where the car is at progress `p`: left to right across the back room, a
 * little above the creature's antennae, bobbing twice on the way like
 * something that has never been tuned.
 */
export function carPose(p: number): CarPose {
  const q = Math.min(1, Math.max(0, p));
  const from = BACK_ROOM.left - CAR_HALF - 4, to = BACK_ROOM.right + CAR_HALF + 4;
  const x = from + (to - from) * q;
  const bob = Math.sin(q * Math.PI * 4);
  const y = 62 - 6 * Math.sin(q * Math.PI) + 3 * bob;
  const tilt = -0.05 - 0.06 * Math.cos(q * Math.PI * 4);
  return { x, y, tilt };
}
