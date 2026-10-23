import type { Ingredient } from '../game/arcade';

/**
 * The three snacks are crypto tokens: metal is Bitcoin, balloon is Ether,
 * pepper is HEMI. This module owns the marks; the words are in `./lore.ts`.
 * Nothing in either is read by the rules, and the rules' ingredient keys stay
 * what they are.
 *
 * Brand rule (Hemi asked that its logo not be modified in look and feel, and
 * the same courtesy is extended to the other two): every mark is drawn as
 * delivered. No recolouring, tinting, skewing, squashing, outlines, drop
 * shadows on the mark or cropping. The coin is a disc behind the mark, in the
 * game's palette; the spin, the glow, the flame trails, the selection ring and
 * every other effect happen on the plate or around it. The mark only
 * translates, rotates with the projectile's heading by at most `MARK_TILT`
 * (so a thrown coin reads as thrown and is never upside down), and scales
 * uniformly with the camera. See `docs/ART_PROVENANCE.md`.
 */

export type TokenId = 'BTC' | 'ETH' | 'HEMI';

export interface TokenSpec {
  id: TokenId;
  /** The spoken name: what the legend and the chips call it. */
  name: string;
  /** Candidate files, tried in order. The first that decodes is the mark. */
  sources: readonly string[];
  /** The game-palette tint for the effects around the coin (trails, bursts, captions). */
  tint: string;
  /** The mark's size as a fraction of the plate's diameter, on its longer axis. */
  markFraction: number;
  /** The plate behind the mark: centre and edge colours of a radial gradient, and the rim. */
  plate: { inner: string; outer: string; rim: string };
}

export const TOKENS: Record<Ingredient, TokenSpec> = {
  metal: {
    id: 'BTC', name: 'Bitcoin', sources: ['/art/tokens/btc.svg'], tint: '#ffc94d', markFraction: 0.92,
    // Bitcoin's own mark is a coin already; the plate is the dark rim behind it.
    plate: { inner: '#3a2a12', outer: '#120c05', rim: '#2a1d0b' },
  },
  balloon: {
    id: 'ETH', name: 'Ether', sources: ['/art/tokens/eth.svg'], tint: '#9be9df', markFraction: 0.64,
    // A pale plate: the Ξ is grey, and grey on dark enamel vanished at 960 px.
    plate: { inner: '#f3f6fa', outer: '#aeb9c8', rim: '#5b6878' },
  },
  pepper: {
    id: 'HEMI', name: 'HEMI', sources: ['/art/tokens/hemi.svg', '/art/tokens/hemi.png'], tint: '#ff6a2e', markFraction: 0.72,
    plate: { inner: '#2b1a10', outer: '#0e0805', rim: '#f26a1f' },
  },
};

/** The most a mark is turned to follow a heading, in radians (15°). */
export const MARK_TILT = Math.PI / 12;
/** The stand-in HEMI coin when the kit file has not landed: an orange disc with a white H. */
const HEMI_STAND_IN = { disc: '#f26a1f', ink: '#ffffff' };
const DISPLAY = "Impact,'Arial Black','DejaVu Sans Condensed','Helvetica Neue',Arial,sans-serif";
/** Bitmap sizes, in device pixels. The draw picks the smallest one at or above what it needs. */
const BITMAP_SIZES = [56, 112, 224] as const;

type Loaded = { image: HTMLImageElement | null; done: boolean };

/**
 * Loads one mark, trying each source in turn. Resolves with `null` when none
 * decodes. Nothing is logged: a missing HEMI file is the expected state until
 * the kit lands, and the stand-in is drawn instead.
 */
function loadMark(sources: readonly string[]): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= sources.length) { resolve(null); return; }
      const image = new Image();
      image.onload = () => { if (image.naturalWidth > 0) resolve(image); else next(); };
      image.onerror = () => next();
      image.src = sources[i++];
    };
    next();
  });
}

const marks = new Map<Ingredient, Promise<HTMLImageElement | null>>();
/** The mark for a token, loaded once per page and shared by the canvas and the DOM. */
export function markFor(ingredient: Ingredient): Promise<HTMLImageElement | null> {
  let p = marks.get(ingredient);
  if (!p) { p = loadMark(TOKENS[ingredient].sources); marks.set(ingredient, p); }
  return p;
}

/** Draws the plate alone: a disc in the game's palette with a rim. Nothing of the mark. */
export function drawPlate(ctx: CanvasRenderingContext2D, spec: TokenSpec, x: number, y: number, r: number) {
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
  g.addColorStop(0, spec.plate.inner); g.addColorStop(1, spec.plate.outer);
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = spec.plate.rim; ctx.lineWidth = Math.max(1, r * 0.08);
  ctx.beginPath(); ctx.arc(x, y, Math.max(0, r - ctx.lineWidth / 2), 0, Math.PI * 2); ctx.stroke();
}

/** The HEMI stand-in: an orange disc with a white H in the display font. Not the brand mark. */
export function drawHemiStandIn(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.save();
  ctx.fillStyle = HEMI_STAND_IN.disc; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = HEMI_STAND_IN.ink; ctx.font = `700 ${Math.round(r * 1.35)}px ${DISPLAY}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('H', x, y + r * 0.06);
  ctx.restore();
}

/**
 * Rasterises one coin (plate plus mark) once, at a given pixel size. The mark
 * is scaled uniformly to `markFraction` of the plate on its longer axis and
 * centred; nothing else is done to it.
 */
function rasterise(spec: TokenSpec, image: HTMLImageElement | null, px: number): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = px; c.height = px;
  const ctx = c.getContext('2d')!;
  const r = px / 2 - 1;
  const cx = px / 2, cy = px / 2;
  if (!image) {
    drawPlate(ctx, spec, cx, cy, r);
    if (spec.id === 'HEMI') drawHemiStandIn(ctx, cx, cy, r * 0.86);
    return c;
  }
  drawPlate(ctx, spec, cx, cy, r);
  const w = image.naturalWidth, h = image.naturalHeight;
  const longest = Math.max(w, h);
  const scale = (r * 2 * spec.markFraction) / longest;
  const dw = w * scale, dh = h * scale;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, cx - dw / 2, cy - dh / 2, dw, dh);
  return c;
}

export interface TokenDrawOptions {
  /** The heading the coin is travelling on, in radians. Clamped to ±MARK_TILT. */
  heading?: number;
  /** A spin phase in radians: where the highlight sweep on the plate's rim is. */
  spin?: number;
  /** Device pixels per logical pixel, so the right bitmap is picked. */
  scale?: number;
  /** Brightness of the sweep, 0–1; 0 draws none. */
  sheen?: number;
}

/**
 * The coin sprites: three tokens at three bitmap sizes, built once as each
 * mark decodes (and at once, with the stand-in, for a mark that never does).
 */
export function createTokenSprites() {
  const sprites = new Map<Ingredient, HTMLCanvasElement[]>();
  const state: Record<Ingredient, Loaded> = {
    metal: { image: null, done: false }, balloon: { image: null, done: false }, pepper: { image: null, done: false },
  };
  if (typeof document !== 'undefined') {
    for (const ingredient of Object.keys(TOKENS) as Ingredient[]) {
      void markFor(ingredient).then((image) => {
        state[ingredient] = { image, done: true };
        sprites.set(ingredient, BITMAP_SIZES.map((px) => rasterise(TOKENS[ingredient], image, px)));
      });
    }
  }

  function pick(ingredient: Ingredient, needPx: number): HTMLCanvasElement | null {
    const set = sprites.get(ingredient);
    if (!set) return null;
    for (let i = 0; i < BITMAP_SIZES.length; i++) if (BITMAP_SIZES[i] >= needPx) return set[i];
    return set[set.length - 1];
  }

  /**
   * Draws a coin of diameter `size` (logical px) centred at x, y. The sprite
   * is rotated by the clamped heading — the plate is a disc, so this is the
   * mark turning and nothing else — and the highlight sweep is drawn around it.
   */
  function draw(ctx: CanvasRenderingContext2D, ingredient: Ingredient, x: number, y: number, size: number, opts: TokenDrawOptions = {}) {
    // A coin too small to see (an animation's first frame) is not drawn: the
    // rim arcs below would be handed a negative radius and throw.
    if (!(size >= 2)) return;
    const spec = TOKENS[ingredient];
    const r = size / 2;
    const tilt = opts.heading === undefined ? 0 : Math.max(-MARK_TILT, Math.min(MARK_TILT, opts.heading));
    const bitmap = pick(ingredient, size * (opts.scale ?? 1.6));
    ctx.save();
    ctx.translate(x, y);
    // The coin's shadow on the room: behind the plate, never on the mark.
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = Math.max(2, r * 0.25); ctx.shadowOffsetY = r * 0.08;
    if (bitmap) {
      ctx.rotate(tilt);
      ctx.drawImage(bitmap, -r, -r, size, size);
      ctx.rotate(-tilt);
    } else {
      // Before the mark decodes (a frame or two): the plate alone.
      drawPlate(ctx, spec, 0, 0, r);
    }
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; ctx.shadowOffsetY = 0;
    const sheen = opts.sheen ?? 1;
    if (sheen > 0 && opts.spin !== undefined) {
      // The spin: a glint that runs round the rim, outside the mark.
      const a = opts.spin;
      ctx.lineCap = 'round';
      ctx.strokeStyle = `rgba(255,248,230,${0.75 * sheen})`; ctx.lineWidth = Math.max(1.5, r * 0.11);
      ctx.beginPath(); ctx.arc(0, 0, Math.max(0, r - ctx.lineWidth * 0.55), a - 0.55, a + 0.55); ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${0.35 * sheen})`; ctx.lineWidth = Math.max(1, r * 0.06);
      ctx.beginPath(); ctx.arc(0, 0, r + ctx.lineWidth, a + Math.PI - 0.4, a + Math.PI + 0.4); ctx.stroke();
    }
    ctx.restore();
  }

  /** True once every mark has either decoded or been given up on. */
  const ready = () => (Object.keys(state) as Ingredient[]).every((k) => state[k].done);
  /** Whether the HEMI mark came from a file (true), is the stand-in (false), or is still loading (null). */
  const hemiFromKit = () => (state.pepper.done ? state.pepper.image !== null : null);
  return { draw, ready, hemiFromKit };
}
