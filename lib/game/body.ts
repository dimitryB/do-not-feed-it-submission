/**
 * The creature's geometry, as the rules see it.
 *
 * The mouth is the target, so where it is and what shape it is are rules, not
 * presentation. This module owns everything that decides the aperture: the
 * landmarks measured off the painting, the part of the body warp that moves the
 * face around the mouth, the aperture's two lip curves and the test that says
 * whether a point is inside them. The renderer draws the mouth from exactly
 * this; nothing here reads a clock, a canvas or a setting, so a replay computes
 * the same mouth on any machine.
 *
 * Coordinates: "painting" space is the 1200x700 arena the kitchen painting is
 * laid out in, before the creature is moved and scaled; "arena" space is where
 * the rules' projectiles fly. The creature is drawn as a layer scaled by
 * `bodyScale` about `REST_MOUTH` and moved so that point lands on the rules'
 * mouth anchor; `toArena` is that transform.
 */
import { cos, hypot, sin } from "./detmath.ts";

/** Where the head, belly and counter sit in the painting. Measured at 4x. */
export const HEAD = { x: 848, y: 190 } as const;
export const BELLY = { x: 840, y: 424 } as const;
/** The counter line. Nothing below this may be displaced. */
export const COUNTER_Y = 470;

/**
 * The painted mouth, which is the widest the aperture ever gets.
 * `jawOpen` 1 reproduces it; `jawOpen` 0 is a closed lip line.
 */
export const MOUTH = {
  cornerLeft: { x: 718, y: 211 },
  cornerRight: { x: 966, y: 225 },
  center: 840,
  upperOpen: 184,
  upperClosed: 276,
  lowerOpen: 366,
  lowerClosed: 296,
} as const;

/** The resting mouth in painting coordinates: the point the body is scaled about. */
export const REST_MOUTH = { x: 840, y: 279 } as const;

/** How far the chin travels between a wide-open and a closed mouth. */
export const JAW_TRAVEL = 26;

/** The channels that move the mouth: the aperture's own, and the body around it. */
export interface BodyChannels {
  jawOpen: number; mouthWidth: number; cornerLift: number; lipPress: number; jawShift: number;
  mouthScaleX: number; mouthScaleY: number;
  headX: number; headY: number; headTilt: number; lean: number;
  squashX: number; squashY: number; bodyRise: number;
  cheekPuff: number; throat: number; throatTravel: number;
}

const bump = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) => {
  const nx = (x - cx) / rx;
  const ny = (y - cy) / ry;
  const d = nx * nx + ny * ny;
  if (d >= 1) return 0;
  const t = 1 - d;
  return t * t;
};

/**
 * Keeps every displacement above the counter line. The ramp is long on
 * purpose: a short one puts a steep gradient in the field, and a steep enough
 * gradient folds a warp cell over itself.
 */
export const floorGate = (y: number) => {
  if (y <= COUNTER_Y - 190) return 1;
  if (y >= COUNTER_Y - 30) return 0;
  const t = (COUNTER_Y - 30 - y) / 160;
  return t * t * (3 - 2 * t);
};

/**
 * The part of the body warp that can move the mouth: the head, the body's
 * squash and rise, the chin, the swallow and the cheeks. `tremorX`/`tremorY`
 * are the renderer's shake — the rules always pass zero, and a shake of a pixel
 * or two moves the skin under the lips, never the lips.
 *
 * The renderer's full field is this plus the antennae, which are gated so they
 * never reach the mouth.
 */
export function bodyField(pose: BodyChannels, tremorX = 0, tremorY = 0) {
  const tilt = pose.headTilt * Math.PI / 180;
  const cosT = cos(tilt);
  const sinT = sin(tilt);
  const jaw = (1 - pose.jawOpen) * JAW_TRAVEL;
  const throatY = 300 + pose.throatTravel * 190;
  const lean = 1 + pose.lean;
  return (x: number, y: number, out: { x: number; y: number }) => {
    let dx = 0;
    let dy = 0;
    const gate = floorGate(y);
    if (gate <= 0) { out.x = 0; out.y = 0; return; }

    // Head: tilt, offset, and a lean that brings it toward the camera.
    const head = bump(x, y, HEAD.x, HEAD.y + 26, 250, 214);
    if (head > 0) {
      const rx = x - HEAD.x;
      const ry = y - (HEAD.y + 170);
      dx += ((rx * cosT - ry * sinT) * lean - rx + pose.headX + tremorX) * head;
      dy += ((rx * sinT + ry * cosT) * lean - ry + pose.headY + tremorY + pose.lean * 26) * head;
    }

    // Body: squash and stretch about the belly, plus the whole rise.
    const body = bump(x, y, BELLY.x, BELLY.y - 96, 292, 262) * gate;
    if (body > 0) {
      dx += (x - BELLY.x) * (pose.squashX - 1) * body;
      dy += (y - BELLY.y) * (pose.squashY - 1) * body - pose.bodyRise * body;
    }

    // Jaw: closing the mouth lifts and compresses the whole lower face.
    const chin = bump(x, y, 840, 340, 268, 196) * gate;
    if (chin > 0) dy -= jaw * chin;

    // Swallow: a travelling bulge from the throat into the belly.
    if (pose.throat > 0.01) {
      const lump = bump(x, y, 840, throatY, 138, 104) * gate;
      if (lump > 0) {
        dx += (x - 840) / 138 * pose.throat * 34 * lump;
        dy += (y - throatY) / 104 * pose.throat * 24 * lump;
      }
    }

    // Cheeks: puffed for pressure, hollow for a hard exhale.
    if (pose.cheekPuff !== 0) {
      const left = bump(x, y, 726, 268, 108, 104);
      const right = bump(x, y, 962, 278, 108, 104);
      dx -= pose.cheekPuff * 17 * left;
      dx += pose.cheekPuff * 17 * right;
      dy += pose.cheekPuff * 5 * (left + right);
    }

    out.x = dx;
    out.y = dy;
  };
}

export type Field = (x: number, y: number, out: { x: number; y: number }) => void;

const probe = { x: 0, y: 0 };

/**
 * Where the painted point `(x, y)` ends up.
 *
 * The warp is a backward map — each destination pixel samples the source at
 * `destination - field(destination)` — so the displacement that moves a
 * painted feature is the field at the feature's destination. Inverted by fixed
 * point iteration; three steps converge for any field gentle enough to draw.
 */
export function placePoint(field: Field, x: number, y: number, out = { x: 0, y: 0 }) {
  let qx = x;
  let qy = y;
  for (let step = 0; step < 3; step++) {
    field(qx, qy, probe);
    qx = x + probe.x;
    qy = y + probe.y;
  }
  out.x = qx;
  out.y = qy;
  return out;
}

const placedLeft = { x: 0, y: 0 };
const placedRight = { x: 0, y: 0 };
const placedUpper = { x: 0, y: 0 };
const placedLower = { x: 0, y: 0 };

/**
 * The mouth's opening: two quadratic lip curves that share their corners.
 *
 * Upper lip: left corner → right corner with control `(cx, cu)`; lower lip the
 * same with control `(cx, cd)`. Both curves share the control's x, so one
 * parameter `t` puts a point on each at the same x — which is what makes the
 * inside test exact and cheap.
 */
export interface Aperture {
  leftX: number; leftY: number; rightX: number; rightY: number;
  centerX: number; upperApex: number; lowerApex: number;
  upperControl: number; lowerControl: number;
}

/** Control point that puts a quadratic's apex exactly on `apex` at t = 0.5. */
const controlFor = (startY: number, endY: number, apex: number) => 2 * apex - 0.5 * (startY + endY);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** The corners never climb past this: past it a smile's ends land on the lower eyelids. */
const CORNER_CEILING = 196;

/**
 * How the drawn mouth is fitted to the game, the same for the rules and the
 * renderer: `x` widens or narrows it about its middle, `y` raises or lowers
 * the upper lip and the corners toward the lower lip (the jaw's floor stays
 * where it is).
 */
export interface MouthFit { x: number; y: number }
const UNFITTED: MouthFit = { x: 1, y: 1 };

/** The aperture a set of channels describes, in painting coordinates, before the warp. */
export function apertureOf(pose: BodyChannels, fit: MouthFit = UNFITTED): Aperture {
  const lift = pose.cornerLift;
  const press = pose.lipPress;
  // Mouth width has to move the corners a long way to read at all.
  const pull = (1 - pose.mouthWidth) * 62 + press * 10 + (1 - pose.jawOpen) * 15;
  // A shifted jaw moves the whole mouth sideways and drops the trailing corner.
  const shift = pose.jawShift * 11;
  const leftX = MOUTH.cornerLeft.x + pull + shift;
  const rightX = MOUTH.cornerRight.x - pull + shift;
  const leftY = Math.max(CORNER_CEILING, MOUTH.cornerLeft.y - lift * 26 + pose.jawShift * 9);
  const rightY = Math.max(CORNER_CEILING, MOUTH.cornerRight.y - lift * 26 - pose.jawShift * 5);
  // How far the mouth is open and how far it curves are separate.
  const centre = mix((MOUTH.upperClosed + MOUTH.lowerClosed) / 2,
                     (MOUTH.upperOpen + MOUTH.lowerOpen) / 2, pose.jawOpen)
    + lift * 30 * (1 - pose.jawOpen * 0.7);
  const gap = Math.max(4, mix(MOUTH.lowerClosed - MOUTH.upperClosed,
                              MOUTH.lowerOpen - MOUTH.upperOpen, pose.jawOpen) - press * 6);
  // Hard floor under the nose.
  const upperApex = Math.max(MOUTH.upperOpen, centre - gap / 2);
  const lowerApex = upperApex + gap;
  // Growth: the corners can barely move, the gap can open a long way.
  const sx = pose.mouthScaleX || 1;
  const sy = pose.mouthScaleY || 1;
  const mid = (upperApex + lowerApex) / 2;
  const scaledLeftX = MOUTH.center + (leftX - MOUTH.center) * sx * fit.x;
  const scaledRightX = MOUTH.center + (rightX - MOUTH.center) * sx * fit.x;
  const scaledLower = mid + (lowerApex - mid) * sy;
  // The fit scales the top of the mouth toward its floor.
  const fy = (y: number) => scaledLower + (y - scaledLower) * fit.y;
  const scaledUpper = fy(Math.max(MOUTH.upperOpen - 14, mid + (upperApex - mid) * sy));
  const scaledLeftY = fy(Math.max(CORNER_CEILING, mid + (leftY - mid) * sy));
  const scaledRightY = fy(Math.max(CORNER_CEILING, mid + (rightY - mid) * sy));
  return {
    leftX: scaledLeftX, leftY: scaledLeftY, rightX: scaledRightX, rightY: scaledRightY,
    centerX: MOUTH.center,
    upperApex: scaledUpper, lowerApex: scaledLower,
    upperControl: controlFor(scaledLeftY, scaledRightY, scaledUpper),
    lowerControl: controlFor(scaledLeftY, scaledRightY, scaledLower),
  };
}

/**
 * Moves an aperture onto the warped face, corner by corner and apex by apex.
 * A single affine sampled at the mouth's centre is wrong wherever the field's
 * scale varies across the mouth, which it does on every inflated pose.
 */
export function placeAperture(shape: Aperture, field: Field): Aperture {
  const left = placePoint(field, shape.leftX, shape.leftY, placedLeft);
  const right = placePoint(field, shape.rightX, shape.rightY, placedRight);
  const upper = placePoint(field, shape.centerX, shape.upperApex, placedUpper);
  const lower = placePoint(field, shape.centerX, shape.lowerApex, placedLower);
  const centerX = (upper.x + lower.x) / 2;
  const lowerY = Math.max(upper.y + 4, lower.y);
  return {
    leftX: left.x, leftY: left.y, rightX: right.x, rightY: right.y, centerX,
    upperApex: upper.y, lowerApex: lowerY,
    upperControl: controlFor(left.y, right.y, upper.y),
    lowerControl: controlFor(left.y, right.y, lowerY),
  };
}

/**
 * The mouth in arena space: what the rules test a projectile against and what
 * the renderer draws, as the same four control points.
 */
export interface MouthShape {
  /** Corners. */
  lx: number; ly: number; rx: number; ry: number;
  /** Shared control x, upper control y, lower control y. */
  cx: number; cu: number; cd: number;
  /** Apexes of the two lips at t = 0.5: the top and bottom of the opening. */
  top: number; bottom: number;
  /** A point well inside the opening, and the opening's half-extents. */
  midX: number; midY: number; halfW: number; halfH: number;
}

/** Bounding numbers for a lens: its centre and half-extents. */
function finish(lx: number, ly: number, rx: number, ry: number, cx: number, cu: number, cd: number): MouthShape {
  // At t = 0.5 both curves are at their apexes (by construction of the controls).
  const top = 0.25 * ly + 0.5 * cu + 0.25 * ry;
  const bottom = 0.25 * ly + 0.5 * cd + 0.25 * ry;
  const midX = 0.25 * lx + 0.5 * cx + 0.25 * rx;
  return {
    lx: q(lx), ly: q(ly), rx: q(rx), ry: q(ry), cx: q(cx), cu: q(cu), cd: q(cd),
    top: q(top), bottom: q(bottom), midX: q(midX), midY: q((top + bottom) / 2),
    halfW: q((rx - lx) / 2), halfH: q(Math.max(0, bottom - top) / 2),
  };
}

const q = (value: number) => Math.round(value * 10000) / 10000;

/** Painting → arena: scaled about the resting mouth, then moved onto the anchor. */
export function toArena(shape: Aperture, anchorX: number, anchorY: number, scaleX: number, scaleY: number): MouthShape {
  const ax = (x: number) => anchorX + (x - REST_MOUTH.x) * scaleX;
  const ay = (y: number) => anchorY + (y - REST_MOUTH.y) * scaleY;
  return finish(ax(shape.leftX), ay(shape.leftY), ax(shape.rightX), ay(shape.rightY),
    ax(shape.centerX), ay(shape.upperControl), ay(shape.lowerControl));
}

/** Arena → painting: the exact inverse, for drawing a rules mouth inside the body's transform. */
export function toPainting(mouth: MouthShape, anchorX: number, anchorY: number, scaleX: number, scaleY: number): Aperture {
  const px = (x: number) => REST_MOUTH.x + (x - anchorX) / scaleX;
  const py = (y: number) => REST_MOUTH.y + (y - anchorY) / scaleY;
  const leftY = py(mouth.ly);
  const rightY = py(mouth.ry);
  const upperControl = py(mouth.cu);
  const lowerControl = py(mouth.cd);
  return {
    leftX: px(mouth.lx), leftY, rightX: px(mouth.rx), rightY,
    centerX: px(mouth.cx),
    upperApex: 0.25 * leftY + 0.5 * upperControl + 0.25 * rightY,
    lowerApex: 0.25 * leftY + 0.5 * lowerControl + 0.25 * rightY,
    upperControl, lowerControl,
  };
}

/** The parameter `t` at which the lens's shared x(t) reaches `x`, or -1 outside the corners. */
function paramAt(mouth: MouthShape, x: number): number {
  // x(t) = lx + 2t(cx - lx) + t²(lx - 2cx + rx); monotonic while cx lies between the corners.
  const a = mouth.lx - 2 * mouth.cx + mouth.rx;
  const b = 2 * (mouth.cx - mouth.lx);
  const c = mouth.lx - x;
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) < 1e-9) return -1;
    const t = -c / b;
    return t >= 0 && t <= 1 ? t : -1;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  // The numerically stable pair of roots; keep the one on the curve.
  const root = Math.sqrt(disc);
  const half = -0.5 * (b + (b >= 0 ? root : -root));
  const t1 = half / a;
  const t2 = half !== 0 ? c / half : -1;
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return -1;
}

/** The upper and lower lip at `x`, or null outside the corners. */
export function lipsAt(mouth: MouthShape, x: number): { upper: number; lower: number } | null {
  const t = paramAt(mouth, x);
  if (t < 0) return null;
  const s = 1 - t;
  const ends = s * s * mouth.ly + t * t * mouth.ry;
  const middle = 2 * s * t;
  return { upper: ends + middle * mouth.cu, lower: ends + middle * mouth.cd };
}

/**
 * Whether a point is inside the opening, with optional margins: how far below
 * the upper lip and above the lower lip, in pixels, the point has to be.
 */
export function insideMouth(mouth: MouthShape, x: number, y: number, top = 0, bottom = top): boolean {
  if (x <= mouth.lx || x >= mouth.rx) return false;
  const lips = lipsAt(mouth, x);
  if (!lips) return false;
  return y >= lips.upper + top && y <= lips.lower - bottom;
}

/**
 * Sample points spread evenly over a unit disc (a sunflower spiral), so the
 * share of them inside the opening is the share of the coin's face inside it.
 */
const DISC: readonly (readonly [number, number])[] = Array.from({ length: 48 }, (_, i) => {
  const radius = Math.sqrt((i + 0.5) / 48);
  const angle = i * 2.399963229728653;
  return [radius * cos(angle), radius * sin(angle)] as const;
});

/** The share of a coin of `radius` centred at (x, y) that is inside the opening, 0..1. */
export function coverage(mouth: MouthShape, x: number, y: number, radius: number): number {
  // Nowhere near: not worth sampling.
  if (x + radius <= mouth.lx || x - radius >= mouth.rx) return 0;
  const top = Math.min(mouth.ly, mouth.ry, mouth.top);
  const bottom = Math.max(mouth.ly, mouth.ry, mouth.bottom);
  if (y + radius <= top || y - radius >= bottom) return 0;
  let inside = 0;
  for (let i = 0; i < DISC.length; i++) {
    if (insideMouth(mouth, x + DISC[i][0] * radius, y + DISC[i][1] * radius)) inside += 1;
  }
  return inside / DISC.length;
}

/**
 * Whether most of a coin is inside the opening: at least `share` of its face.
 * Along a lip that puts the centre well past the lip; in a corner the opening
 * is too thin to hold most of a coin, so one that only covers a corner does
 * not count.
 */
export function swallows(mouth: MouthShape, x: number, y: number, radius: number, share: number): boolean {
  return coverage(mouth, x, y, radius) >= share;
}

/**
 * How far (x, y) is from the opening: 0 inside it, otherwise the distance to
 * the nearer lip curve, corners included. A coin within its own radius of a
 * shut mouth is touching the lips, from any side and round the corners.
 */
export function distanceToMouth(mouth: MouthShape, x: number, y: number, reach = Infinity): number {
  // Far off the opening's box: no need to look closer.
  // (The corners can sit above the upper lip's middle, or below the lower's.)
  const top = Math.min(mouth.ly, mouth.ry, mouth.top);
  const bottom = Math.max(mouth.ly, mouth.ry, mouth.bottom);
  if (x < mouth.lx - reach || x > mouth.rx + reach || y < top - reach || y > bottom + reach) return Infinity;
  if (insideMouth(mouth, x, y)) return 0;
  let best = Infinity;
  const steps = 48;
  for (const control of [mouth.cu, mouth.cd]) {
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const px = u * u * mouth.lx + 2 * u * t * mouth.cx + t * t * mouth.rx;
      const py = u * u * mouth.ly + 2 * u * t * control + t * t * mouth.ry;
      const d = hypot(px - x, py - y);
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * Whether the opening can take a coin at all: a coin at its deepest point,
 * midway between the lips, would be mostly inside it. Jaws nearer together
 * than that are teeth.
 */
export function takesCoin(mouth: MouthShape, radius: number, share: number): boolean {
  return swallows(mouth, mouth.midX, mouth.midY, radius, share);
}

/**
 * A point inside the opening, a fraction `u` of the way across it (0 left
 * corner, 1 right corner) and `v` of the way down (0 upper lip, 1 lower lip).
 */
export function pointInMouth(mouth: MouthShape, u: number, v: number): { x: number; y: number } {
  const t = Math.min(0.98, Math.max(0.02, u));
  const s = 1 - t;
  const x = s * s * mouth.lx + 2 * s * t * mouth.cx + t * t * mouth.rx;
  const ends = s * s * mouth.ly + t * t * mouth.ry;
  const upper = ends + 2 * s * t * mouth.cu;
  const lower = ends + 2 * s * t * mouth.cd;
  return { x, y: upper + (lower - upper) * v };
}
