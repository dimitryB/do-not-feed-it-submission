import {
  ARENA, TUNING, crateAt, flameCone, flightOf, getHazard, inFrenzy, launchSpeed, mouthIsTeeth, previewFlight, straightTicks,
  type ArcadeState, type Bouncer, type Crate, type Ingredient, type Projectile,
} from '../game/arcade';
import { CreatureAnimator } from './creature/pose';
import { buildRig, type CreatureRig } from './creature/rig';
import { drawCreature, REST_MOUTH } from './creature/draw';
import { lipsAt } from '../game/body';
import { EYE, ANTENNA_BULB } from './creature/anatomy';
import { DEV_HOOKS, devRender, frameCells } from '../dev/hook';
import { TOKENS, createTokenSprites } from './tokens';
import { BLOCK_NAMES, CAPTIONS, CRAVING_LINES, PRESS_E_HIT, catchLine, forkCaption, frenzyLine, missCaption, revertCaption, tantrumCaption, tokenCopy } from './lore';
import { pressEPhase, type PressEPhase } from './pressE';
import { BACK_ROOM, carIdle, carInShift, carPose } from './flyingCar';
import { FLICKER_DARKEST, flickerAt, type Season } from './season';
import { fitCaptionSize } from './captionFit';

/**
 * The scene: the kitchen, the creature, the serving in flight, and every piece
 * of juice a stream audience needs to read it at a glance.
 *
 * The creature is the HUD. On screen during play: score and time (React, in
 * the corners), three mutation chips (React, top centre), the craving ring,
 * one slim belly bar under the creature, a combo counter by the launcher that
 * becomes the FRENZY banner, and at most one caption at a time. Nothing here
 * predicts, instructs or measures.
 *
 * Everything in this file is presentation. It reads `ArcadeState` and its
 * events; it never decides anything, and its own randomness is hashed from
 * event ids and the render clock so a capture of a given tick is reproducible.
 */

/** The effect tints: the game's own palette for each token, not the marks' colours. */
const COLORS: Record<Ingredient, string> = { metal: TOKENS.metal.tint, balloon: TOKENS.balloon.tint, pepper: TOKENS.pepper.tint };
const DISPLAY = "Impact,'Arial Black','DejaVu Sans Condensed','Helvetica Neue',Arial,sans-serif";
const MONO = 'ui-monospace,Menlo,monospace';
const clampAlpha = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const HATCH_TOP = ARENA.launcher.y - 46;
/** Deterministic per-index noise; the renderer's own, never the game's. */
const hashed = (index: number) => {
  const value = Math.sin(index * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
};
const easeOut = (t: number) => 1 - (1 - clampAlpha(t)) ** 3;

/** A '#rrggbb' colour with an alpha, for gradients. */
const withAlpha = (hex: string, a: number) => `${hex}${Math.round(clampAlpha(a) * 255).toString(16).padStart(2, '0')}`;

/** A coin on the floor lies a little askew: the most the mark is ever turned. */
const MARK_TILT_FLOOR = 0.26;
/**
 * The caption slot: the empty left third of the kitchen, clear of the creature
 * at every size. Stage 6 moved it down from 238 to 250 to give the blocks on
 * their chains the air above it.
 */
const CAPTION = { x: 300, y: 250 };
/**
 * While a block is on the rail (and for a moment after) the caption drops to
 * the empty stretch of wall under it, so a line never sits on the block or on
 * the coins pouring out of it.
 */
const CAPTION_LOW = { x: 280, y: 345 };
/** The FOMO banner's centre: left of the blocks' stretch of rail. */
const FOMO_X = 170;
/** Where the combo lives, in screen space: under the score, out of the lance's way. */
const COMBO = { x: 24, y: 118 };
/** The belly bar, on the counter's front face directly under the creature. */
const BELLY = { y: 504, w: 330, h: 14 };

/**
 * The camera. From about x2 the rules put the mouth so high that the eyes
 * leave the frame, and the face is the character. Once the creature is past
 * `CAMERA.from` the whole arena-space scene is scaled about a fixed anchor near
 * the counter's centre by whatever factor keeps the brow at least `eyeMargin`
 * px below the top edge and the antennae at least `headMargin`, whichever is
 * tighter. The factor only ever falls during a run, in steps, each eased over
 * `ease` seconds; the HUD and the captions stay in screen space.
 */
const CAMERA = { ax: 600, ay: 530, from: 1.4, min: 0.6, step: 0.04, ease: 1.5, eyeMargin: 80, headMargin: 24 };
/** The brow ridge over the eyes and the top of the antennae, in the painting. */
const BROW_Y = Math.min(EYE.left.y - EYE.left.ry, EYE.right.y - EYE.right.ry) - 20;
const HEAD_TOP_Y = ANTENNA_BULB.y - ANTENNA_BULB.r;
const easeInOut = (t: number) => { const u = clampAlpha(t); return u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2; };

interface Particle {
  x: number; y: number; vx: number; vy: number; born: number; life: number;
  size: number; color: string; gravity: number; kind: 'dot' | 'spark' | 'dust' | 'ember' | 'shard';
}
interface Caption { text: string; color: string; born: number; life: number; priority: number; size: number; card: boolean; fitted?: boolean; from: { x: number; y: number } | null; coins?: { ingredient: Ingredient; n: number }; at?: { x: number; y: number; right: number } }
/** Seconds between two lines the creature spits back, at the least. */
const TALK_GAP = 1.8;

/** Seconds a spat-back line takes to fly from the mouth to the caption slot. */
const SPIT = 0.28;
interface Pop { x: number; y: number; text: string; color: string; born: number; size: number; tag?: string; total?: number; life?: number }
interface Ring { x: number; y: number; born: number; color: string; big: boolean; huge?: boolean }
interface Wobble { v: number; a: number }

export function createScene() {
  const kitchen = new Image(); kitchen.src = '/art/kitchen.png';
  // The coins: the token marks on plates, rasterised once at three sizes.
  const tokens = createTokenSprites();
  const cannon = new Image(); cannon.src = '/art/launcher.png';
  const masks = new Map<string, HTMLCanvasElement>();
  function masked(source: HTMLImageElement) {
    if (!source.complete || !source.naturalWidth) return null;
    if (masks.has(source.src)) return masks.get(source.src)!;
    const c = document.createElement('canvas'); c.width = source.naturalWidth; c.height = source.naturalHeight;
    const x = c.getContext('2d')!; x.drawImage(source, 0, 0);
    const data = x.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < data.data.length; i += 4) {
      const b = Math.max(data.data[i], data.data[i + 1], data.data[i + 2]);
      data.data[i + 3] = Math.round(Math.min(1, Math.max(0, (b - 34) / 28)) * 255);
    }
    x.putImageData(data, 0, 0); masks.set(source.src, c); return c;
  }

  // The creature rig is cut from the same painting, once, on the first frame
  // after it decodes. It is presentation only and keeps its own clock.
  let rig: CreatureRig | null = null;
  let rigFailed = false;
  const animator = new CreatureAnimator();
  let lastTime = -1;

  // ---- the juice state. All of it is derived from events, keyed on their ids.
  let seenEvent = 0;
  let seenRun = -1;
  let seenTick = -1;
  let seenState: ArcadeState | null = null;
  const particles: Particle[] = [];
  const pops: Pop[] = [];
  const rings: Ring[] = [];
  /**
   * Coins just caught, on their way down: from where the rules caught them to
   * the back of the throat, drawn inside the opening (over the tongue, behind
   * the upper teeth) while the jaws close on them. A catch is decided the tick
   * the coin is far enough between the lips; this is what makes it read as
   * swallowed rather than as a coin vanishing on the lip.
   */
  const gulps: { x: number; y: number; ingredient: Ingredient; born: number; id: number; cooked: boolean; banked: boolean; big?: boolean }[] = [];
  /**
   * A coin that brushed a lip without going in: a wet glint on the lip where it
   * touched, so a near miss reads as one rather than as a coin passing over
   * an open mouth. Keyed by projectile, once per brush.
   */
  const brushes: { x: number; y: number; born: number; upper: boolean; tint: string; teeth?: boolean;
                   vx?: number; fired?: boolean }[] = [];
  let caption: Caption | null = null;
  const wobble = new Map<string, Wobble>();
  let shake = 0;
  let freezeUntil = -1;
  let frozenAt = 0;
  let pulseAt = -10;
  /** When PRESS E last put gas back: the belly bar lights up for a moment. */
  let bellyLitAt = -10;
  let lastWorldTime = -1;

  let previewKey = ''; let guide: { x: number; y: number }[] = [];

  // The camera: the zoom in force, the step it is easing from and to, and
  // whether this run has already had its "it no longer fits" beat.
  const camera = { zoom: 1, from: 1, target: 1, since: -10, said: false };
  const toScreenX = (x: number) => CAMERA.ax + (x - CAMERA.ax) * camera.zoom;
  const toScreenY = (y: number) => CAMERA.ay + (y - CAMERA.ay) * camera.zoom;

  /**
   * The zoom the creature needs right now, from the rules' geometry rather than
   * the drawn pose, so the bob's whole swing is already allowed for and the
   * camera does not breathe with it.
   */
  function zoomNeeded(state: ArcadeState): number {
    const c = state.creature;
    if (c.size <= CAMERA.from) return 1;
    const grow = c.size - 1;
    const scaleY = 1 + grow * 0.06;
    // The highest the mouth gets on this bob, in arena space.
    const bobAmp = TUNING.bobPerLevel * (state.mutations.balloon ?? 0);
    // Positive track is a lean down; an upward lean also lifts the head a little on its own.
    const mouthTop = c.y + (c.bob ?? 0) - bobAmp + Math.min(0, c.track ?? 0) * 0.12;
    const brow = mouthTop - (REST_MOUTH.y - BROW_Y) * scaleY;
    const head = mouthTop - (REST_MOUTH.y - HEAD_TOP_Y) * scaleY;
    let zoom = 1;
    if (brow < CAMERA.eyeMargin) zoom = Math.min(zoom, (CAMERA.ay - CAMERA.eyeMargin) / (CAMERA.ay - brow));
    if (head < CAMERA.headMargin) zoom = Math.min(zoom, (CAMERA.ay - CAMERA.headMargin) / (CAMERA.ay - head));
    return clamp(zoom, CAMERA.min, 1);
  }

  function stepCamera(state: ArcadeState | null, shown: boolean, time: number, reduced: boolean) {
    if (!shown || !state) {
      camera.zoom = camera.from = camera.target = 1; camera.since = -10; camera.said = false;
      return;
    }
    // Quantised downward so each pull-back is a step, and never back in: it
    // does not shrink, and a camera that breathes is a camera you notice.
    const needed = Math.floor(zoomNeeded(state) / CAMERA.step + 1e-6) * CAMERA.step;
    if (needed < camera.target - 1e-6) {
      camera.from = camera.zoom; camera.target = needed; camera.since = time;
      if (!camera.said) { camera.said = true; say(CAPTIONS.noRoom, '#f1ffc8', 6, time, 60, 1.6, true); }
    }
    camera.zoom = reduced ? camera.target : camera.from + (camera.target - camera.from) * easeInOut((time - camera.since) / CAMERA.ease);
  }

  /** Device pixels per logical pixel on the last frame, so the coin picks the right bitmap. */
  let pixelScale = 1.6;
  /** A coin: the mark on its plate, the sweep around it. `heading` tilts it by at most 15°. */
  function coin(ctx: CanvasRenderingContext2D, ingredient: Ingredient, x: number, y: number, size: number, heading?: number, spin?: number, sheen = 1) {
    tokens.draw(ctx, ingredient, x, y, size, { heading, spin, scale: pixelScale * camera.zoom, sheen });
  }

  // Which pieces of kitchen metal were on screen last frame, so a catch or a
  // jam can say what it was: a fork, or the occasional hardware wallet.
  const junkSeen = new Map<number, { x: number; y: number; wallet: boolean }>();
  const isWallet = (id: number) => hashed(id * 13 + 5) < 0.3;
  function vanishedJunk(state: ArcadeState, x: number, y: number): { wallet: boolean } | null {
    let best: { wallet: boolean } | null = null; let bestD = 110 * 110;
    for (const [id, j] of junkSeen) {
      if (state.projectiles.some(p => p.id === id)) continue;
      const d = (j.x - x) ** 2 + (j.y - y) ** 2;
      if (d < bestD) { bestD = d; best = { wallet: j.wallet }; }
    }
    return best;
  }
  let jamWallet = false;
  /** Whether this shift has breathed yet: the first breath is the weapon, the rest are turbo breath. */
  let breathed = false;
  /** The PRESS E sign this shift has already been hit on (one hit per sign), and where the mouth was last frame. */
  let eHitIndex = -1;
  /** How many lines it has spat back this shift, and when the last one went, so a frenzy does not strobe them. */
  let talked = 0;
  let lastTalkAt = -10;
  /** A short line riding under the block: whose it is as it comes down, or a wrong coin. */
  let blockTag: { text: string; color: string; born: number; life: number } | null = null;
  /** When a block last came down, broke or went: the caption sits low until a moment after. */
  let blockAt = -10;
  /** A block a wrong coin knocked: when, and which way it swings. */
  const crateKick = new Map<number, { at: number; dir: number }>();
  /** A block breaking: a white-hot burst where it was, rimmed in its coin's colour. */
  let flashAt = -10;
  let flashColor = '#ffffff';
  let flashX = 0; let flashY = 0; let flashSeed = 0;
  /** The coins of the last broken block swallowed so far, and their running total, for its card. */
  let cardEaten = 0; let cardTotal = 0; let cardPulseAt = -10;
  /** Where a block just broke, held for a few frames as a cracked, white-hot cube under the burst. */
  let crackX = 0; let crackY = 0;
  /** The block as it was last drawn, and the one that just broke: it is drawn once more, punched and cracked. */
  let lastCrateDrawn: { c: Crate; tick: number } | null = null;
  let brokenCrate: { c: Crate; tick: number } | null = null;
  let lastMouth = { x: 600, y: 300 };

  /**
   * The caught coins, going down: from where the rules caught them toward the
   * back of the throat, straight away (it is already in), shrinking and
   * dimming into the dark while the jaws shut on it. Drawn only inside the
   * opening — over the tongue, behind the upper teeth and the lips — so the
   * closing lips wipe over it. Its ring goes the moment it is caught; its
   * light goes down with it. Never drawn over the face.
   */
  const GULP = 0.2;
  function gulpAt(g: (typeof gulps)[number], state: ArcadeState, time: number, reduced: boolean) {
    // The back of the throat: the dark of the gap, above the tongue, where the
    // jaws close last. It is small and dim there before the slit narrows, so
    // it is never a coin held in the teeth, nor one sliding into the chin.
    const m = state.creature.mouth;
    const tx = m.midX;
    const ty = m.top + (m.bottom - m.top) * 0.42;
    const f = (time - g.born) / GULP;
    // Off from where it was caught at about the speed it flew, easing into
    // the throat: no jump on the frame it is caught.
    const k = reduced ? f : 1 - Math.pow(1 - Math.min(1, f), 2);
    return { f, x: g.x + (tx - g.x) * k, y: g.y + (ty - g.y) * k, size: 46 * (1 - 0.7 * k), k };
  }
  function drawGulpCoin(ctx: CanvasRenderingContext2D, g: (typeof gulps)[number], at: { f: number; x: number; y: number; size: number; k: number }, reduced: boolean) {
    const tint = COLORS[g.ingredient];
    const { f, x, y, size } = at;
    // Its light, going down the throat with it: a warm pulse that fades.
    // (The last coin of a block lights the whole throat.)
    const r = (g.big ? 44 : 32) * (1 - 0.4 * at.k);
    const light = ctx.createRadialGradient(x, y, 2, x, y, r);
    light.addColorStop(0, withAlpha(tint, g.big ? 0.65 : 0.45)); light.addColorStop(1, withAlpha(tint, 0));
    ctx.fillStyle = light; ctx.globalAlpha = g.big ? Math.max(0, 1 - f * 1.2) : Math.max(0, 1 - f * 1.6);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    // The ring it flew with, fading over its first frames rather than cut.
    if (f < 0.4) {
      ctx.globalAlpha = 0.8 * (1 - f / 0.4); ctx.lineWidth = 2;
      ctx.strokeStyle = g.cooked ? '#ffb060' : g.banked ? '#ffd36a' : tint;
      ctx.beginPath(); ctx.arc(x, y, size / 2 + 1.5, 0, Math.PI * 2); ctx.stroke();
    }
    // The coin itself stays solid and darkens toward the throat's own colour
    // as it sinks and shrinks, going out only at the very end.
    const solid = f < 0.72 ? 1 : Math.max(0, 1 - (f - 0.72) / 0.28);
    ctx.globalAlpha = solid;
    coin(ctx, g.ingredient, x, y, size, 0, reduced ? 0.8 : g.id + f * 3, 1 - 0.5 * f);
    ctx.globalAlpha = solid * Math.min(0.9, f * 1.8);
    ctx.fillStyle = 'rgb(22,7,6)';
    ctx.beginPath(); ctx.arc(x, y, size / 2 + 0.5, 0, Math.PI * 2); ctx.fill();
  }
  /** Inside the opening (called by the creature's mouth, clipped to it). */
  function drawGulps(ctx: CanvasRenderingContext2D, state: ArcadeState, time: number, reduced: boolean) {
    for (let i = gulps.length - 1; i >= 0; i--) {
      const g = gulps[i];
      const at = gulpAt(g, state, time, reduced);
      if (at.f >= 1 || at.f < 0) { gulps.splice(i, 1); continue; }
      ctx.save(); drawGulpCoin(ctx, g, at, reduced); ctx.restore();
    }
  }

  /**
   * A glint along the lip where a coin came off it: one continuous sweep of
   * light along the lip's own curve either side of the contact, brightest
   * there, on the tick the rules decided it, gone in a few frames. A clank's
   * is harder and whiter, with a white star where it struck: teeth.
   */
  const BRUSH = 0.2;
  function drawBrushes(ctx: CanvasRenderingContext2D, state: ArcadeState, time: number, reduced: boolean) {
    const m = state.creature.mouth;
    for (let i = brushes.length - 1; i >= 0; i--) {
      const b = brushes[i];
      // A coin knocked off a lip that falls back in after all: that was a catch.
      if (!b.teeth && gulps.some((g) => g.born >= b.born && Math.hypot(g.x - b.x, g.y - b.y) < 80)) { brushes.splice(i, 1); continue; }
      const life = b.teeth ? BRUSH : BRUSH * 1.6;
      const f = (time - b.born) / life;
      if (f >= 1) { brushes.splice(i, 1); continue; }
      if (f < 0) continue;
      if (!b.fired) {
        b.fired = true;
        // A near miss: the creature looks.
        if (!b.teeth) animator.notice(time);
      }
      const reach = (b.teeth ? 26 : 26) + (reduced ? 0 : (b.teeth ? 10 : 8) * f);
      const fade = (1 - f) * (1 - f);
      // The lip's outer edge, a hair outside the opening, sampled along x.
      const points: { x: number; y: number }[] = [];
      for (let j = 0; j <= 16; j++) {
        const x = b.x - reach + (2 * reach * j) / 16;
        const l = lipsAt(m, x);
        if (!l) continue;
        points.push({ x, y: b.upper ? l.upper - 2 : l.lower + 2 });
      }
      if (points.length < 2) continue;
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const sweep = (color: string, alpha: number, width: number) => {
        const g = ctx.createLinearGradient(b.x - reach, 0, b.x + reach, 0);
        // Bright across most of its length, so it shows either side of the coin
        // that is still sitting on the lip where it struck.
        g.addColorStop(0, `rgba(${color},0)`); g.addColorStop(0.18, `rgba(${color},${alpha * 0.9})`);
        g.addColorStop(0.5, `rgba(${color},${alpha})`); g.addColorStop(0.82, `rgba(${color},${alpha * 0.9})`); g.addColorStop(1, `rgba(${color},0)`);
        ctx.strokeStyle = g; ctx.lineWidth = width;
        ctx.beginPath(); points.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke();
      };
      if (!b.teeth) sweep('255,214,140', 0.5 * fade, 14);
      sweep(b.teeth ? '240,246,255' : '255,252,240', fade, (b.teeth ? 5.5 : 5.5) * (1 - 0.4 * f));
      if (!b.teeth && !reduced) {
        // Where it left the lip: a small warm star on the lip line, under the
        // coin, showing as the coin comes away from it.
        const k = fade; const r = 17 * (0.7 + 0.3 * k);
        const glow = ctx.createRadialGradient(b.x, b.y, 1, b.x, b.y, r);
        glow.addColorStop(0, `rgba(255,200,110,${0.8 * k})`); glow.addColorStop(1, 'rgba(255,170,80,0)');
        ctx.globalAlpha = 1; ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = k; ctx.strokeStyle = 'rgb(255,250,236)'; ctx.lineWidth = 2.8;
        ctx.beginPath();
        for (let a = 0; a < 6; a++) {
          const ang = a * Math.PI / 3 + Math.PI / 6;
          ctx.moveTo(b.x + Math.cos(ang) * 2, b.y + Math.sin(ang) * 2); ctx.lineTo(b.x + Math.cos(ang) * r, b.y + Math.sin(ang) * r);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** The knock of a clank: a white star on the lip where it struck, over the coin, for its first frames. */
  function drawKnocks(ctx: CanvasRenderingContext2D, state: ArcadeState, time: number, reduced: boolean) {
    if (reduced) return;
    for (const b of brushes) {
      if (!b.teeth) continue;
      const f = (time - b.born) / (BRUSH * 0.4);
      if (f < 0 || f >= 1) continue;
      const k = 1 - f; const r = 26 * (0.6 + 0.4 * k);
      ctx.save();
      const core = ctx.createRadialGradient(b.x, b.y, 1, b.x, b.y, r * 0.8);
      core.addColorStop(0, `rgba(255,246,214,${0.9 * k})`); core.addColorStop(1, 'rgba(255,220,150,0)');
      ctx.fillStyle = core; ctx.beginPath(); ctx.arc(b.x, b.y, r * 0.8, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = k; ctx.strokeStyle = 'rgb(255,255,255)'; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
      ctx.beginPath();
      for (let a = 0; a < 8; a++) {
        const ang = a * Math.PI / 4 + Math.PI / 8; const len = a % 2 ? r * 0.55 : r;
        ctx.moveTo(b.x + Math.cos(ang) * 3, b.y + Math.sin(ang) * 3); ctx.lineTo(b.x + Math.cos(ang) * len, b.y + Math.sin(ang) * len);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  function burst(x: number, y: number, n: number, color: string, speed: number, time: number, kind: Particle['kind'] = 'dot', seed = 0, life = 0.7, gravity = 260) {
    for (let i = 0; i < n; i++) {
      const a = hashed(seed * 7 + i) * Math.PI * 2;
      const s = speed * (0.4 + hashed(seed * 11 + i) * 0.8);
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - speed * 0.3, born: time, life: life * (0.6 + hashed(seed + i * 3) * 0.6), size: (kind === 'spark' ? 5 : 4) + hashed(seed * 5 + i) * 6, color, gravity, kind });
    }
    if (particles.length > 260) particles.splice(0, particles.length - 260);
  }

  /** Puts up the one caption. `from` (screen space) makes it spat out of the mouth: it flies from there to the slot. */
  function say(text: string, color: string, priority: number, time: number, size = 46, life = 1.2, card = false, from: { x: number; y: number } | null = null, coins?: Caption['coins']) {
    if (caption && time - caption.born < caption.life * 0.55 && caption.priority > priority) return null;
    caption = { text, color, born: time, life, priority, size, card, from, coins };
    return caption;
  }

  function nudge(name: string, amount: number) {
    const w = wobble.get(name) ?? { v: 0, a: 0 };
    w.v += amount; wobble.set(name, w);
  }

  /** Turns the rules' new events into particles, pops, captions and shakes. */
  function ingest(state: ArcadeState, time: number, reduced: boolean) {
    // A new run: a new state object, a new seed, or the clock going backwards.
    // The object identity matters — two runs on the same seed (a restart, or a
    // harness filming two scenes) would otherwise carry the last run's event
    // ids forward and swallow every event of the new one.
    if (state !== seenState || state.seed !== seenRun || state.tick < seenTick) {
      seenState = state;
      // The clock can run backwards between two runs (a harness resets it per
      // scene), so nothing timed from the last run may carry over.
      freezeUntil = -1; frozenAt = 0; pulseAt = -10; bellyLitAt = -10;
      // A new run, or one we have never seen: start from here rather than
      // replaying its whole history into the screen.
      seenRun = state.seed; particles.length = 0; pops.length = 0; rings.length = 0; gulps.length = 0; brushes.length = 0; caption = null; shake = 0; wobble.clear(); breathed = false; eHitIndex = -1; talked = 0; lastTalkAt = -10; blockAt = -10; blockTag = null; crateKick.clear(); flashAt = -10; cardEaten = 0; cardTotal = 0;
      camera.zoom = camera.from = camera.target = 1; camera.since = -10; camera.said = false;
      seenEvent = Math.max(0, (state.events[state.events.length - 1]?.id ?? 0) - 1);
      if (state.tick < 2) seenEvent = 0;
    }
    seenTick = state.tick;
    for (const e of state.events) {
      if (e.id <= seenEvent) continue;
      seenEvent = e.id;
      // Only what just happened. A late-arriving event (the harness fast
      // forwards) would otherwise fire its burst seconds after the fact.
      if (state.tick - e.tick > 12) continue;
      const tint = e.ingredient ? COLORS[e.ingredient] : '#eef6c8';
      switch (e.type) {
        case 'feed': {
          if (e.ingredient) gulps.push({ x: e.x, y: e.y, ingredient: e.ingredient, born: time, id: e.id, cooked: e.label.startsWith('COOKED'), banked: e.label.startsWith('BANK') });
          if (gulps.length > 8) gulps.splice(0, gulps.length - 8);
          // No splash on the face: the swallow itself, drawn inside the mouth
          // with the coin's light going down the throat, is the catch.
          const value = e.value ?? 0;
          if (e.label.startsWith('CRATE')) {
            // Each coin out of a block is its own gulp, going down the throat
            // with its light like any coin (no ring or splash in the mouth:
            // the next coin is coming in), and a pip lit on the block's card,
            // which carries the running total.
            cardEaten += 1; cardTotal += value; cardPulseAt = time;
            const last = cardEaten >= TUNING.crateCoins;
            // Chomp, chomp, CHOMP: a nudge of the camera for each, harder for the last.
            if (!reduced) shake = Math.max(shake, last ? 0.6 : 0.28);
            // One number for the whole block: it counts up as each coin goes
            // down, a little bigger each time.
            for (let i = pops.length - 1; i >= 0; i--) if (pops[i].tag === 'pour') pops.splice(i, 1);
            // Beside the card, in the open air where the block hung (its coins have
            // all left it by the time the first is swallowed): off the mouth, so
            // the coins are seen going in, and off the eyes.
            pops.push({ x: 560, y: 96, text: `+${cardTotal}`, color: e.ingredient === 'pepper' ? '#ffb08a' : tint, born: time, size: last ? 58 : 44 + 4 * cardEaten, tag: 'pour', life: last ? 1.4 : 1.0 });
            // The last coin lights the throat on its way down.
            const gulp = gulps[gulps.length - 1];
            if (last && gulp && gulp.id === e.id) gulp.big = true;
          } else {
            // Feeds close together add up into one rising number instead of a pile.
            // Beside the mouth on the side the coins do not come from, its near
            // edge clear of the right corner: the opening is the target.
            const m = state.creature.mouth;
            const beside = (text: string, size: number) => Math.min(1150 - text.length * size * 0.32, m.rx + 44 + text.length * size * 0.32);
            const near = pops.find(p => p.tag === 'feed' && time - p.born < 0.3);
            if (near) {
              near.total = (near.total ?? 0) + value; near.text = `+${near.total}`; near.born = time;
              near.size = clamp(22 + near.total / 40, 22, 52); if (e.craved) near.color = '#ffe28a';
              near.x = beside(near.text, near.size);
            } else {
              const text = `+${value}`; const size = clamp(22 + value / 40, 22, 52);
              pops.push({ x: beside(text, size), y: m.ry - 64, text, color: e.craved ? '#ffe28a' : '#e7ffb0', born: time, size, tag: 'feed', total: value });
            }
          }
          const stuffed = e.label.startsWith('STUFFED');
          // A craving met says so. Otherwise it spits back one of the hosts'
          // lines, out of its mouth — at most one every TALK_GAP seconds.
          if (e.craved) say(CAPTIONS.craved, '#ffe28a', 3, time, 48, 0.9);
          // The wrong coin while it waits: a quarter of a serving, and it says so, over
          // any bank it came in on (the bank still pays; the look is the point).
          else if (e.name === 'snub') say(CAPTIONS.notThat, '#ff9a7a', 5, time, 52, 1.1);
          else if (time - lastTalkAt >= TALK_GAP) {
            lastTalkAt = time;
            const line = catchLine(talked++, stuffed);
            // Spat out of the corner of its mouth once the coin is down, so the
            // swallow is seen first and the line never covers the catch.
            const m = state.creature.mouth;
            const spat = say(line, '#e7ffb0', 2, time, line.length > 20 ? 40 : 44, 1.6, false, { x: toScreenX(m.lx + 6), y: toScreenY(m.ly + 4) });
            if (spat) spat.born = time + GULP * 0.85;
          }
          if (!reduced) { freezeUntil = time + 0.05; frozenAt = time; }
          break;
        }
        case 'bank':
          // Said, not sprayed: it lands with the catch, over the mouth, where
          // sparks would sit on the target and read as a cross.
          say(tokenCopy(e.label), '#ffd36a', 4, time, 54, 1.3);
          break;
        case 'bounce': {
          const surface = e.name ?? 'floor';
          const credited = (e.value ?? 0) > 0;
          // A bump off the chin, right under the lips: no ring and no caption
          // on the mouth's doorstep (the face flinches at it), only a few
          // flecks of skin flicked off below the coin, so the turn in its path
          // has a cause.
          if (surface === 'belly' && !credited) {
            if (!reduced) {
              for (let k = 0; k < 4; k++) {
                const side = (hashed(e.id * 3 + k) - 0.5) * 2;
                particles.push({ x: e.x + side * 10, y: e.y + 24, vx: side * 50, vy: 40 + hashed(e.id + k) * 40, born: time, life: 0.3,
                  size: 1.6 + hashed(e.id * 7 + k) * 1.2, color: 'rgba(214,206,150,0.9)', gravity: 300, kind: 'dot' });
              }
            }
            break;
          }
          // Off the balloon belly, a small ring: it is right under the mouth,
          // and a big one would sit over the coin as it goes in.
          rings.push({ x: e.x, y: e.y, born: time, color: surface === 'belly' ? '#9be9df' : credited ? '#ffd36a' : '#cdd8c4', big: credited && surface !== 'belly' });
          if (surface !== 'floor') nudge(surface, surface === 'lamp' ? 0.9 : 0.6);
          if (surface === 'belly') say(CAPTIONS.gasSpike, '#9be9df', 1, time, 40, 0.7);
          if (surface === 'crate') {
            // A coin it does not open for: a knock, a kick on the chain, a red cross over its mark.
            blockTag = { text: CAPTIONS.wrongToken, color: '#ff9a8a', born: time, life: 0.6 };
            burst(e.x, e.y, reduced ? 4 : 12, '#ffd0c0', 220, time, 'spark', e.id + 7, 0.35);
            const block = state.crates[0];
            if (block) crateKick.set(block.id, { at: time, dir: e.x < crateAt(block, state.tick).x ? 1 : -1 });
          }
          if (surface === 'floor') burst(e.x, ARENA.floor - 4, reduced ? 3 : 7, '#b9ae95', 70, time, 'dust', e.id, 0.5, 60);
          else burst(e.x, e.y, reduced ? 3 : 6, '#fff2c0', 150, time, 'spark', e.id, 0.35);
          break;
        }
        case 'lip': {
          // Off the lip: the rules knocked it away at this tick, here. A wet
          // glint along the lip it left by, a few motes and a double-take.
          const m = state.creature.mouth; const lips = lipsAt(m, e.x);
          if (lips) {
            const upper = e.y - lips.upper < lips.lower - e.y;
            const p = state.projectiles.find((q) => q.kind === 'food' && Math.hypot(q.x - e.x, q.y - e.y) < 30);
            brushes.push({ x: e.x, y: upper ? lips.upper : lips.lower, born: time, upper, tint: e.ingredient ? COLORS[e.ingredient] : '#ffffff', vx: p ? p.vx : 0 });
            if (brushes.length > 8) brushes.splice(0, brushes.length - 8);
          }
          break;
        }
        case 'clank': {
          // Off the teeth: a hard white glint along the shut lips where it hit.
          const m = state.creature.mouth; const lips = lipsAt(m, e.x);
          if (lips) {
            const upper = e.y < (lips.upper + lips.lower) / 2;
            brushes.push({ x: e.x, y: upper ? lips.upper : lips.lower, born: time - 0.07, upper, tint: '#dfe8ff', teeth: true });
          } else {
            // Off the end of the shut mouth: it struck the corner.
            const left = e.x < m.midX;
            brushes.push({ x: left ? m.lx : m.rx, y: left ? m.ly : m.ry, born: time - 0.07, upper: e.y < (left ? m.ly : m.ry), tint: '#dfe8ff', teeth: true });
          }
          // The glint runs along the lips it hit; a short hit-stop sells the knock.
          say(revertCaption(e.id), '#cfd8e8', 2, time, 40, 0.7);
          if (!reduced) { shake = Math.max(shake, 0.25); freezeUntil = time + 0.04; frozenAt = time; }
          break;
        }
        case 'miss':
          burst(e.x, ARENA.floor - 6, reduced ? 3 : 8, '#a8a08a', 60, time, 'dust', e.id, 0.6, 40);
          say(missCaption(e.ingredient, e.id), '#d9c9a8', 1, time, 36, 0.8);
          break;
        case 'frenzy':
          if (e.name === 'start') {
            const m = state.creature.mouth;
            // OH, DOCTOR. the first time, LET HIM COOK. the next: the rules count the frenzies, and this one has just started.
            const spat = say(frenzyLine(state.frenzies - 1), '#ffd36a', 5, time, 52, 1.4, false, { x: toScreenX(m.lx + 6), y: toScreenY(m.ly + 4) });
            if (spat) spat.born = time + GULP * 0.85;
            if (!reduced) shake = Math.max(shake, 1);
            // Over the head and floating up, never raining across the lips
            // while the frenzy's first coins go in.
            burst(e.x, e.y - 60, reduced ? 8 : 24, '#ffd36a', 260, time, 'spark', e.id, 0.7, -60);
            burst(e.x, e.y - 60, reduced ? 6 : 14, '#ff9a4a', 180, time, 'ember', e.id + 2, 1.1, -80);
          }
          break;
        case 'utensil':
          if (e.name === 'caught') {
            // A hardware wallet in the teeth is cold storage; a fork is a hard fork.
            const what = vanishedJunk(state, e.x, e.y);
            const points = e.value ?? TUNING.utensilScore;
            say(what && !what.wallet ? forkCaption(e.id, points) : CAPTIONS.wallet(points), '#dff2ff', 4, time, 50, 1.2);
            pops.push({ x: e.x, y: e.y - 30, text: `+${e.value ?? TUNING.utensilScore}`, color: '#dff2ff', born: time, size: 40 });
            burst(e.x, e.y, reduced ? 6 : 16, '#e8f4ff', 240, time, 'spark', e.id, 0.5);
            if (!reduced) { freezeUntil = time + 0.05; frozenAt = time; }
          } else burst(e.x, e.y, reduced ? 2 : 5, '#cfe0ea', 90, time, 'spark', e.id, 0.4);
          break;
        case 'cooked':
          say(CAPTIONS.turbo, '#ffb060', 3, time, 44, 0.9);
          burst(e.x, e.y, reduced ? 3 : 8, '#ffb060', 120, time, 'ember', e.id, 0.6, -40);
          break;
        case 'fire':
          if (e.name === 'start') { say(CAPTIONS.burn, '#ff8a4a', 5, time, 50, 1.6); burst(e.x, ARENA.floor, reduced ? 6 : 18, '#ffb060', 180, time, 'ember', e.id, 0.9, -60); }
          break;
        case 'flame':
          if (e.name === 'tell') say(CAPTIONS.inhale, '#ffb88a', 3, time, 40, 0.8);
          else { say(breathed ? CAPTIONS.breath : CAPTIONS.weapon, '#ff9a4a', 4, time, breathed ? 54 : 50, breathed ? 1.0 : 1.4); breathed = true; if (!reduced) shake = Math.max(shake, 0.4); }
          break;
        case 'jam': {
          const what = e.name === 'utensil' ? vanishedJunk(state, ARENA.launcher.x, ARENA.launcher.y) : null;
          jamWallet = e.name === 'utensil' && (what?.wallet ?? false);
          say(jamWallet ? CAPTIONS.walletJam : tokenCopy(e.label), '#ff8a6a', 4, time, 44, 1.1);
          burst(ARENA.launcher.x, ARENA.launcher.y - 10, reduced ? 4 : 10, e.name === 'singe' ? '#ffa060' : '#dfe8ff', 150, time, 'spark', e.id, 0.5);
          if (!reduced) shake = Math.max(shake, 0.3);
          break;
        }
        case 'grow':
          say(CAPTIONS.scaling, '#f1ffc8', 6, time, 70, 1.3, true);
          pulseAt = time;
          if (!reduced) shake = Math.max(shake, 0.35);
          break;
        case 'mutation':
          say(tokenCopy(e.label), tint, 7, time, 58, 1.7, true);
          burst(e.x, e.y, reduced ? 10 : 28, tint, 260, time, 'dot', e.id, 1.0);
          if (!reduced) shake = Math.max(shake, 0.5);
          break;
        case 'presse':
          // PRESS E worked: the gas it put back, over the creature, and the belly bar lights up.
          if ((e.value ?? 0) > 0) pops.push({ x: state.creature.x, y: BELLY.y - 34, text: `+${Math.round(e.value ?? 0)} GAS`, color: '#cdec7a', born: time, size: 44 });
          bellyLitAt = time;
          break;
        case 'craving':
          if (e.name === 'start' && e.ingredient) say(CRAVING_LINES[e.ingredient], tint, 2, time, 42, 1.1);
          break;
        case 'tantrum':
          say(tantrumCaption(e.id), '#ff8a6a', 5, time, 56, 1.2);
          if (!reduced) shake = Math.max(shake, 0.8);
          break;
        case 'beat': {
          const named = tokenCopy(e.label);
          const text = e.name === 'sneeze' ? CAPTIONS.sneeze : e.name === 'drool' ? CAPTIONS.slippage : e.name === 'lunge' ? CAPTIONS.lunge : named + (named.endsWith('.') ? '' : '.');
          say(text, e.name === 'lunge' || e.name === 'bite' ? '#ff9a6a' : '#e7ffb0', e.name === 'bite' ? 5 : 3, time, 44, 1.1);
          if (e.name === 'bite' && !reduced) shake = Math.max(shake, 0.6);
          break;
        }
        case 'launch':
          burst(e.x, e.y, reduced ? 1 : 3, '#fff2c0', 90, time, 'spark', e.id, 0.25);
          break;
        case 'crate':
          if (e.name === 'hit') {
            // Its own coin breaks it open: a white-hot burst where the block
            // was, slabs of its iron tumbling out and falling, a kick of the
            // camera, a beat of hit-stop, and a small card under it while the
            // coins pop out of the top and drop into the mouth one by one.
            blockAt = time;
            const n = e.value ?? 3;
            // The card sits right under where the block was, clear of the
            // aim line and under the coins' path into the mouth.
            cardEaten = 0; cardTotal = 0;
            const card = say(CAPTIONS.blockReward, tint, 8, time, 26, 1.6, true, null, { ingredient: e.ingredient ?? 'metal', n });
            // Under the combo at the top left, out of the coins' corridor and
            // clear of the block's stretch of room; drawn over the coins.
            if (card) card.at = { x: 224, y: 196, right: 430 };
            brokenCrate = lastCrateDrawn;
            if (!reduced) {
              // The cube in two halves, dropping out of the burst...
              for (const side of [-1, 1]) particles.push({ x: e.x + side * 14, y: e.y, vx: side * 90 - 60, vy: -120, born: time, life: 0.8, size: 44 + side * 3, color: tint, gravity: 1400, kind: 'shard' });
              // ...and plates of its iron, thrown up and back toward the launcher and
              // falling hard: none of them reach the creature.
              for (let i = 0; i < 7; i++) {
                const a = -Math.PI * (0.55 + 0.05 * i) + (hashed(e.id + i) - 0.5) * 0.2;
                const sp = 300 + hashed(e.id * 3 + i) * 220;
                particles.push({ x: e.x + (hashed(e.id + i * 9) - 0.5) * 30, y: e.y + (hashed(e.id + i * 13) - 0.5) * 30, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, born: time, life: 0.65, size: 26 + hashed(e.id + i * 5) * 14, color: tint, gravity: 1500, kind: 'shard' });
              }
            }
            burst(e.x, e.y, reduced ? 6 : 16, '#fff2c0', 420, time, 'spark', e.id + 5, 0.55);
            burst(e.x, e.y, reduced ? 4 : 12, tint, 340, time, 'spark', e.id, 0.65);
            // The shock ring leaves a frame or two after the cube cracks, so the hit frame is a blast, not a target.
            rings.push({ x: e.x, y: e.y, born: time + 0.06, color: tint, big: true, huge: true });
            flashAt = time; flashColor = tint; flashX = e.x; flashY = e.y; flashSeed = e.id;
            crackX = e.x; crackY = e.y;
            if (!reduced) { shake = Math.max(shake, 1.0); freezeUntil = time + 0.09; frozenAt = time; }
          } else if (e.name === 'spawn') {
            // Every block says whose it is, in its coin's colour, at the lowest priority.
            blockAt = time;
            burst(e.x, e.y + 14, reduced ? 3 : 8, '#b9ae95', 80, time, 'dust', e.id, 0.6, 120);
            // Whose it is: a tag that rides under the block, out of the shot path.
            // Whose it is rides under it on its tag for as long as it hangs (drawBlockTags).
          } else {
            blockAt = time;
            burst(e.x, e.y, reduced ? 3 : 8, '#cdd8c4', 120, time, 'spark', e.id, 0.4);
            // MISSED THE BLOCK. was on its tag while it went up; nothing more here.
          }
          break;
        default:
          break;
      }
    }
    if (pops.length > 5) pops.splice(0, pops.length - 5);
  }

  // ---- props: the five kitchen bouncers, where the rules put them.
  //
  // Painted to the room, not drawn on it: dark enamel and cast iron, an amber
  // rim light from the lamps on the right, a soft shadow on the wall or the
  // counter, a cord or chain where a thing hangs, and a slow sway. A hit
  // throws a glint along the rim.
  const RIM = 'rgba(255,186,108,';
  function drawProps(ctx: CanvasRenderingContext2D, time: number, reduced: boolean, dt: number) {
    for (const b of ARENA.bouncers) {
      const w = wobble.get(b.name);
      let a = 0; let glint = 0;
      if (w) {
        // A damped spring, in radians; reduced motion settles at once.
        if (reduced) { w.v = 0; w.a = 0; }
        else { w.v += (-w.a * 60 - w.v * 4) * dt; w.a += w.v * dt; }
        a = w.a; glint = clampAlpha(Math.abs(w.v) / 5);
        if (Math.abs(w.a) < 0.002 && Math.abs(w.v) < 0.01) wobble.delete(b.name);
      }
      drawProp(ctx, b, a, glint, time, reduced);
    }
  }

  /** A soft shadow: a radial gradient ellipse, never a hard-edged shape. */
  function softShadow(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, alpha: number) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, rx);
    g.addColorStop(0, `rgba(2,6,5,${alpha})`); g.addColorStop(0.6, `rgba(2,6,5,${alpha * 0.5})`); g.addColorStop(1, 'rgba(2,6,5,0)');
    ctx.save(); ctx.translate(x, y); ctx.scale(1, ry / rx); ctx.translate(-x, -y);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rx, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /** A hanging cord from the ceiling: dark, with a thread of light on its lit side. */
  function cord(ctx: CanvasRenderingContext2D, x: number, toY: number, width = 2.5) {
    ctx.strokeStyle = '#0d1312'; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, toY); ctx.stroke();
    ctx.strokeStyle = `${RIM}0.35)`; ctx.lineWidth = Math.max(0.8, width * 0.35); ctx.beginPath(); ctx.moveTo(x + width * 0.3, 0); ctx.lineTo(x + width * 0.3, toY); ctx.stroke();
  }

  function drawProp(ctx: CanvasRenderingContext2D, b: Bouncer, swing: number, glint: number, time: number, reduced: boolean) {
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const sway = reduced ? 0 : Math.sin(time * 0.7 + (b.kind === 'circle' ? b.x : b.x1) * 0.01) * 0.018;
    if (b.kind === 'circle' && b.name === 'pan') {
      // A cast-iron pan hanging face-on from a cord, swinging about its hook.
      ctx.translate(b.x, 0); ctx.rotate(swing * 0.35 + sway); ctx.translate(-b.x, 0);
      cord(ctx, b.x, b.y - b.r - 8);
      // Its shadow on the wall, down and to the left of the lamps.
      softShadow(ctx, b.x - 12, b.y + 14, b.r + 18, b.r + 10, 0.5);
      // The hook ring.
      ctx.strokeStyle = '#1a211f'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(b.x, b.y - b.r - 3, 5, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = `${RIM}0.6)`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(b.x, b.y - b.r - 3, 5, -1.2, 0.5); ctx.stroke();
      // The handle, out to the right, under the lamps.
      ctx.save(); ctx.translate(b.x + b.r - 4, b.y); ctx.rotate(0.05);
      const hg = ctx.createLinearGradient(0, -6, 0, 6); hg.addColorStop(0, '#2a302d'); hg.addColorStop(0.5, '#141a19'); hg.addColorStop(1, '#070b0a');
      ctx.fillStyle = hg; ctx.beginPath(); ctx.roundRect(0, -6, 50, 12, 6); ctx.fill();
      ctx.strokeStyle = `${RIM}0.7)`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(6, -5); ctx.lineTo(44, -5); ctx.stroke();
      ctx.fillStyle = '#05080899'; ctx.beginPath(); ctx.arc(42, 0, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      // The pan: black iron, a little lighter where the room's light catches it.
      const iron = ctx.createRadialGradient(b.x - 9, b.y - 9, 3, b.x, b.y, b.r + 2);
      iron.addColorStop(0, '#2f3634'); iron.addColorStop(0.5, '#171d1c'); iron.addColorStop(0.88, '#0b100f'); iron.addColorStop(1, '#161c1b');
      ctx.fillStyle = iron; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
      // The inner wall: a ring a few pixels in, darker, which is what gives it depth.
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(b.x, b.y, b.r - 6, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(120,130,124,0.14)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(b.x, b.y, b.r - 9, 0, Math.PI * 2); ctx.stroke();
      // Amber rim light along the side that faces the lamps, with a glint on a hit.
      ctx.strokeStyle = `${RIM}${0.25 + glint * 0.3})`; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(b.x, b.y, b.r - 1, -1.35, 0.75); ctx.stroke();
      ctx.strokeStyle = `${RIM}${0.85 + glint * 0.15})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(b.x, b.y, b.r - 1, -1.2, 0.6); ctx.stroke();
      if (glint > 0.02) { ctx.strokeStyle = `rgba(255,244,214,${glint})`; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(b.x, b.y, b.r - 1, -0.9, -0.2); ctx.stroke(); }
      // A dull specular on the enamel, toward the lamps.
      const spec = ctx.createRadialGradient(b.x + 11, b.y - 11, 1, b.x + 11, b.y - 11, 15);
      spec.addColorStop(0, 'rgba(255,214,160,0.22)'); spec.addColorStop(1, 'rgba(255,214,160,0)');
      ctx.fillStyle = spec; ctx.beginPath(); ctx.arc(b.x + 11, b.y - 11, 15, 0, Math.PI * 2); ctx.fill();
    } else if (b.kind === 'circle' && b.name === 'lamp') {
      // A pendant lamp in a dark tin shade, lit. It is worth two banks, so it glows.
      ctx.translate(b.x, 0); ctx.rotate(swing * 0.5 + sway); ctx.translate(-b.x, 0);
      cord(ctx, b.x, b.y - b.r - 2, 3);
      const flick = reduced ? 1 : 0.9 + 0.1 * Math.sin(time * 11);
      const glow = ctx.createRadialGradient(b.x, b.y + 6, 4, b.x, b.y + 6, b.r * 2.8);
      glow.addColorStop(0, `rgba(255,214,140,${0.55 * flick})`); glow.addColorStop(0.5, 'rgba(255,170,80,0.18)'); glow.addColorStop(1, 'rgba(255,150,60,0)');
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(b.x, b.y + 6, b.r * 2.8, 0, Math.PI * 2); ctx.fill();
      // The shade: a cone of dark tin, its underside lit by the bulb.
      const top = b.y - b.r - 2;
      const shade = ctx.createLinearGradient(b.x - b.r, 0, b.x + b.r, 0);
      shade.addColorStop(0, '#0b100f'); shade.addColorStop(0.4, '#262d2a'); shade.addColorStop(0.7, '#161c1b'); shade.addColorStop(1, '#3a2e22');
      ctx.fillStyle = shade;
      ctx.beginPath(); ctx.moveTo(b.x - 9, top); ctx.lineTo(b.x + 9, top); ctx.lineTo(b.x + b.r + 2, b.y - 1); ctx.lineTo(b.x - b.r - 2, b.y - 1); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = `${RIM}${0.75 + glint * 0.25})`; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(b.x + 9, top + 1); ctx.lineTo(b.x + b.r + 1, b.y - 2); ctx.stroke();
      // The lit underside and the bulb.
      const under = ctx.createLinearGradient(0, b.y - 3, 0, b.y + 4);
      under.addColorStop(0, `rgba(255,200,120,${0.7 * flick})`); under.addColorStop(1, 'rgba(255,200,120,0)');
      ctx.fillStyle = under; ctx.beginPath(); ctx.ellipse(b.x, b.y - 1, b.r + 2, 5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgba(255,236,180,${0.9 * flick})`; ctx.beginPath(); ctx.ellipse(b.x, b.y + 7, b.r * 0.5, b.r * 0.58, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgba(255,252,236,${0.95 * flick})`; ctx.beginPath(); ctx.ellipse(b.x, b.y + 5, b.r * 0.26, b.r * 0.32, 0, 0, Math.PI * 2); ctx.fill();
      // The cage: dark wire silhouetted against the bulb.
      ctx.strokeStyle = '#1a211f'; ctx.lineWidth = 2;
      for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(b.x + i * 10, b.y - 1); ctx.quadraticCurveTo(b.x + i * 9, b.y + b.r * 0.6, b.x + i * 5.5, b.y + b.r - 1); ctx.stroke(); }
      ctx.beginPath(); ctx.ellipse(b.x, b.y + b.r - 1, b.r * 0.5, 3.5, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = `${RIM}0.5)`; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(b.x, b.y + b.r - 1, b.r * 0.5, 3.5, 0, -0.4, 1.4); ctx.stroke();
      if (glint > 0.02) { ctx.strokeStyle = `rgba(255,244,214,${glint})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(b.x + 9, top + 1); ctx.lineTo(b.x + b.r - 4, b.y - 6); ctx.stroke(); }
    } else if (b.kind === 'circle') {
      // The stock pot, standing on the counter. It rattles rather than swings.
      const bottom = b.y + b.r;
      // Its weight on the counter: a contact shadow and a smear of reflection.
      softShadow(ctx, b.x + 2, bottom + 1, b.r + 20, 10, 0.7);
      const mirror = ctx.createLinearGradient(0, bottom, 0, bottom + 30);
      mirror.addColorStop(0, 'rgba(10,14,13,0.4)'); mirror.addColorStop(1, 'rgba(10,14,13,0)');
      ctx.fillStyle = mirror; ctx.beginPath(); ctx.ellipse(b.x, bottom + 14, b.r - 2, 16, 0, 0, Math.PI * 2); ctx.fill();
      ctx.translate(b.x, bottom); ctx.rotate(swing * 0.18); ctx.translate(-b.x, -bottom);
      const topY = b.y - b.r + 10;
      // The body: dark enamel, lit from the right.
      const body = ctx.createLinearGradient(b.x - b.r, 0, b.x + b.r, 0);
      body.addColorStop(0, '#070b0a'); body.addColorStop(0.18, '#1b2321'); body.addColorStop(0.42, '#2c3532'); body.addColorStop(0.7, '#161c1b'); body.addColorStop(0.9, '#3a2f24'); body.addColorStop(1, '#1a1512');
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.moveTo(b.x - b.r + 2, topY); ctx.lineTo(b.x + b.r - 2, topY); ctx.lineTo(b.x + b.r - 3, bottom - 6);
      ctx.quadraticCurveTo(b.x + b.r - 3, bottom, b.x + b.r - 10, bottom); ctx.lineTo(b.x - b.r + 10, bottom);
      ctx.quadraticCurveTo(b.x - b.r + 3, bottom, b.x - b.r + 3, bottom - 6); ctx.closePath(); ctx.fill();
      // Bottom rim, in perspective: the counter is seen from a little above.
      ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(b.x, bottom - 2, b.r - 4, 5, 0, 0, Math.PI); ctx.stroke();
      // Amber rim light up the right side, and a glint on a hit.
      ctx.strokeStyle = `${RIM}${0.3 + glint * 0.3})`; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(b.x + b.r - 5, topY + 6); ctx.lineTo(b.x + b.r - 6, bottom - 6); ctx.stroke();
      ctx.strokeStyle = `${RIM}${0.85 + glint * 0.15})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(b.x + b.r - 4, topY + 4); ctx.lineTo(b.x + b.r - 5, bottom - 5); ctx.stroke();
      if (glint > 0.02) { ctx.strokeStyle = `rgba(255,244,214,${glint})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(b.x + b.r - 6, topY + 10); ctx.lineTo(b.x + b.r - 7, topY + 34); ctx.stroke(); }
      // A soft sheen down the enamel, the way the painting's bowls take the room's light.
      const sheen = ctx.createLinearGradient(b.x - 18, 0, b.x + 2, 0);
      sheen.addColorStop(0, 'rgba(190,206,200,0)'); sheen.addColorStop(0.5, 'rgba(190,206,200,0.13)'); sheen.addColorStop(1, 'rgba(190,206,200,0)');
      ctx.fillStyle = sheen; ctx.fillRect(b.x - 18, topY + 10, 20, bottom - topY - 16);
      // A faint cool highlight up the left, from the lantern across the room.
      ctx.strokeStyle = 'rgba(170,200,196,0.16)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(b.x - b.r + 7, topY + 8); ctx.lineTo(b.x - b.r + 7, bottom - 10); ctx.stroke();
      // The mouth of the pot: a dark interior and a lit rim.
      ctx.fillStyle = '#2a3230'; ctx.beginPath(); ctx.ellipse(b.x, topY, b.r - 1, 8, 0, 0, Math.PI * 2); ctx.fill();
      const inside = ctx.createRadialGradient(b.x, topY + 1, 2, b.x, topY + 1, b.r - 4);
      inside.addColorStop(0, '#040706'); inside.addColorStop(0.8, '#0a0e0d'); inside.addColorStop(1, '#1c2422');
      ctx.fillStyle = inside; ctx.beginPath(); ctx.ellipse(b.x, topY + 1, b.r - 5, 6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(b.x, topY, b.r - 1, 8, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = `${RIM}0.9)`; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(b.x, topY, b.r - 1, 8, 0, -1.3, 0.9); ctx.stroke();
      ctx.strokeStyle = 'rgba(190,210,204,0.35)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(b.x, topY, b.r - 1, 8, 0, Math.PI + 0.3, Math.PI + 1.6); ctx.stroke();
      // Two handles, dark, each catching the light on its outer edge.
      ctx.lineWidth = 7; ctx.strokeStyle = '#0c1211';
      ctx.beginPath(); ctx.arc(b.x - b.r + 3, b.y - 2, 10, Math.PI * 0.45, Math.PI * 1.55); ctx.stroke();
      ctx.beginPath(); ctx.arc(b.x + b.r - 3, b.y - 2, 10, -Math.PI * 0.55, Math.PI * 0.55); ctx.stroke();
      ctx.strokeStyle = `${RIM}0.75)`; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.arc(b.x + b.r - 3, b.y - 2, 11.5, -Math.PI * 0.5, Math.PI * 0.3); ctx.stroke();
      ctx.strokeStyle = 'rgba(150,170,164,0.25)'; ctx.beginPath(); ctx.arc(b.x - b.r + 3, b.y - 2, 11.5, Math.PI * 0.6, Math.PI * 1.3); ctx.stroke();
    } else if (b.name === 'shelf') {
      // A plank on two iron brackets, in the dark of the upper wall. It bounces
      // rather than swings. Dark wood, an edge of lamplight, and two bottles in
      // silhouette so it reads as a shelf and not a bar.
      ctx.translate(0, swing * 6);
      const h = 10;
      // The plank's shadow on the wall.
      const under = ctx.createLinearGradient(0, b.y1 + h - 2, 0, b.y1 + h + 22);
      under.addColorStop(0, 'rgba(2,6,5,0.6)'); under.addColorStop(1, 'rgba(2,6,5,0)');
      ctx.fillStyle = under; ctx.fillRect(b.x1 - 6, b.y1 + h - 2, b.x2 - b.x1 + 8, 24);
      // Brackets, under the plank.
      ctx.strokeStyle = '#0d1211'; ctx.lineWidth = 4;
      for (const x of [b.x1 + 26, b.x2 - 26]) { ctx.beginPath(); ctx.moveTo(x, b.y1 + h); ctx.lineTo(x, b.y1 + h + 22); ctx.lineTo(x - 16, b.y1 + h); ctx.stroke(); }
      ctx.strokeStyle = `${RIM}0.4)`; ctx.lineWidth = 1;
      for (const x of [b.x1 + 26, b.x2 - 26]) { ctx.beginPath(); ctx.moveTo(x + 1.5, b.y1 + h + 1); ctx.lineTo(x + 1.5, b.y1 + h + 20); ctx.stroke(); }
      // The plank: old wood, darker at the left end, a warm edge on top.
      const wood = ctx.createLinearGradient(b.x1, 0, b.x2, 0);
      wood.addColorStop(0, '#120d09'); wood.addColorStop(0.5, '#2a1f15'); wood.addColorStop(1, '#3a2a1b');
      ctx.fillStyle = wood; ctx.beginPath(); ctx.roundRect(b.x1 - 4, b.y1 - 2, b.x2 - b.x1 + 8, h, 2); ctx.fill();
      ctx.strokeStyle = `${RIM}${0.55 + glint * 0.45})`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(b.x1 + 10, b.y1 - 1.5); ctx.lineTo(b.x2 + 3, b.y1 - 1.5); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(b.x1 - 3, b.y1 + h - 2.5); ctx.lineTo(b.x2 + 3, b.y1 + h - 2.5); ctx.stroke();
      // Bottles and a jar on it, in silhouette, each with one bead of lamplight.
      const bottle = (x: number, w: number, hh: number, neck: number, tint: string) => {
        const glass = ctx.createLinearGradient(x, 0, x + w, 0);
        glass.addColorStop(0, '#07090a'); glass.addColorStop(0.6, tint); glass.addColorStop(1, '#0b0d0c');
        ctx.fillStyle = glass;
        ctx.beginPath(); ctx.roundRect(x + w * 0.32, b.y1 - 2 - hh, w * 0.36, neck, 2); ctx.fill();
        ctx.beginPath(); ctx.roundRect(x, b.y1 - 2 - hh + neck - 2, w, hh - neck + 2, 4); ctx.fill();
        ctx.strokeStyle = `${RIM}0.75)`; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(x + w - 3, b.y1 - hh + neck + 4); ctx.lineTo(x + w - 3, b.y1 - 8); ctx.stroke();
        ctx.fillStyle = `${RIM}0.5)`; ctx.beginPath(); ctx.ellipse(x + w / 2, b.y1 - 2 - hh + 1, w * 0.2, 1.5, 0, 0, Math.PI * 2); ctx.fill();
      };
      bottle(b.x1 + 30, 16, 40, 14, '#152019');
      bottle(b.x1 + 52, 20, 30, 9, '#1d1711');
      bottle(b.x2 - 46, 26, 24, 6, '#1a1c14');
    } else {
      // The chain, hanging from the ceiling, a hook on its end.
      ctx.translate(b.x1, 0); ctx.rotate(swing * 0.3 + sway); ctx.translate(-b.x1, 0);
      // Its shadow on the wall.
      ctx.strokeStyle = 'rgba(2,6,5,0.45)'; ctx.lineWidth = 11; ctx.beginPath(); ctx.moveTo(b.x1 - 9, b.y1); ctx.lineTo(b.x2 - 9, b.y2 + 8); ctx.stroke();
      for (let y = b.y1 + 6; y < b.y2; y += 14) {
        const wide = Math.round(y / 14) % 2 === 0;
        const rx = wide ? 5.5 : 2.6;
        ctx.fillStyle = '#0b100f'; ctx.beginPath(); ctx.ellipse(b.x1, y, rx + 1.5, 8.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#1e2624'; ctx.lineWidth = 2.6; ctx.beginPath(); ctx.ellipse(b.x1, y, rx, 7, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = `${RIM}${0.7 + glint * 0.3})`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(b.x1, y, rx, 7, 0, -1.1, 0.9); ctx.stroke();
      }
      // The hook: dark iron with light on its outer curve.
      ctx.strokeStyle = '#0b100f'; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(b.x2 + 7, b.y2 + 10, 9, Math.PI * 1.5, Math.PI * 0.75); ctx.stroke();
      ctx.strokeStyle = '#242c29'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(b.x2 + 7, b.y2 + 10, 9, Math.PI * 1.5, Math.PI * 0.75); ctx.stroke();
      ctx.strokeStyle = `${RIM}${0.8 + glint * 0.2})`; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(b.x2 + 7, b.y2 + 10, 10.5, -0.3, 1.2); ctx.stroke();
      if (glint > 0.02) { ctx.strokeStyle = `rgba(255,244,214,${glint})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(b.x2 + 7, b.y2 + 10, 10.5, -0.1, 0.6); ctx.stroke(); }
    }
    ctx.restore();
  }

  // ---- the flame: the tell, then the cone.
  function drawFlame(ctx: CanvasRenderingContext2D, state: ArcadeState, time: number, reduced: boolean) {
    const cone = flameCone(state);
    if (!cone) return;
    const { x, y, angle, half, length, telling } = cone;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(angle);
    if (telling) {
      // Where it is about to go, faintly, and the air being pulled in.
      const left = Math.max(0, (state.flame!.tellUntil - state.tick) / TUNING.flameTell);
      ctx.globalAlpha = 0.25 + 0.35 * (1 - left);
      ctx.setLineDash([10, 12]); ctx.strokeStyle = '#ff9a4a'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(half) * length, Math.sin(half) * length);
      ctx.arc(0, 0, length, half, -half, true); ctx.closePath(); ctx.stroke();
      ctx.setLineDash([]);
      const n = reduced ? 4 : 8;
      for (let i = 0; i < n; i++) {
        const f = ((reduced ? 0.5 : time * 1.6) + i / n) % 1;
        const a = (hashed(i) - 0.5) * half * 1.6;
        const r = length * (1 - f) * 0.9;
        ctx.globalAlpha = 0.5 * f;
        ctx.strokeStyle = '#ffd0a0'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); ctx.lineTo(Math.cos(a) * (r - 26), Math.sin(a) * (r - 26)); ctx.stroke();
      }
    } else {
      const left = clampAlpha((state.flame!.until - state.tick) / TUNING.flameTicks);
      const strength = Math.min(1, left * 2.5) * Math.min(1, (1 - left) * 6 + 0.35);
      ctx.globalCompositeOperation = 'screen';
      const fire = ctx.createLinearGradient(0, 0, length, 0);
      fire.addColorStop(0, `rgba(255,246,210,${0.95 * strength})`);
      fire.addColorStop(0.22, `rgba(255,190,80,${0.9 * strength})`);
      fire.addColorStop(0.6, `rgba(255,110,30,${0.6 * strength})`);
      fire.addColorStop(1, 'rgba(220,60,10,0)');
      ctx.fillStyle = fire;
      ctx.beginPath(); ctx.moveTo(0, 0);
      // A ragged far edge: tongues, not a geometry diagram.
      const steps = reduced ? 6 : 14;
      for (let i = 0; i <= steps; i++) {
        const a = half - (i / steps) * half * 2;
        const flick = reduced ? 1 : 0.84 + 0.16 * Math.sin(time * 23 + i * 1.7) * Math.sin(time * 13 + i);
        ctx.lineTo(Math.cos(a) * length * flick, Math.sin(a) * length * flick);
      }
      ctx.closePath(); ctx.fill();
      // Hot core.
      ctx.globalAlpha = 0.8 * strength;
      const core = ctx.createLinearGradient(0, 0, length * 0.6, 0);
      core.addColorStop(0, 'rgba(255,255,235,0.9)'); core.addColorStop(1, 'rgba(255,200,120,0)');
      ctx.fillStyle = core;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(half * 0.45) * length * 0.6, Math.sin(half * 0.45) * length * 0.6);
      ctx.lineTo(Math.cos(-half * 0.45) * length * 0.6, Math.sin(-half * 0.45) * length * 0.6); ctx.closePath(); ctx.fill();
      // Embers riding the breath.
      ctx.globalAlpha = strength;
      for (let i = 0; i < (reduced ? 3 : 9); i++) {
        const f = ((reduced ? 0.4 : time * 2.4) + i * 0.17) % 1;
        const a = (hashed(i * 3) - 0.5) * half * 1.4;
        ctx.fillStyle = i % 2 ? '#fff0b0' : '#ffb060';
        ctx.beginPath(); ctx.arc(Math.cos(a) * length * f, Math.sin(a) * length * f + Math.sin(time * 9 + i) * 4, 3 - f * 2, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  // ---- the bench fire along the floor.
  function drawBenchFire(ctx: CanvasRenderingContext2D, state: ArcadeState, time: number, reduced: boolean) {
    const left = state.benchFireUntil - state.tick;
    if (left <= 0) return;
    const life = clampAlpha(left / 40) * clampAlpha((TUNING.benchFireTicks - left) / 20 + 0.2);
    const { from, to } = ARENA.bench; const y = ARENA.floor;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    // The glow on the counter.
    const glow = ctx.createLinearGradient(0, y - 90, 0, y + 10);
    glow.addColorStop(0, 'rgba(255,120,40,0)'); glow.addColorStop(1, `rgba(255,140,50,${0.35 * life})`);
    ctx.fillStyle = glow; ctx.fillRect(from - 30, y - 90, to - from + 60, 100);
    const n = reduced ? 9 : 15;
    for (let i = 0; i < n; i++) {
      const x = from + 20 + (i + 0.5) * (to - from - 40) / n + (reduced ? 0 : Math.sin(time * 5 + i * 2.1) * 6);
      const h = (34 + hashed(i) * 30) * life * (reduced ? 1 : 0.75 + 0.25 * Math.sin(time * 14 + i * 1.3) * Math.sin(time * 7 + i));
      const w = 16 + hashed(i * 5) * 12;
      const flame = ctx.createLinearGradient(0, y, 0, y - h);
      flame.addColorStop(0, 'rgba(255,230,150,0.95)'); flame.addColorStop(0.45, 'rgba(255,140,40,0.85)'); flame.addColorStop(1, 'rgba(255,60,10,0)');
      ctx.fillStyle = flame;
      ctx.beginPath(); ctx.moveTo(x - w / 2, y + 2);
      ctx.quadraticCurveTo(x - w * 0.6, y - h * 0.45, x + (reduced ? 0 : Math.sin(time * 6 + i) * 5), y - h);
      ctx.quadraticCurveTo(x + w * 0.6, y - h * 0.45, x + w / 2, y + 2); ctx.closePath(); ctx.fill();
    }
    // Smoke.
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < (reduced ? 3 : 7); i++) {
      const f = ((reduced ? 0.5 : time * 0.55) + i * 0.14) % 1;
      const x = from + 60 + hashed(i * 9) * (to - from - 120) + f * 30;
      const r = 14 + f * 36;
      ctx.globalAlpha = 0.28 * life * (1 - f);
      ctx.fillStyle = '#3a3b36';
      ctx.beginPath(); ctx.arc(x, y - 40 - f * 150, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawUtensil(ctx: CanvasRenderingContext2D, p: Projectile, time: number, reduced: boolean, mouth: { x: number; y: number }) {
    // Three shapes, chosen by id, so a storm has forks and spoons and knives in
    // it, each with a motion trail so it reads as flying metal and not a smudge.
    const kind = p.id % 3;
    const wallet = isWallet(p.id);
    const rot = wallet ? Math.sin(p.age * 0.05 + p.id) * 0.35 : p.age * 0.11 + p.id;
    junkSeen.set(p.id, { x: p.x, y: p.y, wallet });
    ctx.save();
    if (p.assisted) {
      ctx.strokeStyle = 'rgba(221,234,156,0.45)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 8]);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.quadraticCurveTo((p.x + mouth.x) / 2, Math.min(p.y, mouth.y) - 40, mouth.x, mouth.y); ctx.stroke();
      ctx.setLineDash([]);
    }
    for (let g = reduced ? 0 : 3; g >= 0; g--) {
      const back = g * 2.2;
      ctx.save();
      ctx.globalAlpha = g === 0 ? 1 : 0.22 - g * 0.05;
      ctx.translate(p.x - p.vx * back, p.y - p.vy * back); ctx.rotate(rot - g * 0.12);
      ctx.fillStyle = '#d7e1dc'; ctx.strokeStyle = '#303b38'; ctx.lineWidth = 1.5;
      if (wallet) {
        // The occasional hardware wallet: a small dark rectangle with a tiny screen.
        drawWallet(ctx, g === 0 ? 1 : 0.6);
      } else if (kind === 0) {
        ctx.beginPath(); ctx.roundRect(-22, -2.5, 30, 5, 2.5); ctx.fill(); ctx.stroke();
        for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.roundRect(6, k * 4.5 - 1.5, 16, 3, 1.5); ctx.fill(); ctx.stroke(); }
      } else if (kind === 1) {
        ctx.beginPath(); ctx.roundRect(-22, -2.5, 30, 5, 2.5); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.ellipse(14, 0, 9, 6.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.roundRect(-22, -3, 18, 6, 3); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-4, -4.5); ctx.lineTo(22, -2); ctx.lineTo(22, 1.5); ctx.lineTo(-4, 4.5); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      if (g === 0 && !wallet) { ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-18, -1); ctx.lineTo(4, -1); ctx.stroke(); }
      ctx.restore();
    }
    ctx.restore();
  }

  /** A hardware wallet, 36×22, centred: dark body, a tiny lit screen, one button. Drawn in the current transform. */
  function drawWallet(ctx: CanvasRenderingContext2D, lit: number) {
    ctx.fillStyle = '#1b2224'; ctx.strokeStyle = '#5a6a6c'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(-18, -11, 36, 22, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = `rgba(150,236,220,${0.9 * lit})`; ctx.beginPath(); ctx.roundRect(-12, -6, 17, 12, 2); ctx.fill();
    ctx.fillStyle = `rgba(20,40,38,${0.9 * lit})`; ctx.fillRect(-9, -3, 9, 1.5); ctx.fillRect(-9, 0, 6, 1.5);
    ctx.fillStyle = '#9aa6a3'; ctx.beginPath(); ctx.arc(11, 0, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-14, -9); ctx.lineTo(12, -9); ctx.stroke();
  }


  // ---- the rail under the ceiling and the blocks on it.
  //
  // A rusted pipe rail hung from the ceiling over the open air left of the
  // creature, with a riveted hatch where the blocks are let down. The rules
  // call what rides it a crate; it is drawn as a block — a riveted steel cube
  // with its coin embossed on the face, on a long chain — so it is a block on
  // a chain, which is the joke and also exactly what is on screen.
  const RAIL_LEFT = ARENA.rail.from - 30;
  const RAIL_RIGHT = ARENA.rail.to + 30;
  /**
   * Where the rail is drawn: lower than the rules' hook line (y 30), which
   * sits under the mutation chips once the first mutation lands, so the
   * trolley and its run stay in sight all shift. The block comes out of the
   * dark just under it.
   */
  const RAIL_Y = Math.max(ARENA.rail.y, 64);
  function drawRail(ctx: CanvasRenderingContext2D, state: ArcadeState, tick: number) {
    const { from, lower } = ARENA.rail; const y = RAIL_Y;
    // How far open the hatch is: open while a block is let down or hoisted.
    let open = 0;
    for (const c of state.crates ?? []) {
      const t = tick - c.born;
      open = Math.max(open, clampAlpha(1 - t / (lower + 10)), clampAlpha((t - (c.life - lower - 10)) / 10));
    }
    ctx.save();
    // Brackets down from the ceiling, in the room's rusted iron.
    for (const x of [RAIL_LEFT + 26, (RAIL_LEFT + RAIL_RIGHT) / 2 + 20, RAIL_RIGHT - 26]) {
      ctx.fillStyle = '#1c1714'; ctx.fillRect(x - 3, 0, 6, y - 4);
      ctx.fillStyle = `${RIM}0.35)`; ctx.fillRect(x + 2, 0, 1, y - 4);
    }
    // The hatch the blocks come down through: a riveted plate, a dark slot
    // whose two doors swing down while a block is let down or hoisted.
    ctx.fillStyle = '#2a211b'; ctx.beginPath(); ctx.roundRect(from - 34, 0, 68, y - 8, 3); ctx.fill();
    ctx.fillStyle = '#050707'; ctx.beginPath(); ctx.roundRect(from - 24 - 8 * open, y - 16, 48 + 16 * open, 7 + 8 * open, 2); ctx.fill();
    if (open > 0.02) {
      // Lamplight spilling out of the open slot, and the two doors hanging down.
      ctx.fillStyle = `rgba(255,186,108,${0.25 * open})`; ctx.fillRect(from - 22, y - 9, 44, 4 + 6 * open);
      ctx.fillStyle = '#4a3a2c'; ctx.strokeStyle = `${RIM}0.75)`; ctx.lineWidth = 1.2;
      for (const side of [-1, 1]) {
        ctx.save(); ctx.translate(from + side * (24 + 8 * open), y - 9); ctx.rotate(side * open * 1.25);
        ctx.beginPath(); ctx.rect(side > 0 ? 0 : -26, 0, 26, 5); ctx.fill(); ctx.stroke(); ctx.restore();
      }
    }
    ctx.fillStyle = '#8a6d52';
    for (const [rx, ry] of [[-28, 5], [28, 5], [-28, y - 14], [28, y - 14]]) { ctx.beginPath(); ctx.arc(from + rx, ry, 1.8, 0, Math.PI * 2); ctx.fill(); }
    // The track: a rusted iron bar with the lamps' warm rim along its top, so
    // it reads against the dark ceiling, exactly as long as the trolley's run.
    const pipe = ctx.createLinearGradient(0, y - 5, 0, y + 5);
    pipe.addColorStop(0, '#8f6a48'); pipe.addColorStop(0.3, '#55402e'); pipe.addColorStop(0.7, '#2c2018'); pipe.addColorStop(1, '#1a120d');
    ctx.fillStyle = pipe; ctx.beginPath(); ctx.roundRect(RAIL_LEFT, y - 5, RAIL_RIGHT - RAIL_LEFT, 10, 4); ctx.fill();
    ctx.strokeStyle = `${RIM}0.85)`; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(RAIL_LEFT + 4, y - 4); ctx.lineTo(RAIL_RIGHT - 4, y - 4); ctx.stroke();
    // End stops: where the trolley turns round.
    for (const x of [ARENA.rail.from - 24, ARENA.rail.to + 24]) {
      ctx.fillStyle = '#2a201a'; ctx.beginPath(); ctx.roundRect(x - 5, y - 11, 10, 22, 2); ctx.fill();
      ctx.fillStyle = `${RIM}0.7)`; ctx.fillRect(x - 5, y - 11, 10, 2);
    }
    // Collars where the brackets hold it.
    ctx.fillStyle = '#241c17';
    for (const x of [RAIL_LEFT + 26, (RAIL_LEFT + RAIL_RIGHT) / 2 + 20, RAIL_RIGHT - 26]) { ctx.beginPath(); ctx.roundRect(x - 6, y - 8, 12, 16, 2); ctx.fill(); }
    ctx.restore();
  }

  /** A short run of chain links from (x0, y0) to (x1, y1). */
  function links(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string) {
    const dx = x1 - x0; const dy = y1 - y0; const len = Math.hypot(dx, dy);
    const n = Math.max(2, Math.round(len / 9));
    const along = Math.atan2(dy, dx);
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n;
      const cx = x0 + dx * f; const cy = y0 + dy * f;
      // A dark core under each link so the chain holds against the wall, then
      // the steel, then the lamps' warm rim along its top.
      ctx.lineWidth = 5; ctx.strokeStyle = '#0b0d0d';
      ctx.beginPath(); ctx.ellipse(cx, cy, 6, i % 2 ? 2.2 : 4, along, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 3.2; ctx.strokeStyle = i % 2 ? '#7a7e78' : color;
      ctx.beginPath(); ctx.ellipse(cx, cy, 6, i % 2 ? 2.2 : 4, along, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1.2; ctx.strokeStyle = `${RIM}0.8)`;
      ctx.beginPath(); ctx.ellipse(cx, cy, 6, i % 2 ? 2.2 : 4, along, Math.PI * 1.1, Math.PI * 1.7); ctx.stroke();
    }
  }

  /** A block on its chain: trolley, chain, its coin's glow, the riveted cube, the embossed coin. */
  function drawCrate(ctx: CanvasRenderingContext2D, c: Crate, tick: number, time: number, reduced: boolean, loaded: Ingredient) {
    // The block calls for its coin when that coin is in the barrel, and steps
    // back when it is not, so swinging the barrel up at it reads as a choice.
    const wanted = loaded === c.ingredient;
    const at = crateAt(c, tick);
    const railY = RAIL_Y;
    const tint = COLORS[c.ingredient];
    const kick = crateKick.get(c.id);
    const kickAge = kick ? time - kick.at : 9;
    const knock = kick && kickAge < 0.9 && !reduced ? kick.dir * 0.5 * Math.exp(-kickAge * 5) * Math.sin(kickAge * 24) : 0;
    // The trolley runs a little ahead of where the rules hang the block, so
    // the chain leans and the block trails it: it reads as moving in a still.
    const speed = (crateAt(c, tick + 1).hookX - crateAt(c, tick - 1).hookX) / 2;
    const trolley = at.hookX + (reduced ? 0 : clamp(speed * 18, -32, 32));
    const swing = Math.atan2(at.x - trolley, Math.max(1, at.y - railY)) + knock;
    // Drawn a little larger than its collision radius: a coin's own edge
    // touches the cube when the rules say it hits.
    const s = 40; const d = 14;
    // Fading as it is hoisted, so it never reaches the mutation chips at the top.
    const hoisting = tick - c.born > c.life - ARENA.rail.lower;
    // It comes out of the dark under the ceiling (the mutation chips sit over
    // the hatch), and fades as it is hoisted back up into it.
    const lowering = tick - c.born < ARENA.rail.lower;
    const hoist = hoisting ? clampAlpha((at.y - RAIL_Y - 8) / 50) : lowering ? clampAlpha((at.y - RAIL_Y) / 45) : 1;
    ctx.save();
    // The trolley riding the pipe: two wheels on top, a plate, a hook.
    ctx.fillStyle = '#2f2620'; ctx.beginPath(); ctx.roundRect(trolley - 14, railY + 2, 28, 12, 3); ctx.fill();
    ctx.strokeStyle = `${RIM}0.6)`; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#b09474';
    for (const wx of [-8, 8]) {
      ctx.fillStyle = '#b09474'; ctx.beginPath(); ctx.arc(trolley + wx, railY - 5, 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `${RIM}0.9)`; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(trolley + wx, railY - 5, 4, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
    }
    // The chain down to the top of the block.
    const topX = at.x - Math.sin(swing) * (s + d * 0.6); const topY = at.y - Math.cos(swing) * (s + d * 0.6);
    links(ctx, trolley, railY + 14, topX, topY, '#c4ccc4');
    // A soft dark backplate, so the block parts from the painted kitchen
    // behind it (the pan, the shelf, the lamp) instead of joining them.
    const back = ctx.createRadialGradient(at.x, at.y, 20, at.x, at.y, 96);
    back.addColorStop(0, 'rgba(2,5,5,0.72)'); back.addColorStop(0.55, 'rgba(2,5,5,0.5)'); back.addColorStop(1, 'rgba(2,5,5,0)');
    ctx.fillStyle = back; ctx.beginPath(); ctx.arc(at.x, at.y, 96, 0, Math.PI * 2); ctx.fill();
    // Its coin's light on the wall behind it, so it reads at stream size —
    // brighter, and breathing, when its coin is the one loaded.
    const pulse = reduced ? 0.6 : 0.5 + 0.5 * Math.sin(time * 2 * Math.PI * 2 + c.id);
    const glow = ctx.createRadialGradient(at.x, at.y, 10, at.x, at.y, 96);
    glow.addColorStop(0, `${tint}55`); glow.addColorStop(1, `${tint}00`);
    ctx.globalAlpha = (wanted ? 0.6 + 0.4 * pulse : 0.45) * hoist; ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(at.x, at.y, 96, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
    if (hoist < 1) ctx.globalAlpha = hoist;
    // A faint wake of where it just was, so a still shows it moving.
    if (!reduced && Math.abs(speed) > 0.6) {
      for (const [k, a] of [[7, 0.16], [14, 0.08]] as const) {
        const was = crateAt(c, tick - k);
        ctx.save(); ctx.globalAlpha = a * 0.7 * hoist; ctx.translate(was.x, was.y); ctx.rotate(swing);
        ctx.fillStyle = tint;
        ctx.beginPath(); ctx.roundRect(-s, -s, 2 * s, 2 * s, 3); ctx.fill(); ctx.restore();
      }
    }
    // The cube, swinging with its chain: painted gunmetal like the launcher,
    // lit by the lamps on its lid and top edge, riveted along its edges.
    ctx.translate(at.x, at.y); ctx.rotate(swing);
    softShadow(ctx, 8, s + 14, s + 8, 6, 0.35);
    const lid = ctx.createLinearGradient(0, -s - d, 0, -s);
    lid.addColorStop(0, '#5e5547'); lid.addColorStop(1, '#2b2d2a');
    ctx.fillStyle = lid;
    ctx.beginPath(); ctx.moveTo(-s, -s); ctx.lineTo(-s + d, -s - d); ctx.lineTo(s + d, -s - d); ctx.lineTo(s, -s); ctx.closePath(); ctx.fill();
    const side = ctx.createLinearGradient(s, 0, s + d, 0);
    side.addColorStop(0, '#3a3f3c'); side.addColorStop(1, '#1b1f1e');
    ctx.fillStyle = side;
    ctx.beginPath(); ctx.moveTo(s, -s); ctx.lineTo(s + d, -s - d); ctx.lineTo(s + d, s - d); ctx.lineTo(s, s); ctx.closePath(); ctx.fill();
    // A lamp-lit edge where the lid meets the side.
    ctx.strokeStyle = `${RIM}0.45)`; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(s, -s); ctx.lineTo(s + d, -s - d); ctx.stroke();
    const face = ctx.createLinearGradient(-s, -s, s, s);
    face.addColorStop(0, '#4b4d48'); face.addColorStop(0.45, '#2f3434'); face.addColorStop(1, '#151818');
    ctx.fillStyle = face; ctx.beginPath(); ctx.roundRect(-s, -s, 2 * s, 2 * s, 3); ctx.fill();
    // The face takes a little of its coin's colour.
    ctx.fillStyle = withAlpha(tint, 0.15); ctx.beginPath(); ctx.roundRect(-s, -s, 2 * s, 2 * s, 3); ctx.fill();
    // Two straps across the face, lit along their top edges.
    for (const sy of [-s + 7, s - 14]) {
      ctx.fillStyle = '#23282a'; ctx.fillRect(-s, sy, 2 * s, 7);
      ctx.fillStyle = `${RIM}0.35)`; ctx.fillRect(-s, sy, 2 * s, 1.2);
    }
    ctx.fillStyle = `${RIM}0.8)`; ctx.fillRect(-s + 2, -s, 2 * s - 4, 2.5);
    ctx.fillStyle = `${RIM}0.3)`; ctx.fillRect(-s, -s + 2, 2, 2 * s - 4);
    // Rivets: four along the top and bottom straps, two down each side.
    const rivets: [number, number][] = [];
    for (const rx of [-s + 6, -s / 3, s / 3, s - 6]) rivets.push([rx, -s + 10.5], [rx, s - 10.5]);
    for (const ry of [-s / 3 + 4, s / 3 - 4]) rivets.push([-s + 5, ry], [s - 5, ry]);
    for (const [rx, ry] of rivets) {
      ctx.fillStyle = '#16191a'; ctx.beginPath(); ctx.arc(rx + 0.6, ry + 0.8, 2.8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#a58d70'; ctx.beginPath(); ctx.arc(rx, ry, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#f3d9b0'; ctx.beginPath(); ctx.arc(rx - 0.8, ry - 0.8, 0.9, 0, Math.PI * 2); ctx.fill();
    }
    // Its coin's colour on the rim: a thin seam, not a neon frame, that
    // brightens and breathes when its coin is the one loaded.
    ctx.save();
    ctx.strokeStyle = tint; ctx.lineJoin = 'round';
    ctx.lineWidth = 2; ctx.globalAlpha = (wanted ? 0.75 + 0.25 * pulse : 0.7) * hoist;
    ctx.beginPath(); ctx.roundRect(-s + 2, -s + 2, 2 * s - 4, 2 * s - 4, 2); ctx.stroke();
    ctx.restore();
    // The enamel plate on its front, in its coin's colour, set in a bevelled ring.
    ctx.save();
    ctx.shadowColor = tint; ctx.shadowBlur = wanted ? (reduced ? 14 : 12 + 12 * pulse) : 8;
    ctx.fillStyle = '#0d0f0f'; ctx.beginPath(); ctx.arc(0, 0, 34, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    const enamel = ctx.createRadialGradient(-8, -10, 4, 0, 0, 32);
    enamel.addColorStop(0, withAlpha(tint, wanted ? 1 : 0.85)); enamel.addColorStop(1, withAlpha(tint, wanted ? 0.55 + 0.3 * pulse : 0.45));
    ctx.fillStyle = enamel; ctx.beginPath(); ctx.arc(0, 0, 32, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#b39a7c'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 33, Math.PI * 0.95, Math.PI * 1.85); ctx.stroke();
    ctx.restore();
    ctx.save(); ctx.globalAlpha = hoist;
    coin(ctx, c.ingredient, at.x, at.y, 56, swing, reduced ? 0.8 : time * 1.4 + c.id, wanted ? 1 : 0.6);
    ctx.restore();
    // A wrong coin: a red cross over its mark for a moment.
    if (kick && kickAge < 0.35) {
      ctx.save(); ctx.translate(at.x, at.y); ctx.rotate(swing);
      ctx.globalAlpha = 1 - kickAge / 0.35; ctx.strokeStyle = '#ff5a4a'; ctx.lineWidth = 5; ctx.lineJoin = 'round';
      ctx.shadowColor = '#ff3a2a'; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.roundRect(-s - 3, -s - 3, 2 * s + 6, 2 * s + 6, 4); ctx.stroke();
      ctx.globalAlpha *= 0.55; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.moveTo(-20, -20); ctx.lineTo(20, 20); ctx.moveTo(20, -20); ctx.lineTo(-20, 20); ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * The block in the instant it breaks: its iron face swollen 15 %, then
   * (second pass, over the burst) white-hot cracks from its mark to its edges.
   */
  function drawCrackedCube(ctx: CanvasRenderingContext2D, x: number, y: number, tint: string, age: number, seed: number, cracks: boolean) {
    const s = 40 * (1.12 + 1.2 * age);
    ctx.save(); ctx.translate(x, y);
    if (!cracks) {
      const face = ctx.createLinearGradient(-s, -s, s, s);
      face.addColorStop(0, '#6a6b64'); face.addColorStop(0.5, '#3a3d3a'); face.addColorStop(1, '#1b1e1e');
      ctx.fillStyle = face; ctx.beginPath(); ctx.roundRect(-s, -s, 2 * s, 2 * s, 4); ctx.fill();
      ctx.strokeStyle = tint; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = withAlpha(tint, 0.9); ctx.beginPath(); ctx.arc(0, 0, s * 0.62, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + hashed(seed * 7 + i) * 0.6;
        const pts: [number, number][] = [[0, 0]];
        for (let j = 1; j <= 3; j++) {
          const rr = s * 1.05 * (j / 3); const jag = (hashed(seed + i * 11 + j) - 0.5) * 0.5;
          pts.push([Math.cos(a + jag) * rr, Math.sin(a + jag) * rr]);
        }
        for (const [w, col] of [[9, withAlpha(tint, 0.9)], [4, '#fffbe8']] as const) {
          ctx.strokeStyle = col; ctx.lineWidth = w;
          ctx.beginPath(); pts.forEach(([px, py], k) => (k ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  /** A coin out of a broken block, on its way into the mouth. */
  function drawPour(ctx: CanvasRenderingContext2D, p: Projectile, reduced: boolean) {
    // Not out of the block yet.
    if (p.age <= 0) return;
    const tint = p.cooked ? '#ffb060' : COLORS[p.ingredient];
    // Big in the air, so three coins in a row read at stream size; down to an
    // ordinary coin's size over its last few ticks, so it goes into the mouth
    // the way any coin does rather than as a disc wider than the lips.
    const left = (p.arrive ?? TUNING.pourArrive) - p.age;
    const sc = 0.78 - 0.23 * clampAlpha(1 - left / 14);
    ctx.save();
    const glow = ctx.createRadialGradient(p.x, p.y, 4, p.x, p.y, 68 * sc);
    glow.addColorStop(0, withAlpha(tint, 0.55)); glow.addColorStop(0.5, withAlpha(tint, 0.18)); glow.addColorStop(1, withAlpha(tint, 0));
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(p.x, p.y, 68 * sc, 0, Math.PI * 2); ctx.fill();
    // Its own coin's trail: Bitcoin's gold discs, Ether's bubbles, HEMI's hot streak.
    for (let k = 3; k >= 1; k--) {
      const bx = p.x - p.vx * k * 2.2; const by = p.y - p.vy * k * 2.2;
      ctx.globalAlpha = 0.75 - k * 0.18;
      if (p.ingredient === 'metal') { ctx.fillStyle = k % 2 ? '#b07a26' : '#d9a23a'; ctx.beginPath(); ctx.arc(bx, by, 17 - k * 3, 0, Math.PI * 2); ctx.fill(); }
      else if (p.ingredient === 'balloon') { ctx.fillStyle = 'rgba(155,233,223,0.4)'; ctx.strokeStyle = 'rgba(224,255,250,0.95)'; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.arc(bx, by - k * 4, 11 - k * 1.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
    if (p.ingredient === 'pepper') {
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
      // Tapered and fading, so a string of HEMI coins never reads as one bar.
      for (const [w, a, col] of [[14, 0.7, '255,70,20'], [5, 0.95, '255,240,210']] as const) {
        const g = ctx.createLinearGradient(p.x, p.y, p.x - p.vx * 4.5, p.y - p.vy * 4.5);
        g.addColorStop(0, `rgba(${col},${a})`); g.addColorStop(1, `rgba(${col},0)`);
        ctx.strokeStyle = g; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(p.x - p.vx * 4.5, p.y - p.vy * 4.5); ctx.lineTo(p.x, p.y); ctx.stroke();
      }
      ctx.restore();
    }
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(4,12,10,0.45)'; ctx.lineWidth = 13;
    ctx.beginPath(); ctx.moveTo(p.x - p.vx * 3.4, p.y - p.vy * 3.4); ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.strokeStyle = tint; ctx.globalAlpha = 0.8; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(p.x - p.vx * 3.2, p.y - p.vy * 3.2); ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.globalAlpha = 0.9; ctx.lineWidth = 3; ctx.strokeStyle = '#fff6d8';
    ctx.beginPath(); ctx.arc(p.x, p.y, 45 * sc, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    coin(ctx, p.ingredient, p.x, p.y, 84 * sc, Math.atan2(p.vy, p.vx), reduced ? 0.8 : p.age * 0.3 + p.id, 1);
  }

  /**
   * How a coin flies, drawn on it: a wake that traces the arc it is on, from
   * its own gravity, so a still shows the shape of the shot. Bitcoin's is a
   * heavy smoky arc that bends hard; Ether's is a string of bubbles on a lazy
   * curve; HEMI's is a jet, dead straight for as long as its burn lasts.
   */
  /**
   * Where each coin in the air really was, tick by tick: its trail is drawn
   * from this, never extrapolated back along its present heading (after a
   * bounce or a lip-out that drew a trail through the mouth it never crossed).
   */
  const trails = new Map<number, { tick: number; x: number; y: number }[]>();
  let trailTick = -1;
  function noteTrails(state: ArcadeState) {
    if (state.tick === trailTick) return;
    const rewound = state.tick < trailTick;
    trailTick = state.tick;
    if (rewound) trails.clear();
    const alive = new Set<number>();
    for (const p of state.projectiles) {
      alive.add(p.id);
      let h = trails.get(p.id);
      if (!h) { h = []; trails.set(p.id, h); }
      h.push({ tick: state.tick, x: p.x, y: p.y });
      if (h.length > 40) h.shift();
    }
    for (const id of [...trails.keys()]) if (!alive.has(id)) trails.delete(id);
  }
  /** Where `p` was `back` ticks before `tick`, from its history; null past the oldest record. */
  function pastOf(p: Projectile, back: number, tick: number): { x: number; y: number } | null {
    const h = trails.get(p.id);
    if (!h || h.length < 2) return back <= 0 ? { x: p.x, y: p.y } : null;
    const want = tick - back;
    for (let i = h.length - 1; i > 0; i--) {
      const b = h[i]; const a = h[i - 1];
      if (a.tick <= want && want <= b.tick) {
        const f = (want - a.tick) / Math.max(1, b.tick - a.tick);
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
    }
    return want >= h[h.length - 1].tick ? { x: p.x, y: p.y } : null;
  }

  function drawFlightTrait(ctx: CanvasRenderingContext2D, p: Projectile, time: number, reduced: boolean, tick: number) {
    if (p.spent) return;
    // Where it was `back` ticks ago: its real path, as far back as it is known.
    const past = (back: number) => pastOf(p, back, tick);
    const span = Math.min(p.age, reduced ? 10 : p.ingredient === 'metal' ? 26 : 20);
    ctx.save();
    if (p.ingredient === 'pepper' && p.age <= (p.straight ?? 0) + 4) {
      // The turbo: a long white-hot jet straight back along the shot.
      const speed = Math.max(0.01, Math.hypot(p.vx, p.vy));
      const ux = p.vx / speed; const uy = p.vy / speed;
      const length = Math.min(p.age * speed, 150);
      ctx.lineCap = 'round'; ctx.globalCompositeOperation = 'lighter';
      // Saturated red-orange flame round a white-hot core, added as light.
      for (const [w, a, col] of [[22, 0.75, '255,70,20'], [12, 0.95, '255,150,40'], [5, 1, '255,255,235']] as const) {
        const g = ctx.createLinearGradient(p.x, p.y, p.x - ux * length, p.y - uy * length);
        g.addColorStop(0, `rgba(${col},${a})`); g.addColorStop(1, `rgba(${col},0)`);
        ctx.strokeStyle = g; ctx.lineWidth = w + (reduced ? 0 : Math.sin(time * 41) * 1.5);
        ctx.beginPath(); ctx.moveTo(p.x - ux * 16, p.y - uy * 16); ctx.lineTo(p.x - ux * length, p.y - uy * length); ctx.stroke();
      }
    } else if (p.ingredient === 'balloon') {
      // A soft mint ribbon along its arc, then bubbles rising off it, clear of the coin itself.
      ctx.save(); ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(155,233,223,0.2)'; ctx.lineWidth = 12;
      ctx.beginPath(); for (let k = 0; k <= span; k += 2) { const q = past(k); if (!q) break; if (k === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); } ctx.stroke(); ctx.restore();
      ctx.lineWidth = 2.6;
      for (let i = 2; i <= Math.floor(span / 4) + 1; i++) {
        const at = past(i * 4);
        if (!at) break;
        const wob = reduced ? 0 : Math.sin(time * 6 + p.id + i * 1.7) * 5;
        const r = Math.max(7, 12 - i * 0.6);
        ctx.globalAlpha = Math.max(0, 1 - i * 0.11);
        ctx.fillStyle = 'rgba(155,233,223,0.5)'; ctx.strokeStyle = 'rgba(224,255,250,0.95)';
        ctx.beginPath(); ctx.arc(at.x + wob, at.y - i * 3, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.beginPath(); ctx.arc(at.x + wob - r * 0.35, at.y - i * 3 - r * 0.35, Math.max(1, r * 0.22), 0, Math.PI * 2); ctx.fill();
      }
    } else if (p.ingredient === 'metal') {
      // A heavy gold ribbon behind it, on the arc it is falling along,
      // tapering away: one stroke, not a string of discs.
      ctx.lineCap = 'round';
      const n = Math.floor(span / 2);
      for (let i = 0; i < n; i++) {
        const a = past(i * 2 + 2); const b = past(i * 2 + 4); const f = i / Math.max(1, n);
        if (!a || !b) break;
        ctx.globalAlpha = 0.7 * (1 - f) + 0.05;
        ctx.strokeStyle = '#e0a83c'; ctx.lineWidth = 8 * (1 - f) + 2.5;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawFood(ctx: CanvasRenderingContext2D, p: Projectile, time: number, reduced: boolean, tick: number) {
    const tint = COLORS[p.ingredient];
    drawFlightTrait(ctx, p, time, reduced, tick);
    ctx.save();
    if (p.spent) ctx.globalAlpha = 0.55;
    // A dark snack crossing the dark half of the room disappears at stream
    // bitrate, so it carries its own light.
    const glow = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, 42);
    glow.addColorStop(0, `${tint}66`); glow.addColorStop(.45, `${tint}22`); glow.addColorStop(1, `${tint}00`);
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(p.x, p.y, 42, 0, Math.PI * 2); ctx.fill();
    if (p.cooked) {
      // On fire: a trail of flame behind it and a halo on it.
      ctx.save(); ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < (reduced ? 3 : 6); i++) {
        const back = (i + 1) * 1.6;
        const at = pastOf(p, back, tick);
        if (!at) break;
        const r = 16 - i * 2 + (reduced ? 0 : Math.sin(time * 19 + i) * 2);
        const f = ctx.createRadialGradient(at.x, at.y, 1, at.x, at.y, r);
        f.addColorStop(0, 'rgba(255,240,170,0.9)'); f.addColorStop(0.5, 'rgba(255,140,40,0.55)'); f.addColorStop(1, 'rgba(255,80,20,0)');
        ctx.fillStyle = f; ctx.beginPath(); ctx.arc(at.x, at.y, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
    // The serving carries a dark halo, a bright tail in its own colour and a
    // ring: the tail along the path it really took.
    const tail = (back: number) => {
      ctx.beginPath(); ctx.moveTo(p.x, p.y);
      for (let k = 1; k <= Math.ceil(back); k++) { const q = pastOf(p, Math.min(back, k), tick); if (!q) break; ctx.lineTo(q.x, q.y); }
      ctx.stroke();
    };
    ctx.strokeStyle = 'rgba(4,12,10,0.5)'; ctx.lineWidth = 11; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    tail(3.4);
    ctx.strokeStyle = p.cooked ? '#ffb060' : tint; ctx.globalAlpha *= .6; ctx.lineWidth = 6;
    tail(3.2);
    ctx.globalAlpha = p.spent ? 0.5 : .95; ctx.lineWidth = 2;
    tail(1.6);
    // The ring sits just outside the coin's face: the coin the rules test is
    // the coin drawn, not a disc half again as big.
    ctx.globalAlpha = p.spent ? 0.4 : .85; ctx.lineWidth = 2;
    if (p.bank > 0) { ctx.strokeStyle = '#ffd36a'; ctx.lineWidth = 3; }
    ctx.beginPath(); ctx.arc(p.x, p.y, 24.5, 0, Math.PI * 2); ctx.stroke();
    if (p.assisted && !p.spent && p.kind === 'food') {
      // Pulled in (the coin it is craving, or metal to HODL jaws): a gold ring
      // that tightens as it curves toward the mouth.
      ctx.globalAlpha = 0.55 + (reduced ? 0 : 0.25 * Math.sin(time * 9 + p.id)); ctx.strokeStyle = '#ffe28a'; ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.arc(p.x, p.y, 36, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
    if (p.cooked) {
      // Turbo'd: a hot ring around the coin, outside the mark.
      ctx.globalAlpha = 0.9; ctx.strokeStyle = '#ffd080'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, 31 + (reduced ? 0 : Math.sin(time * 21) * 1.5), 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
    // The coin itself: tilted with its heading (at most 15°), the glint spinning round it.
    // Spent (knocked off the teeth, or on the floor): grey but solid, so it
    // never shares the look of a coin going down the throat.
    ctx.save(); if (p.spent) ctx.globalAlpha = 0.92;
    coin(ctx, p.ingredient, p.x, p.y, 46, Math.atan2(p.vy, p.vx), reduced ? 0.8 : p.age * 0.16 + p.id, p.spent ? 0.3 : 1);
    ctx.restore();
  }

  /** The first second of a coin's free flight from the muzzle: its own gravity, speed and burn, nothing in the way. */
  function lancePath(food: Ingredient, rad: number, power: number, px: number, py: number): { x: number; y: number }[] {
    const fl = flightOf(food);
    let x = px + Math.cos(rad) * ARENA.barrelLength; let y = py + Math.sin(rad) * ARENA.barrelLength;
    const speed = launchSpeed(food, power); const straight = straightTicks(food, power);
    const vx = Math.cos(rad) * speed; let vy = Math.sin(rad) * speed;
    const out = [{ x, y }];
    for (let age = 1; age <= 60; age++) {
      if (age > straight) vy += fl.gravity;
      x += vx; y += vy; out.push({ x, y });
    }
    return out;
  }
  /** The point `distance` along a polyline, with the unit tangent there. */
  function pointAlong(path: { x: number; y: number }[], distance: number): { x: number; y: number; nx: number; ny: number } {
    let left = distance;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]; const b = path[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len > 0 && left <= len) {
        const f = left / len;
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, nx: (b.x - a.x) / len, ny: (b.y - a.y) / len };
      }
      left -= len;
    }
    const a = path[path.length - 2]; const b = path[path.length - 1];
    const len = Math.max(0.01, Math.hypot(b.x - a.x, b.y - a.y));
    return { x: b.x, y: b.y, nx: (b.x - a.x) / len, ny: (b.y - a.y) / len };
  }
  /** Strokes the stretch of a polyline between two distances along it. */
  function strokeAlong(ctx: CanvasRenderingContext2D, path: { x: number; y: number }[], from: number, to: number) {
    if (to <= from) return;
    const start = pointAlong(path, from);
    ctx.beginPath(); ctx.moveTo(start.x, start.y);
    let walked = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]; const b = path[i];
      walked += Math.hypot(b.x - a.x, b.y - a.y);
      if (walked <= from) continue;
      if (walked >= to) break;
      ctx.lineTo(b.x, b.y);
    }
    const end = pointAlong(path, to);
    ctx.lineTo(end.x, end.y); ctx.stroke();
  }

  function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, alpha: number, font = DISPLAY, align: CanvasTextAlign = 'center', outline = 6) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `${font === DISPLAY ? '700' : '800'} ${size}px ${font}`;
    ctx.textAlign = align; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(4,10,9,0.9)'; ctx.lineWidth = outline;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
    ctx.restore();
  }

  /**
   * The tag that rides under a block: whose it is while it hangs, WRONG
   * TOKEN. for a moment when another coin glances off, MISSED THE BLOCK.
   * while it is hoisted away. Drawn after the coins, well under the cube's
   * swing, so a glancing coin never covers it.
   */
  function drawBlockTags(ctx: CanvasRenderingContext2D, state: ArcadeState, tick: number, time: number, reduced: boolean) {
    for (const c of state.crates ?? []) {
      const at = crateAt(c, tick);
      const t = tick - c.born;
      const hoisting = t > c.life - ARENA.rail.lower;
      const lowering = t < ARENA.rail.lower;
      let text = BLOCK_NAMES[c.ingredient]; let color = COLORS[c.ingredient]; let a = 1;
      if (blockTag && blockTag.text === CAPTIONS.wrongToken && time - blockTag.born < blockTag.life) { text = blockTag.text; color = blockTag.color; }
      else if (hoisting) { text = CAPTIONS.blockMissed; color = '#cdd8c4'; }
      // On the chain just above the block, out of the captions' way: it
      // snaps on at full strength once the block is most of the way down.
      const showFrom = Math.round(ARENA.rail.lower * 0.7);
      if (lowering && t < showFrom) continue;
      if (hoisting) a *= clampAlpha((at.y - 90) / 50);
      if (a <= 0.02) continue;
      const pop = reduced ? 1 : 0.8 + 0.2 * easeOut(clampAlpha((t - showFrom) / 7));
      ctx.font = `700 22px ${DISPLAY}`;
      const w = ctx.measureText(text).width + 20;
      // When the camera has pushed in far enough to put the tag under the
      // mutation chips, it hangs beside the block instead, on the open side.
      // On its chain, its bottom edge just above the block; beside the block
      // when the camera would put that under the mutation chips; and never
      // under the FOMO wordmark at the top left.
      const above = at.y - 54 - 12 - 15;
      const under = toScreenY(above) < 62;
      let x = under ? at.x + 40 + 16 + w / 2 : at.x;
      const y = under ? at.y - 18 : above;
      const left = toScreenX(x - w / 2);
      if (left < 322) x += (322 - left) / camera.zoom;
      ctx.save(); ctx.translate(x, y); ctx.scale(pop, pop);
      ctx.globalAlpha = a; ctx.fillStyle = '#060e0cf0'; ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(-w / 2, -15, w, 30, 7); ctx.fill(); ctx.stroke();
      drawText(ctx, text, 0, 1, 22, color, a, DISPLAY, 'center', 0);
      ctx.restore();
    }
  }

  /**
   * Plates of a broken block: its dark riveted iron, tumbling and falling,
   * lamplight on the top edge and a thin edge of its coin's colour. Drawn
   * before the caption, so they never cover the BLOCK REWARD. card, and
   * never over the creature.
   */
  function drawShards(ctx: CanvasRenderingContext2D, t: number) {
    for (const p of particles) {
      if (p.kind !== 'shard') continue;
      const age = t - p.born;
      if (age < 0 || age > p.life) continue;
      const f = age / p.life;
      const x = p.x + p.vx * age; const y = p.y + p.vy * age + p.gravity * age * age * 0.5;
      if (x > 640) continue;
      const s = p.size;
      ctx.save(); ctx.translate(x, y); ctx.rotate((p.vx > 0 ? 1 : -1) * age * 8 + p.size);
      ctx.globalAlpha = f < 0.6 ? 1 : (1 - f) / 0.4;
      // A torn steel plate: an irregular quad, not a card.
      const h = s / 1.3; const j = (k: number) => (hashed(p.size * 7 + k) - 0.5) * s * 0.28;
      const quad: [number, number][] = [[-s / 2 + j(1), -h / 2 + j(2)], [s / 2 + j(3), -h / 2 + j(4)], [s / 2 + j(5), h / 2 + j(6)], [-s / 2 + j(7), h / 2 + j(8)]];
      const plate = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
      plate.addColorStop(0, '#5b5f5c'); plate.addColorStop(0.45, '#2f3434'); plate.addColorStop(1, '#151818');
      ctx.fillStyle = plate; ctx.beginPath(); quad.forEach(([qx, qy], k) => (k ? ctx.lineTo(qx, qy) : ctx.moveTo(qx, qy))); ctx.closePath(); ctx.fill();
      // A piece of the cube's own face: its strap and a row of rivets, lamplight on the top edge.
      ctx.save(); ctx.clip();
      ctx.fillStyle = '#23282a'; ctx.fillRect(-s / 2, -h / 6, s, h / 3);
      ctx.fillStyle = `${RIM}0.35)`; ctx.fillRect(-s / 2, -h / 6, s, 1.2);
      ctx.restore();
      ctx.strokeStyle = `${RIM}0.85)`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(quad[0][0], quad[0][1]); ctx.lineTo(quad[1][0], quad[1][1]); ctx.stroke();
      for (const k of [-0.25, 0.25]) {
        ctx.fillStyle = '#a58d70'; ctx.beginPath(); ctx.arc(k * s, 0, 2.6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#f3d9b0'; ctx.beginPath(); ctx.arc(k * s - 0.8, -0.8, 0.9, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(quad[1][0], quad[1][1]); ctx.lineTo(quad[2][0], quad[2][1]); ctx.lineTo(quad[3][0], quad[3][1]); ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * The one caption, in screen space. Drawn before the coins and the launcher
   * (under an undone camera), so a line never hides a coin in flight or the
   * lance; the HUD still goes on top of it.
   */
  function drawCaption(ctx: CanvasRenderingContext2D, t: number, reduced: boolean, state: ArcadeState | null, signUp: boolean, over = false) {
    // Two passes: ordinary captions under the coins, a block's card over them.
    if (caption && !signUp && !(DEV_HOOKS && devRender.hideLabels) && !!caption.coins === over) {
      const age = t - caption.born;
      if (age > caption.life) caption = null;
      else if (age >= 0) {
        // Once, on its first frame: a line too wide for the slot is drawn at the size that fits.
        // A block's card is laid out with its coins and keeps its size.
        if (!caption.fitted) {
          caption.fitted = true;
          if (!caption.coins) {
            ctx.save(); ctx.font = `700 ${caption.size}px ${DISPLAY}`;
            caption.size = fitCaptionSize(caption.size, ctx.measureText(caption.text).width, caption.card);
            ctx.restore();
          }
        }
        const f = age / caption.life;
        const inA = reduced ? 1 : easeOut(age / 0.12);
        // A block's card stays at full strength and goes quickly; other lines fade out.
        const fadeFrom = caption.coins ? 0.9 : 0.78;
        const alpha = f > fadeFrom ? (1 - f) / (1 - fadeFrom) : 1;
        let scale = reduced ? 1 : 0.6 + 0.4 * inA + (caption.card ? 0.08 * Math.exp(-age * 6) : 0);
        const low = !!state && ((state.crates?.length ?? 0) > 0 || t - blockAt < 1.6);
        const slot = low ? CAPTION_LOW : CAPTION;
        let cx = caption.at ? caption.at.x : slot.x, cy = caption.at ? caption.at.y : slot.y + (caption.card ? -10 : 0), tilt = 0;
        // A card with its coins on it lands from a little too big.
        if (caption.coins && !reduced) {
          // Lands from a little too big, and thumps as each coin is swallowed (the last hardest).
          const thump = t - cardPulseAt;
          scale = 0.9 + 0.1 * easeOut(Math.min(1, age / 0.12)) + (thump >= 0 && thump < 0.3 ? (cardEaten >= caption.coins.n ? 0.16 : 0.08) * Math.exp(-thump * 12) : 0);
        }
        // Spat out: from the mouth to the slot on a short arc, growing and straightening as it goes.
        if (caption.from && !reduced && age < SPIT) {
          const k = easeOut(age / SPIT);
          cx = caption.from.x + (slot.x - caption.from.x) * k;
          cy = caption.from.y + (slot.y - caption.from.y) * k - Math.sin(Math.PI * (age / SPIT)) * 60;
          scale = 0.35 + 0.65 * k; tilt = (1 - k) * -0.5;
        }
        if (!caption.card && !caption.at) {
          // Never off the left edge of the frame, however long the line.
          ctx.font = `700 ${caption.size}px ${DISPLAY}`;
          const half = (ctx.measureText(caption.text).width / 2 + 10) * scale;
          if (cx - half < 16) cx = 16 + half;
        }
        ctx.save();
        ctx.translate(cx, cy); ctx.rotate(tilt); ctx.scale(scale, scale);
        let textX = 0;
        const textColor = caption.color;
        if (caption.card) {
          ctx.globalAlpha = alpha;
          ctx.font = `700 ${caption.size}px ${DISPLAY}`;
          const text = ctx.measureText(caption.text).width;
          const coins = caption.coins;
          const step = caption.size * 1.35;
          const icons = coins ? coins.n * step + 12 : 0;
          // A block's card carries its running total at the right end.
          // The block's total is counted in the mouth, not here: the card is its name and a pip per coin.
          const w = text + 44 + icons;
          // Anchored cards keep clear of the mouth: pull left until the right edge fits.
          if (caption.at) {
            const over = Math.min(cx + (w / 2) * scale - caption.at.right, cx - (w / 2) * scale - 12);
            if (over > 0) { ctx.translate(-over / scale, 0); }
            const under = 12 - (cx - (w / 2) * scale);
            if (under > 0) { ctx.translate(under / scale, 0); }
          }
          // A dark plate with a border in its coin's colour, clean from the
          // first frame; the border flares as it lands and as each coin goes down.
          const flare = coins && !reduced ? Math.max(Math.exp(-age * 7), Math.exp(-Math.max(0, t - cardPulseAt) * 9) * 0.7) : 0;
          ctx.fillStyle = '#060e0cf2'; ctx.strokeStyle = caption.color; ctx.lineWidth = 3 + 3 * flare;
          if (flare > 0.05) { ctx.shadowColor = caption.color; ctx.shadowBlur = 18 * flare; }
          ctx.beginPath(); ctx.roundRect(-w / 2, -caption.size * 0.72, w, caption.size * 1.44, 10); ctx.fill(); ctx.stroke();
          ctx.shadowBlur = 0;
          textX = -w / 2 + 22 + text / 2;
          if (coins) {
            // One mini coin per coin inside, lit as each one is swallowed.
            const x0 = textX + text / 2 + 14 + step / 2;
            for (let i = 0; i < coins.n; i++) {
              const pop = 1;
              if (pop <= 0.15) continue;
              const lit = i < cardEaten;
              ctx.save(); ctx.globalAlpha = alpha * (lit ? 1 : 0.6);
              const landed = t - cardPulseAt;
              const thump = !reduced && i === cardEaten - 1 && landed >= 0 && landed < 0.25 ? 0.3 * (1 - landed / 0.25) : 0;
              coin(ctx, coins.ingredient, x0 + i * step, 0, caption.size * (lit ? 1.3 + thump : 1.1) * pop, 0, 0.8, lit ? 1 : 0);
              if (!lit) { ctx.strokeStyle = caption.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x0 + i * step, 0, caption.size * 0.55 * pop + 2, 0, Math.PI * 2); ctx.stroke(); }
              ctx.restore();
            }
          }
        }
        drawText(ctx, caption.text, textX, 0, caption.size, textColor, alpha, DISPLAY, 'center', caption.card ? 0 : 8);
        ctx.restore();
      }
    }

  }

  /** Darkens the painting toward its four edges, so a pulled-back room has no frame line. */
  function featherEdges(ctx: CanvasRenderingContext2D, strength: number) {
    const dark = '5,12,11';
    const band = (x0: number, y0: number, x1: number, y1: number, rx: number, ry: number, rw: number, rh: number) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, `rgba(${dark},${strength})`); g.addColorStop(1, `rgba(${dark},0)`);
      ctx.fillStyle = g; ctx.fillRect(rx, ry, rw, rh);
    };
    ctx.save();
    band(0, 0, 90, 0, 0, 0, 90, 700);
    band(1200, 0, 1110, 0, 1110, 0, 90, 700);
    band(0, 0, 0, 70, 0, 0, 1200, 70);
    band(0, 700, 0, 640, 0, 640, 1200, 60);
    ctx.restore();
  }

  function draw(ctx: CanvasRenderingContext2D, width: number, height: number, state: ArcadeState | null, angle: number, selected: Ingredient, playing: boolean, reduced: boolean, time: number, guideSteps = 0, season: Season = null) {
    const charge = state?.charge ?? 0; const power = ARENA.minPower + (ARENA.maxPower - ARENA.minPower) * charge;
    ctx.setTransform(width / 1200, 0, 0, height / 700, 0, 0); ctx.clearRect(0, 0, 1200, 700);
    pixelScale = width / 1200;
    const delta = lastTime < 0 ? 1 / 60 : Math.min(0.05, Math.max(0.0005, time - lastTime)); lastTime = time;
    const tick = state?.tick ?? 0;
    const shown = playing || (state != null && state.phase !== 'playing');
    const levels = shown ? state?.mutations : null; const creature = shown ? state?.creature : null;
    const frenzy = playing && state ? inFrenzy(state) : false;
    if (playing && state) ingest(state, time, reduced);
    // Hit-stop: the whole picture holds for three frames after a catch. The
    // simulation is held by the page's frame scheduler; this holds the paint.
    const frozen = time < freezeUntil;
    const t = frozen ? frozenAt : time;
    const dt = frozen ? 0 : delta;
    lastWorldTime = t;

    // Rumble: a frenzy, a tantrum, a bite. Never under reduced motion.
    if (!reduced) shake = Math.max(0, shake - dt * 2.2);
    else shake = 0;
    const rumble = frenzy && !reduced ? 0.22 : 0;
    const amp = (shake + rumble) * 9;
    const sx = amp ? Math.sin(t * 61) * amp : 0; const sy = amp ? Math.sin(t * 47 + 1.3) * amp * 0.7 : 0;
    ctx.save();
    ctx.translate(sx, sy);
    // Overscan while shaking, so a kick never shows the canvas edge.
    if (amp) { const k = 1 + (amp * 2.4) / 600; ctx.translate(600, 350); ctx.scale(k, k); ctx.translate(-600, -350); }

    // The camera: the arena-space scene, scaled about the counter's centre
    // once the creature is too big for the frame. Everything in the room is
    // drawn inside this transform; the HUD is drawn after it is restored.
    stepCamera(state, shown, t, reduced);
    const zoom = camera.zoom;
    if (kitchen.complete && kitchen.naturalWidth && !rig && !rigFailed) { try { rig = buildRig(kitchen); } catch { rigFailed = true; } }
    if (zoom < 0.999) {
      // The room beyond the frame is dark. It used to be the same kitchen
      // drawn again at full size under a veil, which put a second, offset copy
      // of every lantern beside the first and a hard seam where they met.
      ctx.fillStyle = '#050c0b'; ctx.fillRect(-40, -40, 1280, 780);
    }
    ctx.save();
    // Not clipped to the arena: a creature that has outgrown the kitchen is
    // drawn over the dark beyond it, which is the point of pulling back.
    ctx.translate(CAMERA.ax, CAMERA.ay); ctx.scale(zoom, zoom); ctx.translate(-CAMERA.ax, -CAMERA.ay);

    if (kitchen.complete && kitchen.naturalWidth) {
      // The kitchen without the creature, then the creature on it. The rail is
      // fixed to the ceiling behind it: a big creature's head hides its right end.
      ctx.drawImage(rig ? rig.backdrop : kitchen, 0, 0, 1200, 700);
      // Pulled back, the painting's edges fall away into the dark instead of
      // ending on a line.
      if (zoom < 0.999) featherEdges(ctx, Math.min(1, (1 - zoom) / 0.08));
      // The flying car crosses the back room (./flyingCar.ts): now and then
      // whenever no shift is on (the title, the epoch report), and once a
      // minute into a shift. Drawn on the painting and under everything
      // else, so the lamps, the rail, the creature and every coin pass in
      // front of it. Without the rig the painting still has the creature in
      // it, so the car would fly over it.
      if (rig && !reduced) {
        const car = playing ? (state && state.phase === 'playing' ? carInShift(tick) : null) : carIdle(time);
        if (car !== null) drawFlyingCar(ctx, car, t);
      }
      if (playing && state) drawRail(ctx, state, tick);
      // The vent flap it bit off hangs in the creature's room too: behind it,
      // so a big creature's head is never covered by a black slab.
      const hazard = playing && state ? getHazard(state.vent, tick) : null;
      if (hazard && kitchen.complete) {
        // The vent flap it bit off, swinging under the ceiling: a bank. Dark
        // louvred tin, lamplight on its edge, a wire where it hangs.
        ctx.save(); const { x, y, width: w, height: h, warning } = hazard;
        ctx.globalAlpha = warning ? 0.55 + 0.3 * (reduced ? 0 : Math.abs(Math.sin(t * 6))) : 1;
        cord(ctx, x + w / 2, y, 1.5);
        softShadow(ctx, x + w / 2 - 6, y + h / 2 + 8, w + 14, h / 2 + 14, 0.4);
        const tin = ctx.createLinearGradient(x, 0, x + w, 0);
        tin.addColorStop(0, '#1c2421'); tin.addColorStop(0.5, '#3e4843'); tin.addColorStop(1, '#232b28');
        ctx.fillStyle = tin; ctx.beginPath(); ctx.roundRect(x, y, w, h, 2); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1;
        for (let i = 1; i < 6; i++) {
          ctx.beginPath(); ctx.moveTo(x + 2, y + i * h / 6); ctx.lineTo(x + w - 2, y + i * h / 6); ctx.stroke();
          ctx.strokeStyle = `${RIM}0.35)`; ctx.beginPath(); ctx.moveTo(x + 2, y + i * h / 6 + 1.5); ctx.lineTo(x + w - 2, y + i * h / 6 + 1.5); ctx.stroke();
          ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        }
        ctx.strokeStyle = warning ? 'rgba(238,166,109,0.9)' : `${RIM}0.8)`; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(x + w - 1, y + 2); ctx.lineTo(x + w - 1, y + h - 2); ctx.stroke();
        ctx.restore();
      }
      if (rig) {
        // A forced development frame is a synthetic state the rules never
        // stepped, so its face is the renderer's to perform.
        const ruled = !(DEV_HOOKS && devRender.pose);
        const pose = animator.step(state, playing, reduced, t, dt, !(DEV_HOOKS && devRender.holdBlink), ruled);
        if (DEV_HOOKS) { frameCells.count = 0; frameCells.skipped = 0; }
        const rigStart = DEV_HOOKS ? performance.now() : 0;
        // During a shift the opening drawn is the rules' opening, exactly.
        const ruledMouth = ruled && playing && state && state.phase === 'playing' ? state.creature.mouth : null;
        drawCreature(ctx, rig, pose, t, reduced, ruledMouth, gulps.length && state ? (c) => drawGulps(c, state, time, reduced) : null);
        if (DEV_HOOKS) devRender.profile.rig += performance.now() - rigStart;
      }
    }
    // The left vignette reaches transparent at x=800.
    const shade = ctx.createLinearGradient(0, 0, 800, 0); shade.addColorStop(0, playing ? '#06121255' : '#061212bb'); shade.addColorStop(1, '#06121200'); ctx.fillStyle = shade; ctx.fillRect(0, 0, 800, 700);
    if (!reduced) { ctx.save(); for (let i = 0; i < 22; i++) { const x = (i * 131.3 + t * (3 + i % 4)) % 1200; const y = 110 + (i * 79.7 - t * (4 + i % 3)) % 510; ctx.fillStyle = i % 3 === 0 ? '#f4c88c35' : '#d6ecd21b'; ctx.beginPath(); ctx.arc(x, y, 1 + i % 2, 0, Math.PI * 2); ctx.fill(); } ctx.restore(); }

    // The kitchen's bouncers, there for the whole shift: they are the playground.
    if (playing) drawProps(ctx, t, reduced, dt);
    // The chain under the ceiling, and whatever block is riding it.
    if (playing && state) {
      for (const c of state.crates ?? []) { drawCrate(ctx, c, tick, t, reduced, selected); lastCrateDrawn = { c, tick }; }
    }

    if (playing && state && guideSteps > 0 && !(DEV_HOOKS && devRender.hideAim)) {
      // The dotted guide is a first-shift aid and then it is gone.
      const key = `${Math.floor(tick / 12)}-${angle}-${selected}-${power}`;
      if (key !== previewKey) { guide = previewFlight(state, selected, angle, power, 96).points; previewKey = key; }
      const dots = guide.slice(0, guideSteps);
      dots.forEach((p, i) => { ctx.fillStyle = `rgba(224,244,190,${.85 - i / Math.max(1, dots.length) * .55})`; ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1.3, 3 - i * .12), 0, Math.PI * 2); ctx.fill(); });
    }
    // No target ring. The mouth itself is the target: the dark opening between
    // the lips is exactly the region the rules swallow a coin in, so nothing
    // is drawn over it or around it.
    if (DEV_HOOKS && devRender.showMouth && state) {
      // Development only: the rules' opening, in cyan, and the jaws, dashed.
      const lens = (m: typeof state.creature.mouth) => {
        ctx.beginPath(); ctx.moveTo(m.lx, m.ly); ctx.quadraticCurveTo(m.cx, m.cu, m.rx, m.ry);
        ctx.quadraticCurveTo(m.cx, m.cd, m.lx, m.ly); ctx.closePath();
      };
      ctx.save(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#00f0ff';
      lens(state.creature.mouth); ctx.stroke();
      if (mouthIsTeeth(state.creature)) {
        // While the jaws are too nearly shut to take a coin: the band a coin's
        // centre clanks in — within a coin's radius of the lips, round the
        // corners too.
        const m = state.creature.mouth; const r = TUNING.mouthFit.coin;
        ctx.save(); ctx.globalAlpha = 0.28; ctx.strokeStyle = '#ff40c0'; ctx.lineWidth = 2 * r;
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        lens(m); ctx.stroke(); ctx.restore();
      }
      ctx.restore();
    }
    if (playing && state) { drawFlame(ctx, state, t, reduced); drawBenchFire(ctx, state, t, reduced); }

    if (levels && creature && playing) {
      ctx.save();
      if (levels.metal > 0) {
        // The pull, drawn as field lines reaching back into the room.
        const range = TUNING.magnetRange + TUNING.magnetRangePerLevel * levels.metal;
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, creature.x - creature.rx * 0.5, 700); ctx.clip();
        ctx.strokeStyle = COLORS.metal; ctx.lineWidth = 2; ctx.setLineDash([9, 13]);
        const ringsN = reduced ? 2 : 4;
        for (let i = 0; i < ringsN; i++) {
          const r = 110 + ((reduced ? 90 : t * 40) + i * range / ringsN) % range;
          ctx.globalAlpha = .14 * levels.metal / 3 * (1 - (r - 110) / range);
          ctx.beginPath(); ctx.ellipse(creature.x, creature.y, r, r * .68, 0, Math.PI * .6, Math.PI * 1.4); ctx.stroke();
        }
        ctx.restore();
      }
      if (levels.balloon > 0) {
        // Rising air under a creature that is off the counter.
        ctx.strokeStyle = '#9cecdf'; ctx.lineWidth = 1.6;
        for (let i = 0; i < 8; i++) {
          const y = creature.y + 180 - ((reduced ? 110 : t * 64) + i * 40) % 250; const x = creature.x - 160 + i * 44;
          ctx.globalAlpha = .08 + creature.lift / 300; ctx.beginPath(); ctx.moveTo(x, y + 20); ctx.quadraticCurveTo(x + 6, y + 10, x, y); ctx.stroke();
        }
      }
      ctx.restore();
    }

    // A broken block's plates, then the caption over them and under the coins.
    drawShards(ctx, t);
    // The caption, under the coins: screen space, so the camera is undone.
    {
      const sign = playing && state && !(DEV_HOOKS && devRender.hideLabels) ? pressEPhase(state.tick) : null;
      const signUp = sign !== null && sign.index !== eHitIndex;
      ctx.save();
      ctx.translate(CAMERA.ax, CAMERA.ay); ctx.scale(1 / zoom, 1 / zoom); ctx.translate(-CAMERA.ax, -CAMERA.ay);
      drawCaption(ctx, t, reduced, state, signUp);
      ctx.restore();
    }
    // Servings and cutlery in the air.
    if (playing && state) {
      drawBrushes(ctx, state, t, reduced);
      noteTrails(state);
      const mouth = { x: state.creature.x, y: state.creature.y };
      if (junkSeen.size > 40) junkSeen.clear();
      for (const p of state.projectiles) {
        if (p.kind === 'junk') drawUtensil(ctx, p, t, reduced, mouth);
        else if (p.kind === 'food') drawFood(ctx, p, t, reduced, tick);
        else if (p.kind === 'pour') drawPour(ctx, p, reduced);
      }
      drawKnocks(ctx, state, t, reduced);
      drawBlockTags(ctx, state, tick, t, reduced);
    }

    if (playing && state?.threat && state.threat.kind === 'lunge') {
      const th = state.threat; const near = clampAlpha((th.tick - tick) / 60);
      ctx.save(); ctx.globalAlpha = .35 + .4 * (reduced ? .6 : Math.abs(Math.sin(t * 9)));
      ctx.strokeStyle = '#ffb27a'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(ARENA.launcher.x, ARENA.launcher.y - 6, 50 + near * 22, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }

    if (playing) {
      const { x, y } = ARENA.launcher; const recoil = state ? Math.max(0, 1 - (tick - state.lastLaunchTick) / 12) * 9 : 0;
      ctx.save(); ctx.translate(x, y); ctx.shadowColor = '#0009'; ctx.shadowBlur = 20; ctx.fillStyle = '#071011'; ctx.beginPath(); ctx.ellipse(0, 42, 74, 15, 0, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
      const base = ctx.createLinearGradient(0, 10, 0, 43); base.addColorStop(0, '#68776b'); base.addColorStop(.35, '#2b3c37'); base.addColorStop(1, '#10211f'); ctx.fillStyle = base; ctx.beginPath(); ctx.roundRect(-50, 12, 100, 35, 8); ctx.fill(); ctx.strokeStyle = '#465448'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#b6c980'; for (let i = 0; i < 4; i++) ctx.fillRect(-35 + i * 18, 34, 9, 3);
      const pivot = ctx.createRadialGradient(-5, 8, 2, 0, 13, 25); pivot.addColorStop(0, '#8b9275'); pivot.addColorStop(.3, '#4e6353'); pivot.addColorStop(1, '#0c211e'); ctx.fillStyle = pivot; ctx.beginPath(); ctx.arc(0, 13, 24, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#b5aa76'; ctx.beginPath(); ctx.arc(0, 13, 5, 0, Math.PI * 2); ctx.fill();
      ctx.rotate(angle * Math.PI / 180); ctx.translate(-recoil, 0);
      if (cannon.complete && cannon.naturalWidth) { ctx.drawImage(masked(cannon) ?? cannon, 90, 360, 1100, 480, -64, -40, 140, 70); }
      // The charge, drawn along the barrel.
      if (charge > 0.01) {
        const len = 54 + charge * 86;
        ctx.save(); ctx.globalCompositeOperation = 'screen';
        ctx.strokeStyle = charge > 0.92 ? '#fff0a8' : '#dded92'; ctx.lineWidth = 5; ctx.lineCap = 'round';
        ctx.globalAlpha = .35 + charge * .5; ctx.beginPath(); ctx.moveTo(64, 0); ctx.lineTo(64 + len, 0); ctx.stroke();
        ctx.lineWidth = 2; ctx.globalAlpha = .9; ctx.beginPath(); ctx.arc(64 + len, 0, 5 + charge * 4, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
      // The aim: a solid lance out of the muzzle with a crossbar at the power.
      const rad = angle * Math.PI / 180;
      const cooldown = state ? (frenzy ? ARENA.frenzyCooldownTicks : ARENA.cooldownTicks) : ARENA.cooldownTicks;
      const waitEnd = state ? Math.max(state.reloadUntil, state.lastLaunchTick + cooldown) : 0;
      const loaded = !state || tick >= waitEnd;
      const refill = state ? clampAlpha(1 - (waitEnd - tick) / cooldown) : 1;
      // The lance bends the way the loaded coin will: it is the first stretch
      // of that coin's own flight at this charge — Bitcoin droops, Ether
      // floats, HEMI is a straight line — so each coin's character is on the
      // barrel before it is fired. It stops a long way short of anything it
      // could hit; where the coin lands is still the player's read.
      const lance = lancePath(selected, rad, Math.round(power), x, y);
      // Long enough for the bend to show — a Bitcoin's droop, an Ether's float,
      // a HEMI's ruler — and in the loaded coin's colour; the crossbar is the charge.
      const solid = 120 + clampAlpha((power - ARENA.minPower) / (ARENA.maxPower - ARENA.minPower)) * 150;
      const lanceTint = COLORS[selected];
      // While a shot is in the air and nothing is charging, the lance steps
      // back, so it never argues with the coin that is flying.
      const flying = !!state && charge === 0 && state.projectiles.some(q => q.kind === 'food' && !q.spent);
      const lit = flying ? 0.45 : 1;
      ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      // Ether's float only shows over a longer run, so its dashed tail is longer.
      const tail = selected === 'balloon' ? 210 : 110;
      ctx.globalAlpha = (loaded ? .7 : .3) * lit; ctx.strokeStyle = '#040a09'; ctx.lineWidth = 13;
      strokeAlong(ctx, lance, 4, solid);
      ctx.globalAlpha = (loaded ? 1 : .5) * lit; ctx.strokeStyle = lanceTint; ctx.lineWidth = 7;
      strokeAlong(ctx, lance, 4, solid);
      // The tail past the charge mark is drawn in the coin's own hand: Ether's
      // as a string of bubbles, HEMI's as long ruler dashes with ticks on its
      // shaft, Bitcoin's as heavy short dashes — so the three read apart even
      // where their lines run close.
      if (selected === 'balloon') {
        for (let d = solid + 12; d <= solid + tail; d += 17) {
          const q = pointAlong(lance, d); const r = 4.2 + 1.4 * ((d - solid) / tail);
          ctx.globalAlpha = (loaded ? .55 : .15) * lit; ctx.strokeStyle = '#040a09'; ctx.lineWidth = 4.5;
          ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = (loaded ? .9 : .2) * lit; ctx.strokeStyle = lanceTint; ctx.lineWidth = 2.2;
          ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.stroke();
        }
      } else {
        const dash = selected === 'pepper' ? [16, 6] : [7, 7];
        ctx.globalAlpha = (loaded ? .5 : .15) * lit; ctx.strokeStyle = '#040a09'; ctx.lineWidth = selected === 'metal' ? 10 : 8; ctx.setLineDash(dash);
        strokeAlong(ctx, lance, solid, solid + tail);
        ctx.globalAlpha = (loaded ? .85 : .2) * lit; ctx.strokeStyle = lanceTint; ctx.lineWidth = selected === 'metal' ? 6 : 4.5;
        strokeAlong(ctx, lance, solid, solid + tail); ctx.setLineDash([]);
      }
      if (selected === 'pepper') {
        // Ruler ticks along HEMI's shaft: it goes where it points.
        ctx.globalAlpha = (loaded ? .9 : .3) * lit; ctx.strokeStyle = '#040a09'; ctx.lineWidth = 2;
        for (let d = 40; d < solid - 8; d += 26) {
          const q = pointAlong(lance, d);
          ctx.beginPath(); ctx.moveTo(q.x - q.ny * 6, q.y + q.nx * 6); ctx.lineTo(q.x + q.ny * 6, q.y - q.nx * 6); ctx.stroke();
        }
      }
      const bar = pointAlong(lance, solid);
      ctx.globalAlpha = loaded ? 1 : .45; ctx.lineWidth = 4;
      ctx.strokeStyle = charge > 0.92 ? '#fff0a8' : loaded ? '#dded92' : '#7f8f6e';
      ctx.beginPath(); ctx.moveTo(bar.x - bar.ny * 11, bar.y + bar.nx * 11); ctx.lineTo(bar.x + bar.ny * 11, bar.y - bar.nx * 11); ctx.stroke();
      ctx.restore();
      // The loaded serving sits in the breech whether or not it can be fired.
      const jammed = state ? tick < state.reloadUntil : false;
      ctx.save(); ctx.translate(x, y); ctx.lineCap = 'round';
      if (!loaded) {
        ctx.fillStyle = '#06100dcc'; ctx.beginPath(); ctx.arc(0, 0, 30, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = jammed ? '#6a3a30' : '#33422f'; ctx.lineWidth = 4.5;
        ctx.beginPath(); ctx.arc(0, 0, 34, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = jammed ? '#ff8a6a' : '#dded92'; ctx.globalAlpha = .9;
        ctx.beginPath(); ctx.arc(0, 0, 34, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * refill); ctx.stroke();
      } else if (state && !reduced && tick - waitEnd < 15) {
        const pop = clampAlpha(1 - (tick - waitEnd) / 15);
        ctx.globalAlpha = pop * .85; ctx.strokeStyle = '#dded92'; ctx.lineWidth = 3.5;
        ctx.beginPath(); ctx.arc(0, 0, 34 + (1 - pop) * 18, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
      ctx.save(); ctx.globalAlpha = loaded ? 1 : .7;
      coin(ctx, selected, x, y, loaded ? 44 : 38, rad, reduced ? 0.8 : t * 2.2, loaded ? 0.8 : 0.3);
      ctx.restore();
      if (jammed && state) {
        // What jammed it: a fork through the works, or smoke off a singe.
        const jam = [...state.events].reverse().find(e => e.type === 'jam');
        ctx.save();
        if (jam?.name === 'utensil') {
          ctx.translate(x + 18, y - 26); ctx.rotate(-0.9);
          if (jamWallet) drawWallet(ctx, 0.5);
          else {
            ctx.fillStyle = '#d7e1dc'; ctx.strokeStyle = '#303b38'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.roundRect(-24, -2.5, 32, 5, 2.5); ctx.fill(); ctx.stroke();
            for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.roundRect(8, k * 4.5 - 1.5, 16, 3, 1.5); ctx.fill(); ctx.stroke(); }
          }
          ctx.rotate(0.9); ctx.translate(-(x + 18), -(y - 26));
        }
        for (let i = 0; i < (reduced ? 2 : 5); i++) {
          const f = ((reduced ? 0.5 : t * 0.9) + i * 0.2) % 1;
          ctx.globalAlpha = 0.35 * (1 - f);
          ctx.fillStyle = jam?.name === 'singe' ? '#2a2420' : '#3a3f3a';
          ctx.beginPath(); ctx.arc(x + 10 + Math.sin(t * 2 + i) * 8, y - 30 - f * 70, 8 + f * 18, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      }
    }
    if (playing && state && state.tick < state.hatchClosedUntil) {
      // The hatch, down over the serving window.
      ctx.save(); const hx = ARENA.launcher.x; const tt = Math.min(1, (state.hatchClosedUntil - state.tick) / 10);
      const h = Math.max(0, 116 * tt); const top = HATCH_TOP - h;
      ctx.fillStyle = '#0b1414'; ctx.strokeStyle = '#9db08a'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.roundRect(hx - 104, top, 208, h, 5); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#1d2a24'; for (let i = 0; i < 6; i++) ctx.fillRect(hx - 94 + i * 33, top + 8, 24, Math.max(0, h - 16));
      if (h > 34) { ctx.fillStyle = '#dded92'; ctx.font = `700 16px 'Helvetica Neue',sans-serif`; ctx.textAlign = 'center'; ctx.fillText('HATCH SHUT', hx, top + h / 2 + 5); }
      ctx.restore();
    }
    // A missed snack stays on the floor for a moment.
    if (playing && state) {
      for (const e of state.events) {
        if (e.type !== 'miss' || tick - e.tick >= 65) continue; const age = tick - e.tick; const rest = Math.min(ARENA.floor - 4, e.y + age * 1.6);
        if (rest < ARENA.floor - 30) continue;
        ctx.save(); ctx.globalAlpha = Math.max(0, Math.min(1, (70 - age) / 26));
        ctx.fillStyle = '#040908a0'; ctx.beginPath(); ctx.ellipse(e.x, rest + 12, 30, 7, 0, 0, Math.PI * 2); ctx.fill();
        // On the floor, face up and a little tilted. The mark is never squashed.
        coin(ctx, e.ingredient ?? selected, e.x, rest, 40, MARK_TILT_FLOOR, undefined, 0); ctx.restore();
      }
    }

    // ---- juice. All of it belongs to the shift; the report screen gets none.
    if (!playing) { particles.length = 0; pops.length = 0; rings.length = 0; gulps.length = 0; brushes.length = 0; caption = null; }
    // Particles.
    if (particles.length) {
      ctx.save();
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]; const age = t - p.born;
        if (age < 0 || age > p.life) { particles.splice(i, 1); continue; }
        const f = age / p.life;
        const x = p.x + p.vx * age; const y = p.y + p.vy * age + p.gravity * age * age * 0.5;
        ctx.globalAlpha = (1 - f) * (p.kind === 'dust' ? 0.5 : 0.95);
        ctx.fillStyle = p.color;
        if (p.kind === 'spark') {
          ctx.strokeStyle = p.color; ctx.lineWidth = Math.max(1, p.size * 0.6 * (1 - f)); ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - p.vx * 0.05, y - (p.vy + p.gravity * age) * 0.05); ctx.stroke();
        } else if (p.kind === 'shard') {
          // Drawn in their own pass, under the caption (drawShards).
        } else {
          const r = p.kind === 'dust' ? p.size * (1 + f * 3) : p.kind === 'ember' ? p.size * (1 - f * 0.5) : p.size * (1 - f * 0.6);
          ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.restore();
    }
    // A block breaking: a white-hot burst where it was, held a beat, then
    // fading through its coin's colour. Local, never a wash over the room.
    if (playing) {
      const age = t - flashAt;
      if (age >= 0 && age < 0.26) {
        const fade = age < 0.06 ? 1 : 1 - (age - 0.06) / 0.2;
        const k = reduced ? 0.6 : 1;
        const r = 240 + (reduced ? 0 : 80 * easeOut(age / 0.26));
        // The cube itself, for the first few frames: swollen, split by
        // white-hot cracks, inside the burst — so the hit frame is the block
        // blowing apart, not a light where it used to be.
        const cracking = age < 0.08;
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        // Three or four frames of the whole room lit in its coin's colour —
        // added light, so nothing is veiled, and the HUD is drawn after it.
        if (age < 0.12 && !reduced) {
          // The room drops to about two thirds for a few frames, so a white-hot
          // burst beats the lamps whatever the coin's colour (a gold wash over
          // a gold kitchen only made the kitchen more gold).
          ctx.globalCompositeOperation = 'source-over';
          ctx.fillStyle = `rgba(2,5,5,${0.36 * (1 - age / 0.12)})`; ctx.fillRect(-200, -200, 1600, 1100);
          const halo = ctx.createRadialGradient(flashX, flashY, r * 0.4, flashX, flashY, r * 1.5);
          halo.addColorStop(0, `rgba(2,5,5,${0.45 * (1 - age / 0.12)})`); halo.addColorStop(1, 'rgba(2,5,5,0)');
          ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(flashX, flashY, r * 1.5, 0, Math.PI * 2); ctx.fill();
          ctx.globalCompositeOperation = 'lighter';
        }
        // Eight thick wedges of light thrown out of the core, in its coin's
        // colour with a hot centre line, stopping short of the creature.
        if (!reduced) {
          ctx.save();
          ctx.beginPath(); ctx.rect(-200, -200, 840, 1100); ctx.clip();
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2 + hashed(flashSeed + i) * 0.35;
            const r1 = 70 + 60 * hashed(flashSeed * 3 + i) + 40 * easeOut(age / 0.26);
            const half = 0.16 * (0.5 + 0.5 * fade);
            ctx.fillStyle = withAlpha(flashColor, 0.75 * fade);
            ctx.beginPath(); ctx.moveTo(flashX + Math.cos(a - half) * 14, flashY + Math.sin(a - half) * 14);
            ctx.lineTo(flashX + Math.cos(a) * r1, flashY + Math.sin(a) * r1);
            ctx.lineTo(flashX + Math.cos(a + half) * 14, flashY + Math.sin(a + half) * 14); ctx.closePath(); ctx.fill();
            ctx.strokeStyle = `rgba(255,252,236,${0.85 * fade})`; ctx.lineWidth = 4;
            ctx.beginPath(); ctx.moveTo(flashX + Math.cos(a) * 16, flashY + Math.sin(a) * 16); ctx.lineTo(flashX + Math.cos(a) * r1 * 0.8, flashY + Math.sin(a) * r1 * 0.8); ctx.stroke();
          }
          ctx.restore();
        }
        const g = ctx.createRadialGradient(flashX, flashY, 0, flashX, flashY, r);
        // A filled bloom: a white core inside a broad body of the coin's colour.
        // A white-hot core about 160 across, its coin's colour only as the band around it.
        const hot = age < 0.04 ? 1 : fade;
        g.addColorStop(0, `rgba(255,255,250,${hot * k})`);
        g.addColorStop(0.3, `rgba(255,250,232,${0.92 * hot * k})`);
        g.addColorStop(0.42, withAlpha(flashColor, 0.8 * fade * k));
        g.addColorStop(0.7, withAlpha(flashColor, 0.5 * fade * k));
        g.addColorStop(1, withAlpha(flashColor, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(flashX, flashY, r, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        // The cube itself, for the first few frames: opaque, punched up to
        // 1.3×, split by white-hot cracks in the middle of the burst.
        if (cracking) {
          if (brokenCrate) {
            const punch = 1.12 + 0.1 * (age / 0.08);
            ctx.save(); ctx.translate(crackX, crackY); ctx.scale(punch, punch); ctx.translate(-crackX, -crackY);
            drawCrate(ctx, brokenCrate.c, brokenCrate.tick, t, reduced, brokenCrate.c.ingredient);
            ctx.restore();
          } else drawCrackedCube(ctx, crackX, crackY, flashColor, age, flashSeed, false);
          drawCrackedCube(ctx, crackX, crackY, flashColor, age, flashSeed, true);
        }
      }
    }
    // Bounce rings: a flash at the contact point.
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i]; const age = t - r.born; const life = r.huge ? 0.5 : r.big ? 0.45 : 0.3;
      if (age > life) { rings.splice(i, 1); continue; }
      if (age < 0) continue;
      const f = easeOut(age / life);
      ctx.save(); ctx.globalAlpha = 1 - f;
      ctx.strokeStyle = r.color; ctx.lineWidth = (r.big ? 6 : 4) * (1 - f) + 1;
      if (r.huge) ctx.lineWidth = 14 * (1 - f) + 2;
      ctx.beginPath(); ctx.arc(r.x, r.y, (reduced ? 24 : r.huge ? 24 + f * 220 : 10 + f * (r.big ? 48 : 30)), 0, Math.PI * 2); ctx.stroke();
      if (r.big && !r.huge) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2 * (1 - f); ctx.beginPath(); ctx.arc(r.x, r.y, reduced ? 14 : 4 + f * 26, 0, Math.PI * 2); ctx.stroke(); }
      ctx.restore();
    }
    // Score pops, scaled by value.
    if (!(DEV_HOOKS && devRender.hideLabels)) {
      for (let i = pops.length - 1; i >= 0; i--) {
        const p = pops[i]; const age = t - p.born; const life = p.life ?? 0.9;
        if (age > life) { pops.splice(i, 1); continue; }
        const total = p.tag === 'pour';
        const f = age / life; const rise = reduced || total ? 0 : easeOut(f) * 46;
        const grow = reduced ? 1 : total ? 1 + 0.3 * (1 - easeOut(Math.min(1, age / 0.6))) + 0.25 * Math.exp(-age * 14) : 1 + (p.tag === 'feed' ? 0.2 : 0.5) * Math.exp(-age * 9);
        drawText(ctx, p.text, clamp(p.x, 60, 1140), Math.max(70, p.y) - rise, p.size * grow, p.color, (f < 0.7 ? 1 : (1 - f) / 0.3) * (total ? 0.9 : 1), MONO, 'center', 5);
      }
    }

    ctx.restore(); // camera: from here on, screen space.
    // A block's card, over the coins and the burst, so it is never dimmed or crossed.
    {
      const sign = playing && state && !(DEV_HOOKS && devRender.hideLabels) ? pressEPhase(state.tick) : null;
      drawCaption(ctx, t, reduced, state, sign !== null && sign.index !== eHitIndex, true);
    }
    if (zoom < 0.999) {
      // A soft edge where the frame ends and the dark room begins.
      const x0 = toScreenX(0), y0 = toScreenY(0), x1 = toScreenX(1200), y1 = toScreenY(700);
      const edge = 26;
      const fade = (gx0: number, gy0: number, gx1: number, gy1: number, x: number, y: number, w: number, h: number) => {
        const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
        g.addColorStop(0, 'rgba(3,9,8,0.6)'); g.addColorStop(1, 'rgba(3,9,8,0)');
        ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
      };
      ctx.save();
      fade(0, y1, 0, y1 - edge, x0, y1 - edge, x1 - x0, edge);
      fade(x0, 0, x0 + edge, 0, x0, y0, edge, y1 - y0);
      fade(x1, 0, x1 - edge, 0, x1 - edge, y0, edge, y1 - y0);
      ctx.restore();
    }

    // The craving ring: what it wants, drawn by the creature, with the time
    // left as a shrinking arc. Bigger than before. Screen space, placed from
    // where the mouth is on screen.
    if (playing && state && state.craving) {
      const c = state.creature; const cr = state.craving;
      const span = Math.max(1, cr.endsAt - cr.startedAt);
      const left = Math.max(0, Math.min(1, (cr.endsAt - tick) / span));
      // Kept clear of the UPTIME readout in the top-right corner, whatever the camera does.
      const bx = Math.min(1120, toScreenX(c.x + c.rx * (c.gape ?? 1) * 0.92) + 66); const by = Math.max(bx > 1000 ? 140 : 118, toScreenY(c.y - c.ry) - 76);
      const urgent = left < 0.3;
      ctx.save();
      ctx.globalAlpha = urgent && !reduced ? .82 + .18 * Math.sin(t * 11) : .94;
      ctx.fillStyle = '#08100fe8'; ctx.strokeStyle = urgent ? '#eea66d' : '#b9cf8e'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(bx, by, 54, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#1f2a22'; ctx.lineWidth = 8; ctx.beginPath(); ctx.arc(bx, by, 44, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = urgent ? '#eea66d' : '#dded92'; ctx.lineWidth = 8; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(bx, by, 44, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left); ctx.stroke();
      ctx.restore();
      coin(ctx, cr.ingredient, bx, by, 60, 0, reduced ? 0.8 : t * 1.6, 0.6);
      drawText(ctx, 'IT WANTS', bx, by - 66, 15, urgent ? '#ffc698' : '#dfe9cb', 1, MONO, 'center', 4);
    }

    // ONE slim belly bar directly under the creature. No numbers.
    if (playing && state) {
      const c = state.creature;
      const fullness = clampAlpha(state.hunger / 100);
      const x = clamp(toScreenX(c.x), 420 + BELLY.w / 2, 1180 - BELLY.w / 2) - BELLY.w / 2; const y = toScreenY(BELLY.y);
      const low = fullness < 0.25;
      const blink = low ? (reduced ? 1 : 0.55 + 0.45 * Math.abs(Math.sin(t * Math.PI * 2.5))) : 1;
      ctx.save();
      ctx.fillStyle = '#05090999'; ctx.beginPath(); ctx.roundRect(x - 6, y - 6, BELLY.w + 12, BELLY.h + 12, 10); ctx.fill();
      ctx.fillStyle = '#101a16'; ctx.beginPath(); ctx.roundRect(x, y, BELLY.w, BELLY.h, 7); ctx.fill();
      const fill = low ? `rgba(255,96,70,${blink})` : fullness < 0.45 ? '#eea66d' : '#cdec7a';
      ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(x, y, Math.max(8, BELLY.w * fullness), BELLY.h, 7); ctx.fill();
      ctx.strokeStyle = low ? `rgba(255,120,90,${blink})` : '#5d6b5566'; ctx.lineWidth = low ? 2.5 : 1;
      ctx.beginPath(); ctx.roundRect(x, y, BELLY.w, BELLY.h, 7); ctx.stroke();
      const lit = 1 - (t - bellyLitAt) / 0.8;
      if (lit > 0 && lit <= 1) { ctx.strokeStyle = `rgba(241,255,200,${lit})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.roundRect(x - 3, y - 3, BELLY.w + 6, BELLY.h + 6, 9); ctx.stroke(); }
      ctx.restore();
    }

    // The combo by the launcher, growing with the combo, and the FRENZY banner
    // it turns into.
    if (playing && state && !(DEV_HOOKS && devRender.hideLabels)) {
      if (frenzy) {
        const left = clampAlpha((state.frenzyUntil - tick) / TUNING.frenzyTicks);
        const beat = reduced ? 1 : 1 + 0.06 * Math.sin(t * Math.PI * 2 * 2.6);
        ctx.save();
        ctx.translate(FOMO_X, 118); ctx.scale(beat, beat);
        ctx.font = `700 92px ${DISPLAY}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(60,14,4,0.95)'; ctx.lineWidth = 12; ctx.strokeText(CAPTIONS.frenzy, 0, 0);
        const hot = ctx.createLinearGradient(0, -40, 0, 40); hot.addColorStop(0, '#fff2b0'); hot.addColorStop(0.5, '#ffb347'); hot.addColorStop(1, '#ff6a2a');
        ctx.fillStyle = hot; ctx.fillText(CAPTIONS.frenzy, 0, 0);
        ctx.restore();
        ctx.save();
        ctx.fillStyle = '#2a1408'; ctx.beginPath(); ctx.roundRect(FOMO_X - 135, 168, 270, 8, 4); ctx.fill();
        ctx.fillStyle = '#ffb347'; ctx.beginPath(); ctx.roundRect(FOMO_X - 135, 168, Math.max(6, 270 * left), 8, 4); ctx.fill();
        ctx.restore();
      } else if (state.combo > 0) {
        const n = state.combo;
        const last = [...state.events].reverse().find(e => e.type === 'feed');
        const since = last ? (tick - last.tick) / 60 : 9;
        const bump = reduced ? 1 : 1 + 0.35 * Math.exp(-since * 7);
        const size = clamp(30 + n * 9, 30, 72) * bump;
        const heat = clampAlpha((n - 1) / (TUNING.frenzyAt - 1));
        const color = n >= TUNING.frenzyAt - 1 ? '#ffd36a' : heat > 0.5 ? '#f1ffa8' : '#d8f896';
        // Screen space, under the score: the lance never runs through it.
        drawText(ctx, `×${n}`, COMBO.x, COMBO.y + size * 0.5, size, color, 1, DISPLAY, 'left', 7);
        drawText(ctx, CAPTIONS.combo, COMBO.x + 2, COMBO.y - 6, 13, '#b9c6ae', 1, MONO, 'left', 4);
      }
    }

    // The PRESS E sign, spat out of the mouth into the caption slot. While it
    // is up it is the caption: the ordinary one waits underneath.
    const sign = playing && state && !(DEV_HOOKS && devRender.hideLabels) ? pressEPhase(state.tick) : null;
    const signUp = sign !== null && sign.index !== eHitIndex;
    if (state) lastMouth = { x: state.creature.x, y: state.creature.y };
    if (signUp && sign && state) drawPressE(ctx, sign, toScreenX(state.creature.x), toScreenY(state.creature.y), t, reduced, (state.crates?.length ?? 0) > 0);

    ctx.restore(); // shake

    // ---- full-frame overlays, outside the shake.
    // Halloween, on the title only: now and then the lamps dip. Darker, never
    // brighter, two dips a burst, and not at all under reduced motion.
    if (!shown && season === 'halloween' && !reduced) {
      const f = flickerAt(time);
      if (f > 0) { ctx.save(); ctx.fillStyle = `rgba(3,5,7,${(FLICKER_DARKEST * f).toFixed(3)})`; ctx.fillRect(0, 0, 1200, 700); ctx.restore(); }
    }
    // Growth pulse: a ring from the creature to the edges, and a flash.
    if (playing && state) {
      const age = t - pulseAt;
      if (age >= 0 && age < 0.7) {
        const f = easeOut(age / 0.7);
        ctx.save();
        ctx.globalAlpha = (1 - f) * 0.9;
        ctx.strokeStyle = '#f1ffc8'; ctx.lineWidth = 14 * (1 - f) + 2;
        const c = state.creature;
        ctx.beginPath(); ctx.ellipse(toScreenX(c.x), toScreenY(c.y + 60), reduced ? 420 : 120 + f * 900, reduced ? 300 : 80 + f * 640, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = (1 - f) * 0.14;
        ctx.fillStyle = '#f1ffc8'; ctx.fillRect(0, 0, 1200, 700);
        ctx.restore();
      }
      // Irritation: a red vignette above 70. Frenzy: a warm one.
      const rage = clampAlpha((state.rage - 70) / 30);
      if (rage > 0 || frenzy) {
        ctx.save();
        const v = ctx.createRadialGradient(600, 350, 320, 600, 350, 760);
        if (frenzy) { v.addColorStop(0, 'rgba(255,150,50,0)'); v.addColorStop(1, 'rgba(255,120,30,0.42)'); }
        else { v.addColorStop(0, 'rgba(200,20,20,0)'); v.addColorStop(1, `rgba(190,10,16,${0.2 + 0.4 * rage})`); }
        ctx.fillStyle = v; ctx.fillRect(0, 0, 1200, 700);
        ctx.restore();
      }
    }
  }
  /**
   * The flying car at progress `p` across the back room: a small rounded
   * sedan with tail fins, seen side on and facing right, lamplight along its
   * roof, a headlight, a tail light and two short jets under the wheels. No
   * mark, no plate, no lettering. Clipped to the back room so it comes out
   * from behind the left lamp and goes behind the right one.
   */
  function drawFlyingCar(ctx: CanvasRenderingContext2D, p: number, time: number) {
    const { x, y, tilt } = carPose(p);
    ctx.save();
    ctx.beginPath(); ctx.rect(BACK_ROOM.left, BACK_ROOM.top, BACK_ROOM.right - BACK_ROOM.left, BACK_ROOM.bottom - BACK_ROOM.top); ctx.clip();
    // The haze around it catches its lights, so it reads at stream size.
    const halo = ctx.createRadialGradient(x, y, 6, x, y, 52);
    halo.addColorStop(0, 'rgba(255,214,160,0.14)'); halo.addColorStop(1, 'rgba(255,214,160,0)');
    ctx.fillStyle = halo; ctx.fillRect(x - 56, y - 56, 112, 112);
    ctx.translate(x, y); ctx.rotate(tilt);
    // The headlight's beam into the haze ahead of it.
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const beam = ctx.createLinearGradient(30, 0, 78, 0);
    beam.addColorStop(0, 'rgba(255,236,190,0.32)'); beam.addColorStop(1, 'rgba(255,236,190,0)');
    ctx.fillStyle = beam; ctx.beginPath(); ctx.moveTo(29, -1); ctx.lineTo(78, -9); ctx.lineTo(78, 11); ctx.lineTo(29, 2); ctx.closePath(); ctx.fill();
    // Two jets under the wheels: hot at the top, gone by the bottom, never still.
    for (const jx of [-17, 17]) {
      const len = 9 + 3 * Math.sin(time * 41 + jx) + 2 * Math.sin(time * 67 + jx * 0.3);
      const jet = ctx.createLinearGradient(0, 10, 0, 10 + len);
      jet.addColorStop(0, 'rgba(255,244,214,0.95)'); jet.addColorStop(0.35, 'rgba(255,170,90,0.7)'); jet.addColorStop(1, 'rgba(255,120,60,0)');
      ctx.fillStyle = jet; ctx.beginPath(); ctx.moveTo(jx - 4, 10); ctx.lineTo(jx + 4, 10); ctx.lineTo(jx, 10 + len); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    // The body: a low hull, a rounded nose, a domed cabin and a tail fin.
    const hull = () => {
      ctx.beginPath();
      ctx.moveTo(-29, 7); ctx.lineTo(25, 7);
      ctx.quadraticCurveTo(32, 6, 31, 1); ctx.quadraticCurveTo(30, -3, 24, -4);
      ctx.lineTo(12, -5); ctx.quadraticCurveTo(8, -13, 0, -13); ctx.lineTo(-9, -13);
      ctx.quadraticCurveTo(-15, -12, -18, -5); ctx.lineTo(-25, -5);
      ctx.lineTo(-32, -11); ctx.lineTo(-31, -2); ctx.quadraticCurveTo(-32, 5, -29, 7); ctx.closePath();
    };
    const paint = ctx.createLinearGradient(0, -13, 0, 8);
    paint.addColorStop(0, '#a9cbbd'); paint.addColorStop(0.45, '#62917f'); paint.addColorStop(1, '#1f332d');
    hull(); ctx.fillStyle = paint; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1.2; ctx.stroke();
    // The windows: dark glass with the lamps in it, split by the pillar.
    ctx.fillStyle = '#18211f';
    ctx.beginPath(); ctx.moveTo(10, -5.5); ctx.quadraticCurveTo(7, -11, 1, -11.5); ctx.lineTo(-2, -11.5); ctx.lineTo(-2, -5.5); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-4.5, -5.5); ctx.lineTo(-4.5, -11.5); ctx.lineTo(-9, -11.5); ctx.quadraticCurveTo(-13.5, -10.5, -15.5, -5.5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,196,128,0.5)'; ctx.fillRect(2, -10.5, 4, 1.4); ctx.fillRect(-11, -10.5, 3, 1.2);
    // A chrome line down the side, and the lamps' warm rim along the roof.
    ctx.strokeStyle = 'rgba(236,244,232,0.6)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-26, 0.5); ctx.lineTo(28, 0.5); ctx.stroke();
    ctx.strokeStyle = `${RIM}0.85)`; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(24, -4.2); ctx.lineTo(12, -5.2); ctx.quadraticCurveTo(8, -13.2, 0, -13.2); ctx.lineTo(-9, -13.2); ctx.stroke();
    // Wheels, still on: it is a car.
    for (const wx of [-17, 17]) {
      ctx.fillStyle = '#0d100f'; ctx.beginPath(); ctx.arc(wx, 7, 4.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#8a8172'; ctx.beginPath(); ctx.arc(wx, 7, 1.8, 0, Math.PI * 2); ctx.fill();
    }
    // The headlight and the tail light.
    ctx.fillStyle = '#fff3cf'; ctx.beginPath(); ctx.arc(29.5, 0, 2.1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ff5a3c'; ctx.beginPath(); ctx.arc(-30, 1, 1.7, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  /**
   * The sign: a card that reads PRESS with a keyboard key that reads E. It
   * flies out of the mouth on an arc, spinning straight as it lands, then
   * hangs with a bar for how long is left and the key tapping itself.
   */
  function drawPressE(ctx: CanvasRenderingContext2D, ph: PressEPhase, mouthX: number, mouthY: number, time: number, reduced: boolean, low = false) {
    // While a block is out the sign drops to the low slot, under the block's stretch of room.
    const slot = low ? CAPTION_LOW : CAPTION;
    let x = slot.x, y = slot.y, s = 1, rot = 0, alpha = 1;
    if (ph.phase === 'flying') {
      if (reduced) alpha = ph.t;
      else {
        const e = easeOut(ph.t);
        x = mouthX + (slot.x - mouthX) * e;
        y = mouthY + (slot.y - mouthY) * e - Math.sin(Math.PI * ph.t) * 90;
        s = 0.25 + 0.75 * e + 0.12 * Math.sin(Math.PI * ph.t);
        rot = (1 - e) * -0.9;
      }
    } else {
      if (!reduced) s = 1 + 0.035 * Math.sin(time * 9);
      if (ph.t > 0.86) alpha = (1 - ph.t) / 0.14;
    }
    const word = 'PRESS', key = 64, gap = 16, padX = 26, h = 86;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s); ctx.globalAlpha = clampAlpha(alpha);
    ctx.font = `700 54px ${DISPLAY}`;
    const ww = ctx.measureText(word).width;
    const w = padX + ww + gap + key + padX;
    ctx.fillStyle = '#060e0cf2'; ctx.strokeStyle = '#dded92'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2, w, h, 14); ctx.fill(); ctx.stroke();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillStyle = '#f1ffc8';
    ctx.fillText(word, -w / 2 + padX, 3);
    // The key: a base, and a face that taps down twice a second while the sign is open.
    const down = ph.phase === 'open' && !reduced && Math.floor(time * 2.5) % 2 === 0 ? 4 : 0;
    const kx = -w / 2 + padX + ww + gap, ky = -key / 2 + 2;
    ctx.fillStyle = '#7f8a72'; ctx.beginPath(); ctx.roundRect(kx, ky + 6, key, key - 4, 10); ctx.fill();
    const face = ctx.createLinearGradient(0, ky + down, 0, ky + down + key - 8);
    face.addColorStop(0, '#ffffff'); face.addColorStop(1, '#cdd5c1');
    ctx.fillStyle = face; ctx.beginPath(); ctx.roundRect(kx, ky + down, key, key - 8, 10); ctx.fill();
    ctx.fillStyle = '#16211c'; ctx.textAlign = 'center'; ctx.font = `700 40px ${DISPLAY}`;
    ctx.fillText('E', kx + key / 2, ky + down + (key - 8) / 2 + 2);
    if (ph.phase === 'open') {
      const bw = w - padX * 2;
      ctx.fillStyle = '#22301f'; ctx.beginPath(); ctx.roundRect(-bw / 2, h / 2 + 10, bw, 7, 4); ctx.fill();
      ctx.fillStyle = '#dded92'; ctx.beginPath(); ctx.roundRect(-bw / 2, h / 2 + 10, Math.max(6, bw * (1 - ph.t)), 7, 4); ctx.fill();
    }
    ctx.restore();
  }

  /**
   * A hit on the PRESS E sign: the sign goes, IT WORKED. comes up as a card,
   * and the mouth throws out a burst in all three coins' colours. The page
   * plays the ding ding ding. Nothing here is scored.
   */
  function pressE(time: number, index: number, reduced: boolean) {
    eHitIndex = index;
    say(PRESS_E_HIT, '#f1ffc8', 9, time, 64, 1.6, true);
    const m = lastMouth;
    burst(m.x, m.y, reduced ? 8 : 22, COLORS.metal, 320, time, 'dot', 9001 + index, 1.1);
    burst(m.x, m.y, reduced ? 8 : 22, COLORS.balloon, 300, time, 'dot', 9101 + index, 1.1);
    burst(m.x, m.y, reduced ? 8 : 22, COLORS.pepper, 340, time, 'dot', 9201 + index, 1.1);
    burst(m.x, m.y, reduced ? 4 : 16, '#fff7d6', 380, time, 'spark', 9301 + index, 0.7);
    if (!reduced) shake = Math.max(shake, 0.6);
    pulseAt = time;
  }

  const ready = () => [kitchen, cannon].every(image => image.complete && image.naturalWidth > 0) && tokens.ready() && (rig !== null || rigFailed);
  /** Whether the HEMI coin on screen is the kit's mark (true), the stand-in (false) or undecided (null). */
  const hemiFromKit = () => tokens.hemiFromKit();
  /** Development inspection only: hands back the built rig for review tooling. */
  const debugRig = () => rig;
  /** Development only: advances the performance without drawing, so a capture
   *  harness can settle the springs at a frozen clock. */
  const warm = (state: ArcadeState | null, playing: boolean, reduced: boolean, time: number, delta: number) => { animator.step(state, playing, reduced, time, delta, !(DEV_HOOKS && devRender.holdBlink)); };
  /** Development only: the pose the animator settled on for the last frame. */
  const debugPose = () => ({ ...animator.current });
  /** Development only: the render clock the last frame was drawn at (hit-stop aware). */
  const worldTime = () => lastWorldTime;
  /** The camera in force on the last frame: arena -> screen is `anchor + (p - anchor) * zoom`. */
  const cameraNow = () => ({ zoom: camera.zoom, target: camera.target, ax: CAMERA.ax, ay: CAMERA.ay, said: camera.said });
  return { draw, ready, debugRig, debugPose, warm, worldTime, camera: cameraNow, hemiFromKit, pressE };
}
