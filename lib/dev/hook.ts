/**
 * Development-only inspection hooks.
 *
 * `DEV_HOOKS` folds to `false` in a production build, so every guarded block
 * (and the dynamic imports behind it) is dropped by the bundler. Nothing here
 * is imported by `lib/game/`, and nothing here can change a rule or a replay.
 */
import type { ArcadeState, Ingredient } from "../game/arcade";

export const DEV_HOOKS = process.env.NODE_ENV !== "production";

/** A forced presentation frame: the renderer draws this instead of live play. */
export interface DevPose {
  state: ArcadeState;
  playing: boolean;
  angle: number;
  selected: Ingredient;
}

export interface DevRenderControl {
  /** Frozen render clock in seconds, or null to use the real clock. */
  clock: number | null;
  /** Forced reduced-motion flag, or null to use the player setting. */
  reduced: boolean | null;
  /** Forced presentation frame, or null for live play. */
  pose: DevPose | null;
  /** Hides the aim guide and target ring, so a capture shows only the creature. */
  hideAim: boolean;
  /** Suppresses the canvas-drawn score and event labels, which are HUD. */
  hideLabels: boolean;
  /** Holds the eyes open: a blink landing on a capture reads as a missing face. */
  holdBlink: boolean;
  /**
   * Development only: outlines the rules' opening (and, while the jaws are
   * too nearly shut to take a coin, the band where a coin clanks) over the
   * creature, so a capture can be checked against the drawn mouth. Never on
   * in play.
   */
  showMouth: boolean;
  /** Rolling scene-draw cost in milliseconds. */
  timing: { samples: number; total: number; max: number; last: number; all: number[] };
  /**
   * Where the frame went, development only.
   *
   * A single millisecond figure says the draw is too expensive without saying
   * which part of it is. `cells` is the number of warp cells actually redrawn —
   * the warp is priced per cell, not per pixel — and `rig` is the cost of the
   * creature alone, so the rest of the scene is the difference.
   */
  profile: { samples: number; cells: number; rig: number; total: number };
}

export const devRender: DevRenderControl = {
  clock: null,
  reduced: null,
  pose: null,
  hideAim: false,
  hideLabels: false,
  holdBlink: false,
  showMouth: false,
  timing: { samples: 0, total: 0, max: 0, last: 0, all: [] as number[] },
  profile: { samples: 0, cells: 0, rig: 0, total: 0 },
};

/** Counted by the warp, read by the profiler; reset every frame. */
export const frameCells = { count: 0, skipped: 0, clipped: 0 };

/**
 * Where the creature's own draw went, in milliseconds, accumulated per frame.
 * The cell count told us the warp grid is not the variable — it is 600 cells in
 * every mutation state — so the cost has to be found inside the rig's phases.
 */
export const rigParts = { field: 0, warp: 0, skin: 0, mouth: 0, face: 0, overlay: 0, saturation: 0, multiply: 0, screen: 0 };
export function resetRigParts() {
  rigParts.field = 0; rigParts.warp = 0; rigParts.skin = 0; rigParts.mouth = 0; rigParts.face = 0;
  rigParts.overlay = 0; rigParts.saturation = 0; rigParts.multiply = 0; rigParts.screen = 0;
}

/**
 * Every sample is kept, not just the running total.
 *
 * A mean over a couple of dozen frames is dominated by whatever else the
 * machine was doing: one scheduler stall or GC pause during a four-second
 * window moves it by milliseconds, which is the whole budget. The median is
 * what a frame actually costs, and p95 is what the worst honest frame costs.
 */
export function recordDrawCost(milliseconds: number) {
  const timing = devRender.timing;
  timing.samples++;
  timing.total += milliseconds;
  timing.last = milliseconds;
  if (milliseconds > timing.max) timing.max = milliseconds;
  if (timing.all.length < 4000) timing.all.push(milliseconds);
}

export function drawCostSummary() {
  const timing = devRender.timing;
  const sorted = [...timing.all].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : 0;
  return {
    samples: timing.samples,
    average: timing.samples ? timing.total / timing.samples : 0,
    median: at(0.5),
    p95: at(0.95),
    max: timing.max,
    last: timing.last,
  };
}

export function resetDrawCost() {
  devRender.timing = { samples: 0, total: 0, max: 0, last: 0, all: [] };
  devRender.profile = { samples: 0, cells: 0, rig: 0, total: 0 };
  resetRigParts();
}

export function recordFrameProfile(cells: number, rigMs: number, totalMs: number) {
  const profile = devRender.profile;
  profile.samples += 1;
  profile.cells += cells;
  profile.rig += rigMs;
  profile.total += totalMs;
}

export function drawProfileSummary() {
  const p = devRender.profile;
  const n = Math.max(1, p.samples);
  return {
    samples: p.samples,
    cellsPerFrame: p.cells / n,
    clippedCells: frameCells.clipped,
    rigMs: p.rig / n,
    sceneMs: (p.total - p.rig) / n,
    totalMs: p.total / n,
    field: rigParts.field / n,
    warp: rigParts.warp / n,
    skin: rigParts.skin / n,
    mouth: rigParts.mouth / n,
    face: rigParts.face / n,
    modes: {
      overlay: rigParts.overlay / n, saturation: rigParts.saturation / n,
      multiply: rigParts.multiply / n, screen: rigParts.screen / n,
    },
  };
}

type HookBag = Record<string, unknown>;

/** Returns the shared `window.__dnfi` bag in development, otherwise null. */
export function devHookBag(): HookBag | null {
  if (!DEV_HOOKS || typeof window === "undefined") return null;
  const holder = window as unknown as { __dnfi?: HookBag };
  holder.__dnfi ??= {};
  return holder.__dnfi;
}
