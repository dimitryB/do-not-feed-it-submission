/**
 * The PRESS E sign: now and then the creature spits a PRESS E sign out of its
 * mouth, and for a couple of seconds pressing E does something (IT WORKED., a
 * burst of coins, ding ding ding). Presentation only — the sign is timed off
 * the shift's tick, E is never a command, nothing is scored and nothing is in
 * the trace — so the page (which hears the key) and the scene (which draws
 * the sign) both read this one schedule and always agree.
 */

/** The first sign twenty seconds into a shift… */
export const PRESS_E_FIRST = 20 * 60;
/** …then one every seventy-five seconds. */
export const PRESS_E_EVERY = 75 * 60;
/** Ticks the sign spends flying out of the mouth. */
export const PRESS_E_FLIGHT = 42;
/** Ticks it then hangs in the caption slot. E counts the whole time, flight included. */
export const PRESS_E_OPEN = 150;

export interface PressEPhase {
  /** Which sign of the shift this is, from 0. One hit per sign. */
  index: number;
  phase: 'flying' | 'open';
  /** How far through the phase, 0–1. */
  t: number;
}

/** Where the sign is at `tick`, or null when there is none. */
export function pressEPhase(tick: number): PressEPhase | null {
  if (!Number.isFinite(tick) || tick < PRESS_E_FIRST) return null;
  const index = Math.floor((tick - PRESS_E_FIRST) / PRESS_E_EVERY);
  const local = tick - PRESS_E_FIRST - index * PRESS_E_EVERY;
  if (local < PRESS_E_FLIGHT) return { index, phase: 'flying', t: local / PRESS_E_FLIGHT };
  if (local < PRESS_E_FLIGHT + PRESS_E_OPEN) return { index, phase: 'open', t: (local - PRESS_E_FLIGHT) / PRESS_E_OPEN };
  return null;
}
