// Reused from the author's Proof of Patience.
// Generic presentation contracts only. Gameplay state must not be imported here.
/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

export interface Vec2 {
  x: number;
  y: number;
}

export type QualityTier = "low" | "medium" | "high" | "ultra";

/** Deterministic random source. Never call Math.random in render code. */
export interface Rng {
  /** Uniform [0, 1). */
  next(): number;
  /** Uniform [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  /** −1 or 1. */
  sign(): number;
  pick<T>(items: readonly T[]): T;
  /** Independent child stream, so one consumer cannot desync another. */
  fork(salt?: number): Rng;
}

export interface Noise {
  /** Simplex-style value noise in [−1, 1]. */
  n2(x: number, y: number): number;
  n3(x: number, y: number, z: number): number;
  /** Fractal brownian motion in roughly [−1, 1]. */
  fbm2(x: number, y: number, octaves?: number, lacunarity?: number, gain?: number): number;
  /** Ridged multifractal in [0, 1]; good for light shafts and smoke. */
  ridged2(x: number, y: number, octaves?: number): number;
  /** Seamless tiling noise over a period, for baked textures. */
  tiled2(x: number, y: number, period: number): number;
}

/* ------------------------------------------------------------------ *
 * Texture bakery — procedural, baked once, cached forever
 * ------------------------------------------------------------------ */

/**
 * Ids every bakery must be able to produce. Sprites are premultiplied-safe
 * white/alpha art meant to be tinted with globalCompositeOperation; tiles are
 * seamless and safe to use as CanvasPattern with "repeat".
 */
export type TextureId =
  // seamless tiles
  | "noise-fine"
  | "noise-coarse"
  | "grunge"
  | "brushed-metal"
  | "concrete"
  | "acoustic-fabric"
  | "carbon-weave"
  | "dust-motes"
  // sprites (white on transparent, radially or directionally shaped)
  | "spark"
  | "bokeh"
  | "smoke"
  | "streak"
  | "ring"
  | "flare"
  | "star-flare"
  | "shard"
  | "ember"
  | "glow"
  // full-frame overlays
  | "vignette"
  | "lens-scratches"
  | "lens-dirt";

export interface TextureBakery {
  /** Baked canvas for an id. Bakes on first call, then returns the cache. */
  get(id: TextureId): CanvasImageSource;
  /** Cached repeating pattern for a tile id. */
  pattern(context: CanvasRenderingContext2D, id: TextureId, repeat?: string): CanvasPattern;
  /** Pixel size of a baked texture. */
  size(id: TextureId): number;
  /** Bakes everything up front so the first frame never stalls. */
  warm(): void;
}

/* ------------------------------------------------------------------ *
 * Motion helpers
 * ------------------------------------------------------------------ */

export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass?: number;
  initial?: number;
}

export interface Spring {
  value: number;
  velocity: number;
  target: number;
  set(target: number): void;
  /** Jump to a value with no velocity. */
  snap(value: number): void;
  /** Add an instantaneous velocity impulse — used for punchy UI reactions. */
  impulse(velocity: number): void;
  update(dt: number): number;
}

/** Trauma-based camera shake (Jonas Gomes model): shake = trauma². */
export interface Camera {
  /** Adds trauma in [0, 1]; saturates rather than stacking linearly. */
  addTrauma(amount: number): void;
  /** Punch the camera in a direction — used for recoil and impacts. */
  addImpulse(x: number, y: number): void;
  /** Zoom punch, 1 = neutral. */
  addZoom(amount: number): void;
  update(dt: number): void;
  readonly offset: Vec2;
  readonly rotation: number;
  readonly zoom: number;
  readonly trauma: number;
  /** Applies transform to a 2D context around the given pivot. */
  apply(context: CanvasRenderingContext2D, width: number, height: number): void;
  reset(): void;
}

/** Global time authority: hit-stop, slow motion and unscaled time all live here. */
export interface Clock {
  /** Scaled delta the simulation should use. */
  readonly dt: number;
  /** Real delta, for UI and effects that must never freeze. */
  readonly rawDt: number;
  /** Accumulated scaled seconds. */
  readonly time: number;
  /** Accumulated unscaled seconds. */
  readonly rawTime: number;
  /** Current multiplier (hit-stop and slow-mo combined). */
  readonly scale: number;
  /** Freeze frames on impact. Seconds of real time. */
  hitStop(seconds: number): void;
  /** Ramped slow motion: target scale held for a duration, then eased back. */
  slowMotion(scale: number, seconds: number): void;
  tick(rawDeltaSeconds: number): void;
}

/* ------------------------------------------------------------------ *
 * Particles, ribbons, ropes
 * ------------------------------------------------------------------ */

export type ParticlePreset =
  | "impact-spark"
  | "impact-ring"
  | "letter-debris"
  | "answer-burst"
  | "confetti"
  | "smoke-puff"
  | "dust-kick"
  | "ember"
  | "glass-shard"
  | "paper-shred"
  | "muzzle-flash"
  | "shockwave"
  | "ambient-dust"
  | "crowd-flash"
  | "screen-static";

export interface EmitOptions {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  count?: number;
  /** Primary tint, CSS colour. */
  color?: string;
  /** Secondary tint; particles lerp between the two over life. */
  color2?: string;
  speed?: number;
  speedVariance?: number;
  /** Emission direction in radians. */
  angle?: number;
  /** Full cone width in radians. */
  spread?: number;
  scale?: number;
  life?: number;
  gravity?: number;
  drag?: number;
  /** Draw behind entities instead of in front. */
  behind?: boolean;
  /** Additive blending; default true for sparks, false for debris. */
  additive?: boolean;
}

export interface ParticleSystem {
  emit(preset: ParticlePreset, options: EmitOptions): void;
  update(dt: number): void;
  /** Draws one layer. Call "behind" before entities, "front" after. */
  draw(context: CanvasRenderingContext2D, layer: "behind" | "front"): void;
  clear(): void;
  readonly count: number;
  readonly capacity: number;
}

export interface Ribbon {
  push(x: number, y: number): void;
  update(dt: number): void;
  draw(
    context: CanvasRenderingContext2D,
    options: { width: number; color: string; fade?: number; additive?: boolean },
  ): void;
  clear(): void;
  readonly length: number;
}

/** Verlet rope used for the hanging cables and flexible props. */
export interface Rope {
  readonly points: { x: number; y: number; px: number; py: number; pinned: boolean }[];
  update(dt: number, gravity: number, iterations?: number): void;
  /** Move the free end, e.g. to follow a moving object. */
  setEnd(x: number, y: number): void;
  draw(
    context: CanvasRenderingContext2D,
    options: { width: number; color: string; highlight?: string },
  ): void;
}

/* ------------------------------------------------------------------ *
 * Post-processing
 * ------------------------------------------------------------------ */

export interface PostParams {
  /** 0 disables the bloom pass entirely. */
  bloomStrength: number;
  bloomThreshold: number;
  bloomRadius: number;
  /** Lateral chromatic aberration in pixels at the frame edge. */
  chroma: number;
  vignette: number;
  grain: number;
  /** Broadcast scanline visibility, 0–1. */
  scanline: number;
  /** Lens barrel distortion, 0 = rectilinear. */
  barrel: number;
  exposure: number;
  contrast: number;
  saturation: number;
  /** Warm/cool grade shift, −1 cool to 1 warm. */
  temperature: number;
  /** Full-frame flash: colour blended additively by amount. */
  flashAmount: number;
  flashColor: [number, number, number];
  /** Analogue tape/RGB-split glitch, 0–1. Used on damage. */
  glitch: number;
  /** Radial motion blur toward the centre, 0–1. Used on mutation burst. */
  radialBlur: number;
}

export interface PostChain {
  /** False when WebGL2 is unavailable; callers must fall back to a direct blit. */
  readonly available: boolean;
  /** The canvas that must be shown to the user. */
  readonly canvas: HTMLCanvasElement;
  resize(width: number, height: number, dpr: number): void;
  render(source: CanvasImageSource, params: PostParams, timeSeconds: number): void;
  setQuality(tier: QualityTier): void;
  dispose(): void;
}
