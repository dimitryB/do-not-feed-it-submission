/**
 * The creature's performance, as targets.
 *
 * Reads the shift and produces, for every channel of the creature's pose, the
 * value it is heading for. This used to live in the renderer, which was fine
 * while the mouth was only a picture. The mouth is the target now — the rules
 * test a projectile against the exact opening the player sees — so the
 * channels that shape and move the mouth have to be the rules' own. One
 * function, used twice:
 *
 *   - the rules (`stepFace`, called every tick from `stepCreature`) spring the
 *     channels that move the mouth, in tick time, with no setting and no clock
 *     of their own, so a replay reproduces the mouth exactly;
 *   - the renderer springs everything else (eyes, brows, teeth, skin) toward the
 *     same targets in its own time, and during a shift takes the mouth's
 *     channels from the rules instead of animating them itself.
 *
 * The face is authored as whole expressions rather than as a pile of
 * per-channel maximums. Blending *toward* a named expression pulls every
 * channel it names — including the ones it wants at rest — so a strong state
 * overrides a weak one instead of averaging with it.
 */
import type { ArcadeEvent, ArcadeState, Flame, Ingredient, MutationLevels } from "./arcade";
import { ARENA, TUNING, apertureAhead, crateAt } from "./arcade.ts";
import { cos, exp, hypot, pow, sin } from "./detmath.ts";

export interface FacePose {
  headX: number; headY: number; headTilt: number; lean: number;
  squashX: number; squashY: number;
  bodyRise: number; bellySwell: number; breath: number;
  jawOpen: number; mouthWidth: number; cornerLift: number; lipPress: number; jawShift: number;
  mouthScaleX: number; mouthScaleY: number;
  lidLeft: number; lidRight: number; lowerLid: number; blink: number;
  browAngry: number; browSad: number; browRaise: number; browAsym: number;
  pupilX: number; pupilY: number; pupilScale: number;
  tongueOut: number; drool: number;
  teethBare: number; teethAlign: number; teethLong: number; teethQuiver: number;
  throat: number; throatTravel: number;
  cheekPuff: number; cheekMarks: number;
  flush: number; rageFlush: number; pallor: number; sweat: number; tears: number;
  antennaDroop: number; antennaTwist: number; antennaShake: number;
  exhale: number; magnetism: number; taut: number;
  shake: number;
  /**
   * The body scale and where the mouth is, from the rules. The creature is
   * drawn as a clipped layer scaled by `bodyScale` about its resting mouth and
   * moved so that mouth lands on `(mouthX, mouthY)`, the rules' mouth anchor.
   */
  bodyScaleX: number; bodyScaleY: number; mouthX: number; mouthY: number;
  /** A frenzy: the mouth gapes, the teeth crackle, nothing is chewed. */
  frenzy: number;
  /** Electric crackle on the teeth, metal only. */
  crackle: number;
  /** Fire breath: inhaling (the tell), then the breath itself. */
  inhale: number;
}

export const FIELDS: (keyof FacePose)[] = [
  "headX", "headY", "headTilt", "lean", "squashX", "squashY", "bodyRise", "bellySwell", "breath",
  "jawOpen", "mouthWidth", "cornerLift", "lipPress", "jawShift", "mouthScaleX", "mouthScaleY",
  "lidLeft", "lidRight", "lowerLid", "blink",
  "browAngry", "browSad", "browRaise", "browAsym",
  "pupilX", "pupilY", "pupilScale", "tongueOut", "drool",
  "teethBare", "teethAlign", "teethLong", "teethQuiver", "throat", "throatTravel",
  "cheekPuff", "cheekMarks", "flush", "rageFlush", "pallor", "sweat", "tears",
  "antennaDroop", "antennaTwist", "antennaShake", "exhale", "magnetism", "taut", "shake",
  "bodyScaleX", "bodyScaleY", "mouthX", "mouthY", "frenzy", "crackle", "inhale",
];

/** Each channel's index into a dense target row. */
export const F = Object.fromEntries(FIELDS.map((field, index) => [field, index])) as Record<keyof FacePose, number>;

/**
 * The channels the rules own: everything that shapes the mouth or moves the
 * skin around it. `mouthX`/`mouthY` are not here — they are the rules' anchor
 * itself, not a spring toward it.
 */
export const GEOMETRY = [
  "jawOpen", "mouthWidth", "cornerLift", "lipPress", "jawShift", "mouthScaleX", "mouthScaleY",
  "headX", "headY", "headTilt", "lean", "squashX", "squashY", "bodyRise",
  "cheekPuff", "throat", "throatTravel", "bodyScaleX", "bodyScaleY",
] as const satisfies readonly (keyof FacePose)[];
export type GeometryChannel = (typeof GEOMETRY)[number];
export type GeometryPose = Record<GeometryChannel, number>;

/**
 * The channels an expression owns. Anything outside this list is layered on
 * afterwards: skin colour, the swallow, the aim of the eyes, breathing.
 */
const FACE: (keyof FacePose)[] = [
  "jawOpen", "mouthWidth", "cornerLift", "lipPress", "jawShift",
  "lidLeft", "lidRight", "lowerLid",
  "browAngry", "browSad", "browRaise", "browAsym",
  "tongueOut", "drool", "teethBare", "teethLong",
  "headX", "headY", "headTilt", "lean",
  "antennaDroop", "antennaTwist",
  "squashX", "squashY", "bodyRise", "bellySwell", "cheekPuff", "pupilScale",
];

/** Spring rates per field: low stiffness reads as weight, high as a snap. */
/** The expression channels that move the mouth, plus the swell that feeds the squash. */
const FACE_GEOMETRY: (keyof FacePose)[] = FACE.filter((field) =>
  (GEOMETRY as readonly string[]).includes(field) || field === "bellySwell");

export const RATES: Partial<Record<keyof FacePose, [number, number]>> = {
  headX: [110, 13], headY: [110, 13], headTilt: [90, 12], lean: [80, 12],
  squashX: [220, 15], squashY: [220, 15],
  // The jaw snaps: a chomp is shut within a few ticks of the catch.
  jawOpen: [700, 38], mouthWidth: [150, 16], cornerLift: [130, 15], lipPress: [180, 18],
  mouthScaleX: [60, 12], mouthScaleY: [60, 12],
  jawShift: [140, 16],
  lidLeft: [300, 24], lidRight: [300, 24], lowerLid: [200, 20], blink: [420, 30],
  browAngry: [150, 17], browSad: [150, 17], browRaise: [170, 18], browAsym: [150, 17],
  pupilX: [230, 22], pupilY: [230, 22], pupilScale: [180, 20],
  bellySwell: [48, 11], bodyRise: [70, 13], throat: [340, 26],
  cheekPuff: [80, 11], teethLong: [70, 12], teethAlign: [90, 13],
  flush: [95, 17], rageFlush: [60, 14], pallor: [22, 9], antennaDroop: [34, 10], antennaTwist: [40, 11],
  tears: [60, 12],
  // Loose enough that a growth step is a visible pop with an overshoot.
  bodyScaleX: [70, 10], bodyScaleY: [70, 10], mouthX: [320, 28], mouthY: [320, 28],
  frenzy: [60, 12], crackle: [120, 14], inhale: [140, 16],
};
export const DEFAULT_RATE: [number, number] = [120, 15];

type Expression = Partial<Record<keyof FacePose, number>>;

/** Everything a face channel does when nothing is happening. */
const REST: Expression = {
  jawOpen: 0.06, mouthWidth: 1, cornerLift: 0.3, lipPress: 0.3, jawShift: 0,
  mouthScaleX: 1, mouthScaleY: 1,
  lidLeft: 0.06, lidRight: 0.06, lowerLid: 0.08,
  browAngry: 0, browSad: 0, browRaise: 0.1, browAsym: 0,
  tongueOut: 0, drool: 0, teethBare: 0, teethLong: 0,
  headX: 0, headY: 0, headTilt: 0, lean: 0,
  antennaDroop: 0, antennaTwist: 0,
  squashX: 1, squashY: 1, bodyRise: 0, bellySwell: 0, cheekPuff: 0, pupilScale: 1,
};

/**
 * The authored expressions. Values are deliberately far apart: at 960 px, a
 * difference smaller than the compression noise is no difference at all.
 * (The reasoning behind each one is in the history of `lib/render/creature/pose.ts`.)
 */
const EXPRESSIONS = {
  /** Title screen. Curious, wide awake, watching the launcher. Lips together. */
  attract: {
    jawOpen: 0.02, mouthWidth: 0.9, cornerLift: 0.62, lipPress: 0.7,
    lidLeft: 0.02, lidRight: 0.02, lowerLid: 0.14,
    browRaise: 0.45, browAsym: 0.35, headTilt: -6.5, headX: -9,
    antennaDroop: -0.7, antennaTwist: 1, pupilScale: 1.06,
  },
  peckish: {
    jawOpen: 0.12, mouthWidth: 0.72, cornerLift: -1.3, lipPress: 0.35,
    lidLeft: 0.5, lidRight: 0.58, lowerLid: 0.06,
    browSad: 1, browRaise: 0.15, tongueOut: 0.8, drool: 0.95, browAsym: 0.35,
    headY: 26, headTilt: 4.6, lean: 0.03, antennaDroop: 1, antennaTwist: -0.35,
    squashY: 0.96, squashX: 1.035, bodyRise: -16,
  },
  starving: {
    jawOpen: 0.2, mouthWidth: 0.68, cornerLift: -1.5, lipPress: 0,
    lidLeft: 0.58, lidRight: 0.5, lowerLid: 0,
    browSad: 1, browRaise: 0.1, tongueOut: 1, drool: 0.9,
    headY: 24, headTilt: 6.5, antennaDroop: 1.15, antennaTwist: 0.1,
    squashY: 0.92, squashX: 1.05, bodyRise: -22, cheekPuff: -1,
  },
  trackFar: {
    jawOpen: 0.42, mouthWidth: 0.9, cornerLift: -0.1, lipPress: 0.15,
    lidLeft: 0, lidRight: 0, lowerLid: 0, browRaise: 0.85, browAsym: 0.5,
    drool: 0.35, headTilt: -7, headY: 4, antennaDroop: -0.9, antennaTwist: 0.6,
    pupilScale: 1.14,
  },
  trackNear: {
    jawOpen: 1, mouthWidth: 1.07, cornerLift: 0.2, lidLeft: 0, lidRight: 0,
    browRaise: 0.95, drool: 0.65, tongueOut: 0.2, headY: -9, lean: 0.05,
    antennaDroop: -1.05, antennaTwist: 0.12, pupilScale: 1.16,
  },
  snap: {
    jawOpen: 0.05, mouthWidth: 0.7, cornerLift: 0.1, lipPress: 1, teethBare: 0.75,
    lidLeft: 0.9, lidRight: 0.9, lowerLid: 0.85, browRaise: 0.2, browAngry: 0.4,
    headY: 15, squashY: 0.87, squashX: 1.11, cheekPuff: 1.1, antennaDroop: -0.9,
  },
  clank: {
    jawOpen: 0.04, mouthWidth: 0.66, cornerLift: -0.35, lipPress: 1, teethBare: 1,
    lidLeft: 0.9, lidRight: 0.55, lowerLid: 0.9, browAngry: 0.9, browAsym: 0.6,
    headX: 30, headTilt: 8, headY: 12, squashY: 0.86, squashX: 1.15,
    cheekPuff: 1.3, jawShift: 0.5,
    antennaDroop: -0.85, antennaTwist: 0.95, pupilScale: 0.66,
  },
  puff: {
    jawOpen: 0.06, mouthWidth: 0.82, cornerLift: 0.65, lipPress: 0.8, cheekPuff: 1.15,
    lidLeft: 0.08, lidRight: 0.08, lowerLid: 0.35, browRaise: 1,
    headY: -13, bodyRise: 20, bellySwell: 0.55, squashY: 1.08, squashX: 0.99,
    antennaDroop: -1.1, antennaTwist: 0.2, pupilScale: 1.32,
  },
  burn: {
    jawOpen: 0.26, mouthWidth: 0.66, cornerLift: -1.25, lipPress: 0.35, tongueOut: 0.95,
    lidLeft: 0.66, lidRight: 0.66, lowerLid: 0.6, browSad: 0.75, browAngry: 0.45,
    headY: -8, squashY: 0.97, squashX: 1.03,
    antennaDroop: 0.35, antennaTwist: 0.65,
  },
  delight: {
    jawOpen: 0.46, mouthWidth: 1.1, cornerLift: 1.4, lipPress: 0, teethBare: 0.55,
    lidLeft: 0.22, lidRight: 0.22, lowerLid: 1, browRaise: 0.85,
    headTilt: 7.5, headY: -16, bellySwell: 0.35, squashY: 1.05, bodyRise: 10,
    antennaDroop: -1.25, antennaTwist: 0.35, pupilScale: 1.1,
  },
  shrug: {
    jawOpen: 0, mouthWidth: 0.5, cornerLift: -0.95, lipPress: 1, jawShift: 1.4,
    lidLeft: 0.6, lidRight: 0.18, lowerLid: 0.45, browAsym: 1, browRaise: 0.25,
    headTilt: -10, headX: -26, headY: 12, lean: -0.045,
    antennaDroop: 0.95, antennaTwist: -1.15,
  },
  startle: {
    jawOpen: 0.66, mouthWidth: 0.34, cornerLift: -0.55, lipPress: 0,
    lidLeft: 0, lidRight: 0, lowerLid: 0, browRaise: 1, browAsym: 0.3,
    headY: -20, headTilt: -8, headX: -14, squashY: 1.07, squashX: 0.95,
    antennaDroop: -1.3, antennaTwist: 0.8, pupilScale: 1.4,
  },
  flinch: {
    jawOpen: 0.06, mouthWidth: 0.82, cornerLift: 0.05, lipPress: 0.85,
    lidLeft: 0.66, lidRight: 0.5, browRaise: 1,
    headY: 22, headTilt: 4, squashX: 1.05, squashY: 0.95,
    antennaDroop: 0.4, antennaTwist: 0.55,
  },
  mope: {
    jawOpen: 0.02, mouthWidth: 0.6, cornerLift: -1.5, lipPress: 1, jawShift: -0.3,
    lidLeft: 0.4, lidRight: 0.44, lowerLid: 0.1, browSad: 1, browRaise: 0.1,
    headY: 36, headTilt: 5, lean: 0.02, squashY: 0.92, squashX: 1.06, bodyRise: -26,
    antennaDroop: 1.15, antennaTwist: -0.2,
  },
  sideEye: {
    jawOpen: 0.03, mouthWidth: 0.72, cornerLift: -1.2, lipPress: 0.95, jawShift: -0.85,
    lidLeft: 0.5, lidRight: 0.02, lowerLid: 0.4, browAngry: 0.5, browAsym: 0.95,
    headTilt: 5.5, headY: 6, antennaDroop: 0.6, antennaTwist: -0.75,
  },
  annoy1: {
    jawOpen: 0, mouthWidth: 0.6, cornerLift: -1.5, lipPress: 1, jawShift: -0.5,
    lidLeft: 0.12, lidRight: 0.48, lowerLid: 0.55,
    browAngry: 1, browAsym: 0.85, browRaise: 0,
    headTilt: 4.5, headY: 3, antennaDroop: -0.3, antennaTwist: -0.95,
    pupilScale: 0.86,
  },
  annoy2: {
    jawOpen: 0.1, mouthWidth: 0.78, cornerLift: -1.1, lipPress: 1, teethBare: 0.4,
    lidLeft: 0.08, lidRight: 0.08, lowerLid: 0.7, browAngry: 0.95,
    headX: 16, headTilt: -3, lean: 0.05,
    squashX: 1.08, antennaDroop: -0.6, antennaTwist: -0.15,
    pupilScale: 0.78,
  },
  annoy3: {
    jawOpen: 0.2, mouthWidth: 1.02, cornerLift: -1.45, lipPress: 0, teethBare: 1,
    lidLeft: 0.05, lidRight: 0.05, lowerLid: 0.82, browAngry: 1,
    headX: 25, lean: 0.075, squashX: 1.06,
    antennaDroop: -1, antennaTwist: 0.4, pupilScale: 0.62,
  },
  warnMetal: {
    jawOpen: 0.3, mouthWidth: 0.62, cornerLift: -1.35, lipPress: 0.5,
    teethBare: 1, teethLong: 0.75,
    lidLeft: 0, lidRight: 0, lowerLid: 0.5, browRaise: 0.5, browAngry: 0.9,
    headY: 14, headTilt: -3, lean: -0.05, squashX: 1.05, squashY: 0.96,
    antennaDroop: -1, antennaTwist: 0.8, pupilScale: 0.5,
  },
  activeMetal: {
    jawOpen: 0.74, mouthWidth: 1.06, cornerLift: -0.35, teethBare: 1, teethLong: 1,
    lidLeft: 0.04, lidRight: 0.04, lowerLid: 0.42, browAngry: 0.65,
    headX: 9, lean: 0.04, antennaDroop: -0.95, pupilScale: 0.58,
  },
  warnBalloon: {
    jawOpen: 0, mouthWidth: 0.56, cornerLift: -0.45, lipPress: 1, cheekPuff: 1.6,
    lidLeft: 0, lidRight: 0, lowerLid: 0.1, browRaise: 1, browSad: 0.55,
    bellySwell: 1.05, squashX: 1.09,
    antennaDroop: -1.2, antennaTwist: 0.3, pupilScale: 1.34,
  },
  activeBalloon: {
    jawOpen: 0.12, mouthWidth: 0.8, cornerLift: 0.9, lipPress: 0.3, cheekPuff: 0.95,
    lidLeft: 0.04, lidRight: 0.04, lowerLid: 0.55, browRaise: 0.95,
    bellySwell: 1.9, squashX: 1.11,
    antennaDroop: -1.15, antennaTwist: 0.15, pupilScale: 1.3,
  },
  warnPepper: {
    jawOpen: 0, mouthWidth: 0.5, cornerLift: -1.1, lipPress: 1, cheekPuff: 1.7,
    lidLeft: 0.62, lidRight: 0.66, lowerLid: 0.7, browAngry: 0.9, browSad: 0.45,
    headY: 12, headTilt: -4, lean: -0.05, squashX: 1.08, squashY: 0.95,
    antennaDroop: 0.4, antennaTwist: 0.5,
  },
  holdPepper: {
    jawOpen: 0.14, mouthWidth: 0.82, cornerLift: -0.5, lipPress: 0.6, cheekPuff: 0.6,
    lidLeft: 0.4, lidRight: 0.4, lowerLid: 0.4, browAngry: 0.55,
    headY: 3, antennaDroop: 0.1, antennaTwist: 0.25,
  },
  blowPepper: {
    jawOpen: 0.86, mouthWidth: 0.92, cornerLift: -0.1, cheekPuff: -0.6, tongueOut: 0.9,
    lidLeft: 0.66, lidRight: 0.66, lowerLid: 0.35, browRaise: 1, browSad: 0.4,
    headX: -17, headY: -11, headTilt: -6.5, squashY: 0.95, squashX: 1.04,
    antennaDroop: -1.25, antennaTwist: 0.2,
  },
  deflate: {
    jawOpen: 0.52, mouthWidth: 0.46, cornerLift: -0.7, lipPress: 0, tongueOut: 0.85,
    lidLeft: 0.1, lidRight: 0.06, lowerLid: 0.1, browSad: 0.9, browRaise: 0.5,
    headY: 26, headTilt: 2, bodyRise: -26, bellySwell: -0.9, cheekPuff: -0.95,
    squashY: 0.88, squashX: 1.09, antennaDroop: 1.35, antennaTwist: -0.5,
    pupilScale: 1.28,
  },
  smug: {
    jawOpen: 0.03, mouthWidth: 1.02, cornerLift: 1.3, lipPress: 0.5,
    lidLeft: 0.66, lidRight: 0.6, lowerLid: 0.85, browRaise: 0.35, browAngry: 0.2,
    browAsym: 0.6, headTilt: 7.5, headY: -20, lean: -0.075,
    bellySwell: 1.5, bodyRise: 10, squashY: 1.04, squashX: 1.03,
    antennaDroop: -0.5, antennaTwist: 0.7,
  },
  collapse: {
    jawOpen: 0.14, mouthWidth: 0.8, cornerLift: -1.55, tongueOut: 1, drool: 0.35,
    lidLeft: 0.46, lidRight: 0.5, lowerLid: 0.22, browSad: 1,
    headY: 24, headTilt: 8, bodyRise: -42, squashY: 0.86, squashX: 1.09,
    cheekPuff: -0.85, antennaDroop: 1.15, antennaTwist: 0.15, pupilScale: 0.85,
  },
  rageEnd: {
    jawOpen: 0.82, mouthWidth: 1.1, cornerLift: -0.8, teethBare: 1, teethLong: 0.45,
    lidLeft: 0, lidRight: 0, lowerLid: 0.42, browAngry: 1,
    headX: 28, headY: -14, lean: 0.055, squashX: 1.1, squashY: 0.95, bodyRise: 14,
    antennaDroop: -1.25, antennaTwist: 0.5, pupilScale: 0.55,
  },
} as const satisfies Record<string, Expression>;

type ExpressionName = keyof typeof EXPRESSIONS;

/** Each expression as a dense row over a channel list, so a blend is a plain loop. */
function tabulate(fields: readonly (keyof FacePose)[]): Record<ExpressionName, Float64Array> {
  const out = {} as Record<ExpressionName, Float64Array>;
  for (const name of Object.keys(EXPRESSIONS) as ExpressionName[]) {
    const expression: Expression = EXPRESSIONS[name];
    out[name] = Float64Array.from(fields, (field) => expression[field] ?? REST[field] ?? 0);
  }
  return out;
}
const FACE_TABLE = tabulate(FACE);
const GEOMETRY_TABLE = tabulate(FACE_GEOMETRY);
const FACE_INDEX = Int32Array.from(FACE, (field) => F[field]);
const FACE_GEOMETRY_INDEX = Int32Array.from(FACE_GEOMETRY, (field) => F[field]);
const REST_ROW = Float64Array.from(FACE, (field) => REST[field] ?? 0);

/** What `wear` blends into, set at the top of `faceTargets` (no closure per call). */
const wearing: { target: Float64Array; owned: Int32Array; table: Record<ExpressionName, Float64Array> } = { target: new Float64Array(0), owned: FACE_INDEX, table: FACE_TABLE };

/** Blends the target row toward one authored expression. */
function wear(name: ExpressionName, weight: number) {
  if (weight <= 0.001) return;
  const { target, owned } = wearing;
  const values = wearing.table[name];
  const w = weight > 1 ? 1 : weight;
  for (let i = 0; i < owned.length; i++) {
    const k = owned[i];
    const from = target[k];
    target[k] = from + (values[i] - from) * w;
  }
}

/** A dense target row, one slot per channel, in `FIELDS` order. */
export function targetRow(): Float64Array { return new Float64Array(FIELDS.length); }

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);
const clamp = (low: number, high: number, value: number) => (value < low ? low : value > high ? high : value);
const mix = (a: number, b: number, t: number) => a + (b - a) * clamp01(t);
/** Smooth 0→1 ramp, used everywhere a value should ease rather than jump. */
const ramp = (value: number, from: number, to: number) => {
  const t = clamp01((value - from) / (to - from));
  return t * t * (3 - 2 * t);
};

/**
 * How much bigger the body is drawn, per unit of size, on each axis. Wider
 * than tall, on purpose: the mouth is the anchor and the rules keep it low, so
 * the eyes leave the top of the frame as the vertical scale rises.
 */
export const BODY_SCALE_PER_SIZE = { x: 0.36, y: 0.06 };
/** How much the balloon inflates the body, per level, on top of growth: mostly sideways. */
const INFLATE_PER_LEVEL = { x: 0.035, y: 0.01 };

export interface Gaze { x: number; y: number; weight: number }

interface Reaction { type: ArcadeEvent["type"]; name?: string; ingredient?: Ingredient; craved?: boolean; age: number; x: number; y: number }

/** What the performance reads. A shift supplies all of it; the title screen supplies none. */
export interface FaceInput {
  tick: number;
  phase: ArcadeState["phase"];
  failureReason: ArcadeState["failureReason"];
  hunger: number;
  rage: number;
  mutations: MutationLevels;
  flame: Flame | null;
  events: readonly ArcadeEvent[];
  frenzy: boolean;
  /** The projectile furthest along (largest x), any kind: what the creature watches. */
  nearest: { x: number; y: number } | null;
  /** Whether a coin out of a block is still on its way in. */
  pourInFlight: boolean;
  crates: ArcadeState["crates"];
  creature: {
    x: number; y: number; size: number; open: number; aperture: number; gape: number; track: number; untilOpen: number;
  } | null;
  /**
   * The most recent event of each kind the face reacts to, found in one pass
   * over `events` and kept: a prediction steps the same input for hundreds of
   * ticks and the events do not change under it.
   */
  recent?: Recent;
  recentOf?: readonly ArcadeEvent[];
}

interface Recent {
  mutation: ArcadeEvent | null; clank: ArcadeEvent | null; tantrum: ArcadeEvent | null;
  sneeze: ArcadeEvent | null; lunge: ArcadeEvent | null; grow: ArcadeEvent | null;
  feed: ArcadeEvent | null; miss: ArcadeEvent | null; belly: ArcadeEvent | null;
  crateHit: ArcadeEvent | null; pour: ArcadeEvent | null;
}

function recentOf(input: FaceInput): Recent {
  if (input.recent && input.recentOf === input.events) return input.recent;
  const found: Recent = {
    mutation: null, clank: null, tantrum: null, sneeze: null, lunge: null, grow: null,
    feed: null, miss: null, belly: null, crateHit: null, pour: null,
  };
  const events = input.events;
  for (let index = events.length - 1; index >= 0; index--) {
    const e = events[index];
    switch (e.type) {
      case "mutation": found.mutation ??= e; break;
      case "clank": found.clank ??= e; break;
      case "tantrum": found.tantrum ??= e; break;
      case "beat":
        if (e.name === "sneeze") found.sneeze ??= e;
        else if (e.name === "lunge") found.lunge ??= e;
        break;
      case "grow": found.grow ??= e; break;
      case "feed":
        found.feed ??= e;
        if (e.label.startsWith("CRATE")) found.pour ??= e;
        break;
      case "miss": found.miss ??= e; break;
      case "bounce": if (e.name === "belly") found.belly ??= e; break;
      case "crate": if (e.name === "hit") found.crateHit ??= e; break;
      default: break;
    }
  }
  input.recent = found;
  input.recentOf = events;
  return found;
}

/** A recorded event as a reaction, if it is no older than `within` seconds. */
function reaction(input: FaceInput, item: ArcadeEvent | null, within: number): Reaction | null {
  if (!item) return null;
  const age = (input.tick - item.tick) / 60;
  if (age < 0 || age > within) return null;
  return { type: item.type, name: item.name, ingredient: item.ingredient, craved: item.craved, age, x: item.x, y: item.y };
}

const NO_EVENTS: readonly ArcadeEvent[] = Object.freeze([]);
const NO_CRATES: ArcadeState["crates"] = [];

/** Reads a live state into a face input. `nearest` and `pourInFlight` come from its projectiles. */
export function faceInputOf(state: ArcadeState, frenzy: boolean): FaceInput {
  let nearest: { x: number; y: number } | null = null;
  let pour = false;
  for (const item of state.projectiles ?? []) {
    if (!nearest || item.x > nearest.x) nearest = item;
    if (item.kind === "pour") pour = true;
  }
  // A partial snapshot (a bot's delayed view) may leave the history out: then
  // the creature simply has nothing to react to.
  return {
    tick: state.tick, phase: state.phase ?? "playing", failureReason: state.failureReason ?? null,
    hunger: state.hunger, rage: state.rage, mutations: state.mutations, flame: state.flame ?? null,
    events: state.events ?? NO_EVENTS, frenzy, nearest, pourInFlight: pour, crates: state.crates ?? NO_CRATES,
    creature: state.creature,
  };
}

/** A fresh pose with every channel at its neutral value. */
export function neutralPose(): FacePose {
  // One literal, so every pose shares a single fast object shape.
  return {
    headX: 0, headY: 0, headTilt: 0, lean: 0, squashX: 1, squashY: 1, bodyRise: 0, bellySwell: 0, breath: 0,
    jawOpen: 0, mouthWidth: 1, cornerLift: 0, lipPress: 0, jawShift: 0, mouthScaleX: 1, mouthScaleY: 1,
    lidLeft: 0, lidRight: 0, lowerLid: 0, blink: 0,
    browAngry: 0, browSad: 0, browRaise: 0, browAsym: 0,
    pupilX: 0, pupilY: 0, pupilScale: 1, tongueOut: 0, drool: 0,
    teethBare: 0, teethAlign: 0, teethLong: 0, teethQuiver: 0, throat: 0, throatTravel: 0,
    cheekPuff: 0, cheekMarks: 0, flush: 0, rageFlush: 0, pallor: 0, sweat: 0, tears: 0,
    antennaDroop: 0, antennaTwist: 0, antennaShake: 0, exhale: 0, magnetism: 0, taut: 0, shake: 0,
    bodyScaleX: 1, bodyScaleY: 1, mouthX: ARENA.mouth.x, mouthY: ARENA.mouth.y, frenzy: 0, crackle: 0, inhale: 0,
  };
}

/**
 * Writes every channel's target into `target`.
 *
 * `reduced` and `clock` are the renderer's: the rules pass `false` and the
 * shift's own time, so the mouth never depends on a player's setting. Returns
 * where a catch's verdict wants the eyes, which the renderer applies.
 */
export function faceTargets(target: Float64Array, input: FaceInput | null, playing: boolean, reduced: boolean,
                            clock: number, geometryOnly = false, steady = false): { gaze: Gaze | null } {
  // The rules only need the channels that move the mouth; each channel's blend
  // is independent, so leaving the others out changes nothing they compute.
  wearing.target = target;
  wearing.owned = geometryOnly ? FACE_GEOMETRY_INDEX : FACE_INDEX;
  wearing.table = geometryOnly ? GEOMETRY_TABLE : FACE_TABLE;
  target.fill(0);
  for (let i = 0; i < FACE_INDEX.length; i++) target[FACE_INDEX[i]] = REST_ROW[i];
  let gaze: Gaze | null = null;

  const fullness = input?.hunger ?? 78;
  const rage = input?.rage ?? 0;
  const peckish = ramp(fullness, 68, 34);
  const hunger = ramp(fullness, 52, 6);
  const ended = input ? input.phase !== "playing" : false;
  // Mutations are permanent and they stack, so they are levels the creature
  // carries rather than a weather state the kitchen is in.
  const levels = (playing || ended ? input?.mutations : null) ?? { metal: 0, balloon: 0, pepper: 0 };
  const metal = clamp01(levels.metal / 3);
  const balloon = clamp01(levels.balloon / 3);
  const pepper = clamp01(levels.pepper / 3);
  const frenzied = playing && input ? input.frenzy : false;

  // 1. Baseline. A low one in play, so states that do not override the whole
  //    face do not all resolve back toward the resting smile.
  wear("attract", playing ? 0.3 : 1);

  // 2. Appetite. Peckish is impatience; hunger proper is the collapse.
  wear("peckish", peckish);
  wear("starving", hunger);

  // 3. Irritation, three separate shapes rather than one ramp.
  const step1 = ramp(rage, 18, 34);
  const step2 = ramp(rage, 46, 62);
  const step3 = ramp(rage, 74, 90);
  wear("annoy1", step1);
  wear("annoy2", step2);
  wear("annoy3", step3);

  // 4. What it has become, blended by weight because the levels stack. Then
  //    irritation again: from step two it outranks what it has become.
  wear("activeMetal", metal * 0.9);
  wear("activeBalloon", balloon * 0.9);
  wear("holdPepper", pepper * 0.9);
  if (step3 > 0.01) wear("annoy3", step3);
  else if (step2 > 0.01) wear("annoy2", step2 * 0.8);

  // Fire breath, read off the rules' own clock for it.
  const flame = playing && input?.flame ? input.flame : null;
  const tick = input?.tick ?? 0;
  if (flame && tick < flame.until) {
    if (tick < flame.tellUntil) {
      const held = clamp01(1 - (flame.tellUntil - tick) / TUNING.flameTell);
      wear("warnPepper", 0.4 + 0.6 * held);
      target[F.inhale] = Math.max(target[F.inhale], 0.3 + 0.7 * held);
    } else {
      wear("blowPepper", 1);
      target[F.exhale] = 1;
      target[F.inhale] = 0;
    }
  }

  const recent = input ? recentOf(input) : null;
  const latest = (pick: keyof Recent, within: number) => (input && recent ? reaction(input, recent[pick], within) : null);
  // `steady` leaves out everything that happens *to* it — the one-shot
  // reactions and the head following a coin — and keeps its moods. The rules
  // use it to keep an open mouth still enough to aim at (see `stepFace`).
  let nearest: { x: number; y: number } | null = null;
  let feed: Reaction | null = null;
  let miss: Reaction | null = null;
  if (!steady) {
    const landed = latest("mutation", 0.7);
    if (landed) {
      // The moment a level lands gets an overshoot.
      const pop = exp(-landed.age * 6.5);
      target[F.squashX] += pop * 0.09;
      target[F.squashY] -= pop * 0.07;
      target[F.bodyRise] += pop * 16;
      target[F.teethLong] += pop * 0.45;
      target[F.bellySwell] += pop * 0.35;
      if (!reduced) target[F.antennaShake] = Math.max(target[F.antennaShake], pop);
    }
    // A snack off the teeth: a hard jolt sideways, mouth clamped.
    const clanked = latest("clank", 0.5);
    if (clanked) {
      const pop = exp(-clanked.age * 7);
      wear("clank", pop);
      target[F.teethQuiver] = Math.max(target[F.teethQuiver], pop);
      if (!reduced) target[F.shake] = Math.max(target[F.shake], pop * 0.5);
    }
    // A tantrum: the snarl, the whole body shaking.
    const tantrum = latest("tantrum", 1.2);
    if (tantrum) {
      const fit = sin(clamp01(tantrum.age / 1.2) * Math.PI);
      wear("annoy3", fit);
      target[F.antennaShake] = Math.max(target[F.antennaShake], fit);
      if (!reduced) target[F.shake] = Math.max(target[F.shake], fit);
    }
    // A sneeze: the deflate-and-recover beat.
    const sneezed = latest("sneeze", 1.6);
    if (sneezed) {
      const sag = pow(sin(clamp01(sneezed.age / 1.6) * Math.PI), 0.7);
      wear("deflate", sag);
      target[F.exhale] = Math.max(target[F.exhale], exp(-sneezed.age * 5));
    }
    // A lunge coming: it gathers itself, teeth out, leaning in.
    const lunging = latest("lunge", 1.0);
    if (lunging) {
      const gather = clamp01(lunging.age / 0.9);
      wear("activeMetal", gather * 0.6);
      target[F.lean] += gather * 0.06;
      target[F.headX] += gather * 18;
    }
    // A growth step: a pop with an overshoot.
    const grew = latest("grow", 0.7);
    if (grew) {
      const pop = exp(-grew.age * 5);
      target[F.squashX] += pop * 0.07;
      target[F.squashY] += pop * 0.05;
      target[F.bodyRise] += pop * 10;
      if (!reduced) target[F.antennaShake] = Math.max(target[F.antennaShake], pop);
    }

    // 5. Tracking. A snack in the air owns the face until it lands.
    nearest = playing ? input?.nearest ?? null : null;
    if (nearest) {
      const mouth = input?.creature ?? { x: ARENA.mouth.x, y: ARENA.mouth.y };
      const distance = hypot(nearest.x - mouth.x, nearest.y - mouth.y);
      const closeness = 1 - clamp01((distance - 70) / 460);
      wear("trackFar", 0.75);
      wear("trackNear", closeness * closeness);
    }

    // 6. One-shot reactions, which override whatever mood they land on.
    feed = latest("feed", 1.5);
    miss = latest("miss", 1.2);
    // Only a bounce off its own belly is the creature's business.
    const belly = latest("belly", 0.6);
    if (feed && (!miss || feed.age <= miss.age)) gaze = applyGulp(target, feed, reduced, wear) ?? gaze;
    else if (miss) applyFlinch(target, miss, reduced, wear);
    // The last coin out of a block: a bigger swallow than any ordinary feed.
    const lastPour = recent?.pour ?? null;
    const pourAge = lastPour && input ? (input.tick - lastPour.tick) / 60 : 9;
    if (input && pourAge <= 0.45 && !input.pourInFlight) {
      const k = exp(-pourAge * 6);
      target[F.squashX] += 0.1 * k; target[F.squashY] -= 0.06 * k;
      target[F.cheekPuff] = Math.max(target[F.cheekPuff], 0.9 * k); target[F.bellySwell] += 0.3 * k;
      target[F.pupilScale] = Math.max(target[F.pupilScale], 1 + 0.5 * k);
      target[F.browRaise] = Math.max(target[F.browRaise], k);
      wear("startle", 0.9 * k);
    }
    // A block broken open: eyes wide, brows up, up on its toes for what is coming.
    const block = latest("crateHit", 1.0);
    if (block) {
      const k = exp(-block.age * 2.6);
      target[F.pupilScale] = Math.max(target[F.pupilScale], 1 + 0.65 * k);
      target[F.browRaise] = Math.max(target[F.browRaise], k);
      target[F.bodyRise] += 22 * k;
      wear("startle", 0.8 * k);
    }
    if (belly) {
      const boing = exp(-belly.age * 6) * cos(belly.age * 22);
      target[F.squashY] -= boing * 0.08;
      target[F.squashX] += boing * 0.06;
      wear("startle", exp(-belly.age * 4) * 0.6);
    }
  }

  // A frenzy: the mouth gapes, the eyes go wide, and the whole animal is up.
  if (frenzied) {
    wear("trackNear", 0.5);
    target[F.pupilScale] = Math.max(target[F.pupilScale], 1.3);
    target[F.teethBare] = Math.max(target[F.teethBare], 0.6);
    target[F.browRaise] = Math.max(target[F.browRaise], 0.8);
    target[F.bodyRise] += 8;
    if (!reduced) target[F.shake] = Math.max(target[F.shake], 0.35);
  }
  target[F.frenzy] = frenzied ? 1 : 0;

  // 6b. Above the top step, nothing outranks the temper: the corners and the
  //     width are taken rather than blended, so a reaction can no longer put
  //     a smile on a creature about to take the kitchen apart.
  if (step3 > 0.35) {
    const temper = clamp01((step3 - 0.35) * 1.6);
    wear("annoy3", temper);
    target[F.cornerLift] = Math.min(target[F.cornerLift], -0.35 - 1.15 * temper);
    target[F.mouthWidth] = Math.min(target[F.mouthWidth], 1.02);
    target[F.teethBare] = Math.max(target[F.teethBare], temper);
    target[F.browAngry] = Math.max(target[F.browAngry], temper);
    target[F.lowerLid] = Math.max(target[F.lowerLid], 0.82 * temper);
    target[F.lipPress] = Math.min(target[F.lipPress], 1 - temper);
  }

  // 7. The ending.
  const promoted = input?.failureReason === "outgrew-the-kitchen";
  const enraged = input?.failureReason === "kitchen-destroyed";
  if (ended && input) {
    if (promoted) wear("smug", 1);
    else if (input.failureReason === "empty-belly") wear("collapse", 1);
    else wear("rageEnd", 1);
  }

  // --- layers that sit on top of the expression, not inside it ---

  // Breathing, faster and shallower when irritated.
  const breathRate = 1.05 + rage / 100 * 0.9 - hunger * 0.25;
  const breath = reduced ? 0 : sin(clock * breathRate);
  target[F.breath] = breath;
  target[F.squashY] *= 1 + breath * 0.006;
  target[F.squashX] *= 1 - breath * 0.004;
  target[F.headY] -= breath * 1.4;

  if (geometryOnly) {
    // The head still follows what it watches, and a hungry one nags; the
    // eyes, the skin and the shake are the renderer's.
    if (peckish > 0.05 && !reduced) target[F.headTilt] -= pow(Math.max(0, sin(clock * 1.6)), 5) * peckish * 2;
    if (nearest) {
      const at = input?.creature ?? ARENA.mouth;
      target[F.headTilt] += clamp(-9, 9, (nearest.x - at.x) * 0.022);
      target[F.headX] += clamp(-16, 16, (nearest.x - at.x) * 0.03);
    }
    // The tell runs hot: the cheeks swell before the breath comes.
    if (pepper > 0 && target[F.inhale] > 0.05) target[F.cheekPuff] = Math.max(target[F.cheekPuff], target[F.inhale] * 1.6);
    if (balloon > 0) target[F.bellySwell] = Math.max(target[F.bellySwell], balloon * 0.35);
    body(target, input, playing, ended, levels);
    return { gaze };
  }

  // Where the eyes point. Idle drifts to the launcher; a snack in the air or a
  // mess on the floor takes priority over that.
  target[F.pupilX] = -0.82 + (reduced ? 0 : sin(clock * 0.42) * 0.12);
  target[F.pupilY] = 0.28 + (reduced ? 0 : sin(clock * 0.31) * 0.1);
  if (peckish > 0.05 && !reduced) {
    const nag = pow(Math.max(0, sin(clock * 1.6)), 5);
    target[F.pupilX] -= nag * peckish * 0.25;
    target[F.headTilt] -= nag * peckish * 2;
  }
  if (nearest) {
    target[F.pupilX] = clamp(-1, 1, (nearest.x - 838) / 340);
    target[F.pupilY] = clamp(-1, 1, (nearest.y - 250) / 240);
    const at = input?.creature ?? ARENA.mouth;
    target[F.headTilt] += clamp(-9, 9, (nearest.x - at.x) * 0.022);
    target[F.headX] += clamp(-16, 16, (nearest.x - at.x) * 0.03);
  } else if (playing && input && input.crates && input.crates.length) {
    // Nothing in the air: it watches the block on the chain go by.
    const at = crateAt(input.crates[0], input.tick);
    target[F.pupilX] = clamp(-1, 1, (at.x - 838) / 340);
    target[F.pupilY] = clamp(-1, 1, (at.y - 250) / 240);
  }
  // A block breaking: the eyes snap to it for half a second.
  const broke = latest("crateHit", 0.6);
  if (broke) {
    const look = 1 - clamp01((broke.age - 0.4) / 0.2);
    target[F.pupilX] = mix(target[F.pupilX], clamp(-1, 1, (broke.x - 838) / 300), look);
    target[F.pupilY] = mix(target[F.pupilY], clamp(-1, 1, (broke.y - 250) / 240), look);
  }
  if (miss && miss.age > 0.06) {
    const look = clamp01((miss.age - 0.06) / 0.2);
    target[F.pupilX] = mix(target[F.pupilX], clamp(-1, 1, (miss.x - 838) / 300), look);
    target[F.pupilY] = mix(target[F.pupilY], clamp(-1, 1, (miss.y - 250) / 240), look);
  }
  if (gaze) {
    target[F.pupilX] = mix(target[F.pupilX], gaze.x, gaze.weight);
    target[F.pupilY] = mix(target[F.pupilY], gaze.y, gaze.weight);
  }
  if (step2 > 0.2) target[F.pupilY] = mix(target[F.pupilY], -0.25, step2);
  if (ended && promoted) { target[F.pupilX] = -0.35; target[F.pupilY] = -0.15; }
  if (ended && input?.failureReason === "empty-belly") target[F.pupilY] = 0.3;

  // Skin. These accumulate rather than blend: heat and pallor are conditions.
  target[F.pallor] = hunger * 0.9;
  target[F.rageFlush] = step2 * 0.3 + step3 * 0.7;
  target[F.sweat] = step2 * 0.35 + step3 * 0.5;
  if (pepper > 0) {
    target[F.flush] = Math.max(target[F.flush], 0.3 + pepper * 0.55);
    target[F.cheekMarks] = Math.max(target[F.cheekMarks], 0.4 + pepper * 0.6);
    target[F.sweat] = Math.max(target[F.sweat], 0.25 + pepper * 0.45);
    // The tell runs hot: the cheeks glow before the breath comes.
    if (target[F.inhale] > 0.05) {
      target[F.flush] = Math.max(target[F.flush], 0.5 + target[F.inhale] * 0.5);
      target[F.cheekMarks] = Math.max(target[F.cheekMarks], 0.6 + target[F.inhale] * 0.4);
      target[F.cheekPuff] = Math.max(target[F.cheekPuff], target[F.inhale] * 1.6);
    }
  }
  // Stretched-skin sheen, balloon only, and the swell that goes with it.
  if (balloon > 0) {
    target[F.taut] = Math.max(target[F.taut], 0.35 + balloon * 0.65);
    target[F.bellySwell] = Math.max(target[F.bellySwell], balloon * 0.35);
  }
  if (metal > 0) {
    target[F.magnetism] = Math.max(target[F.magnetism], 0.4 + metal * 0.6);
    target[F.teethAlign] = Math.max(target[F.teethAlign], 0.5 + metal * 0.5);
    target[F.teethLong] = Math.max(target[F.teethLong], metal * 0.55);
    target[F.crackle] = Math.max(target[F.crackle], 0.35 + metal * 0.65);
  }
  if (ended && enraged) {
    target[F.rageFlush] = 1;
    target[F.sweat] = 0.8;
  }
  if (ended && input?.failureReason === "empty-belly") target[F.pallor] = 1;
  if (ended && promoted) { target[F.pallor] = 0; target[F.flush] = 0; target[F.rageFlush] = 0; }

  // Tremors.
  target[F.antennaShake] = Math.max(target[F.antennaShake], step3);
  if (!reduced) target[F.shake] = step3 * 0.7;
  if (ended && enraged) {
    target[F.antennaShake] = 1;
    target[F.shake] = reduced ? 0 : 0.6;
  }

  // The reaction beats add their own skin on top.
  if (feed) gulpSkin(target, feed, reduced);

  body(target, input, playing, ended, levels);
  return { gaze };
}

/**
 * The body is a mechanic, not a mood: growth, lean and the mouth's aperture
 * come straight out of the rules, which move the same channels the
 * expressions use and win where they disagree. Then the limits.
 */
function body(target: Float64Array, input: FaceInput | null, playing: boolean, ended: boolean, levels: MutationLevels) {
  //
  // Growth, lean and the mouth's aperture come straight out of the rules. The
  // rules move the same channels the expressions use, and win where they
  // disagree.
  const creature = input?.creature;
  if (creature && (playing || ended)) {
    const grow = creature.size - 1;
    const open = clamp01(creature.open ?? creature.aperture);
    // While it chews the jaw is the rules' alone: no mood or verdict may prise
    // a shut mouth open wide enough to take a coin.
    target[F.jawOpen] = mix(target[F.jawOpen], open, playing ? (open < 0.999 ? 1 : 0.88) : 0.35);
    target[F.mouthWidth] = mix(target[F.mouthWidth], 0.9 + open * 0.34, playing ? 0.7 : 0.3);
    target[F.lipPress] = mix(target[F.lipPress], open > 0.1 ? 0.1 : 0.75, playing ? 0.7 : 0.3);
    if (open > 0.5) target[F.teethBare] = Math.max(target[F.teethBare], 0.4);
    // The whole body scales about its resting mouth, and the balloon inflates
    // it further. The drawn creature is moved so its mouth lands on the rules'
    // anchor: growth, lift, bob and tracking are all the same operation.
    const balloonLevel = levels.balloon ?? 0;
    const scaleX = (1 + grow * BODY_SCALE_PER_SIZE.x) * (1 + INFLATE_PER_LEVEL.x * balloonLevel);
    const scaleY = (1 + grow * BODY_SCALE_PER_SIZE.y) * (1 + INFLATE_PER_LEVEL.y * balloonLevel);
    target[F.bodyScaleX] = scaleX;
    target[F.bodyScaleY] = scaleY;
    target[F.mouthX] = creature.x;
    target[F.mouthY] = creature.y;
    // The mouth's own scale follows the rules' growth, divided by the body
    // scale it is already riding; in a frenzy it gapes.
    const gape = creature.gape ?? 1;
    target[F.mouthScaleX] = (1 + grow * TUNING.mouthGrowX) / scaleX * (1 + (gape - 1) * 0.55);
    target[F.mouthScaleY] = (1 + grow * TUNING.mouthGrowY) / scaleY * gape;
    // The head still leads a reach.
    const track = creature.track ?? 0;
    target[F.headY] += track * 0.12;
    target[F.headTilt] += track * 0.05;
    target[F.teethLong] = Math.max(target[F.teethLong], clamp01(grow / 1.4) * 0.55);
    // A shut mouth on a big creature is the thing the player is waiting out,
    // so it tightens rather than simply closing.
    if (open < 0.05) target[F.cornerLift] = mix(target[F.cornerLift], -0.35, 0.4 * clamp01(grow / 0.7));
  } else {
    target[F.bodyScaleX] = 1;
    target[F.bodyScaleY] = 1;
    target[F.mouthX] = ARENA.mouth.x;
    target[F.mouthY] = ARENA.mouth.y;
  }

  // Inflation makes it WIDER, not taller, and it does not raise the head.
  if (target[F.bellySwell] !== 0) target[F.squashX] *= 1 + target[F.bellySwell] * 0.14;
  // Hard ceiling on how far the painting may be stretched; the rest is lift.
  const widest = Math.max(target[F.squashX], target[F.squashY]);
  if (widest > 1.14) {
    const trim = 1.14 / widest;
    target[F.squashX] *= trim;
    target[F.squashY] *= trim;
    target[F.bodyRise] += (widest - 1.14) * 150;
  }

  target[F.jawOpen] = clamp01(target[F.jawOpen]);
  target[F.lidLeft] = clamp(0, 0.66, target[F.lidLeft]);
  target[F.lidRight] = clamp(0, 0.66, target[F.lidRight]);
  target[F.lowerLid] = clamp01(target[F.lowerLid]);
  target[F.cornerLift] = clamp(-1.6, 1.4, target[F.cornerLift]);
  target[F.flush] = clamp01(target[F.flush]);
  target[F.rageFlush] = clamp01(target[F.rageFlush]);
  target[F.pallor] = clamp01(target[F.pallor]);
}

/**
 * The catch, as three different beats. Contact is a hard clamp whatever the
 * ingredient; what follows is not. Metal jolts and rings; balloon floats up and
 * settles slowly; pepper swallows cleanly and only then discovers what it ate.
 */
function applyGulp(target: Float64Array, feed: Reaction, reduced: boolean,
                   wear: (name: ExpressionName, weight: number) => void): Gaze | null {
  const age = feed.age;
  if (feed.ingredient === "metal") {
    const contact = exp(-Math.abs(age - 0.04) * 20);
    wear("snap", Math.max(contact, exp(-age * 5)));
    wear("clank", exp(-Math.abs(age - 0.06) * 15));
    const ring = reduced ? 0 : exp(-age * 4.5) * sin(age * 46);
    target[F.headX] += ring * 5;
    target[F.headTilt] += ring * 2.4;
    const recoil = exp(-Math.abs(age - 0.26) * 7);
    target[F.jawOpen] += recoil * 0.3;
    target[F.squashY] += recoil * 0.05;
    target[F.squashX] -= recoil * 0.05;
    target[F.headY] -= recoil * 9;
    target[F.antennaShake] = Math.max(target[F.antennaShake], exp(-age * 3));
  } else if (feed.ingredient === "balloon") {
    const contact = exp(-Math.abs(age - 0.12) * 7);
    wear("snap", Math.max(contact, exp(-age * 2.2)) * 0.85);
    wear("puff", exp(-Math.abs(age - 0.42) * 2.6));
    const float = reduced ? 0 : exp(-age * 1.5) * sin(age * 5.2 - 0.6);
    target[F.bodyRise] += float * 11;
    target[F.headY] -= float * 6;
    target[F.headTilt] += float * 2;
    target[F.cheekPuff] += exp(-Math.abs(age - 0.5) * 2.2) * 0.5;
  } else if (feed.ingredient === "pepper") {
    const contact = exp(-Math.abs(age - 0.05) * 15);
    wear("snap", Math.max(contact, exp(-age * 3)));
    const onset = pow(clamp01((age - 0.16) / 0.34), 0.7);
    const fade = 1 - clamp01((age - 1.05) / 0.4);
    wear("burn", onset * fade);
    if (!reduced) {
      target[F.antennaShake] = Math.max(target[F.antennaShake], onset * fade);
      target[F.shake] = Math.max(target[F.shake], onset * fade * 0.6);
    }
  }

  // The swallow travels: a bulge from the throat down into the belly.
  const travel = clamp01((age - 0.1) / 0.78);
  if (travel > 0 && travel < 1) {
    target[F.throat] = pow(sin(travel * Math.PI), 0.4);
    target[F.throatTravel] = travel;
  }

  // Then the verdict, early and fast enough to be worn before the beat is over.
  const settle = clamp01((age - 0.4) / 0.34);
  if (settle <= 0) return null;
  const verdict = settle * (feed.ingredient === "pepper" ? 0.35 : 1);
  wear(feed.craved ? "delight" : "shrug", verdict);
  target[F.bellySwell] = Math.max(target[F.bellySwell], settle * 0.14);
  return feed.craved
    ? { x: -0.1, y: -0.5, weight: verdict }
    : { x: 1, y: 0.62, weight: verdict };
}

/** Skin changes belonging to a catch, layered after the mood's own. */
function gulpSkin(target: Float64Array, feed: Reaction, reduced: boolean) {
  if (feed.ingredient !== "pepper") return;
  const heat = pow(clamp01((feed.age - 0.16) / 0.34), 0.7) * (1 - clamp01((feed.age - 1.05) / 0.4));
  target[F.flush] = Math.max(target[F.flush], heat);
  target[F.cheekMarks] = Math.max(target[F.cheekMarks], heat * 0.8);
  target[F.sweat] = Math.max(target[F.sweat], heat);
  target[F.tears] = Math.max(target[F.tears], heat * (reduced ? 0.8 : 1));
}

/** A snack on the floor: a flinch away, then a flat side-eye at the mess. */
function applyFlinch(target: Float64Array, miss: Reaction, reduced: boolean,
                     wear: (name: ExpressionName, weight: number) => void) {
  const age = miss.age;
  const jolt = exp(-Math.abs(age - 0.04) * 14);
  const look = clamp01((age - 0.18) / 0.26) * (1 - clamp01((age - 0.95) / 0.4));
  const side = miss.x < ARENA.mouth.x ? -1 : 1;
  wear("flinch", jolt);
  if (miss.type === "bounce") wear("startle", look);
  else {
    wear("mope", look);
    wear("sideEye", clamp01((age - 0.62) / 0.3) * 0.75);
  }
  target[F.headX] -= side * jolt * (reduced ? 5 : 24);
  target[F.headTilt] -= side * jolt * (reduced ? 2 : 7);
  target[F.headX] += side * look * 7;
  if (!reduced) target[F.antennaShake] = Math.max(target[F.antennaShake], jolt);
}

/* ------------------------------------------------------------------ *
 * The rules' half: the geometry channels, sprung in tick time.
 * ------------------------------------------------------------------ */

/**
 * The geometry channels and their velocities, carried on the rules' creature,
 * in `GEOMETRY` order. Plain arrays: they are part of the shift's state.
 */
export interface Face { pose: number[]; velocity: number[] }

const quantize = (value: number) => Math.round(value * 10000) / 10000;
const TICK = 1 / 60;
const GEOMETRY_INDEX = Int32Array.from(GEOMETRY, (field) => F[field]);

/** A creature's face at rest, before its first tick. */
export function restingFace(): Face {
  const neutral = neutralPose();
  return {
    pose: GEOMETRY.map((field) => REST[field] ?? neutral[field]),
    velocity: GEOMETRY.map(() => 0),
  };
}

export function copyFace(face: Face): Face {
  return { pose: face.pose.slice(), velocity: face.velocity.slice() };
}

/** One geometry channel's value, by name. */
export const G = Object.fromEntries(GEOMETRY.map((field, index) => [field, index])) as Record<GeometryChannel, number>;

/** Built on first use: this module and `arcade.ts` import each other, so nothing runs at load. */
let scratch: Float64Array | null = null;
let steadyScratch: Float64Array | null = null;

const STIFFNESS = GEOMETRY.map((field) => (RATES[field] ?? DEFAULT_RATE)[0] * TICK);
const DAMPING = GEOMETRY.map((field) => (RATES[field] ?? DEFAULT_RATE)[1] * TICK);

/**
 * One tick of the rules' face: the targets for this tick, then a spring step
 * per geometry channel with the same stiffness and damping the renderer uses.
 * Quantized, like every other number the rules keep.
 */
export function stepFace(face: Face, input: FaceInput): void {
  const target = scratch ?? (scratch = targetRow());
  faceTargets(target, input, true, false, input.tick / 60, true);
  // An open mouth is a target, and a target the player cannot predict is not
  // a fair one. Its moods shape it — hunger, temper, what it has become, the
  // fire it is holding in, a frenzy — because those are slow and on show. What
  // happens *to* it — the gulp and its verdict, a flinch, a sulk, the head
  // turning after a coin — plays in full on the eyes, brows, teeth and skin
  // (the renderer's), and on the jaws while it chews; while the mouth is open
  // it moves the opening only a little. The head starts settling a few ticks
  // before the jaws part, so the mouth reopens where it was.
  const creature = input.creature;
  if (creature) {
    const steady = steadyScratch ?? (steadyScratch = targetRow());
    faceTargets(steady, input, true, false, input.tick / 60, true, true);
    const fit = TUNING.mouthFit;
    const open = Math.max(creature.open, apertureAhead(creature as never, fit.settle));
    const reacts = fit.react + (1 - fit.react) * (1 - Math.min(1, open));
    for (let i = 0; i < GEOMETRY_INDEX.length; i++) {
      const k = GEOMETRY_INDEX[i];
      target[k] = steady[k] + (target[k] - steady[k]) * reacts;
    }
  }
  const pose = face.pose;
  const speed = face.velocity;
  for (let i = 0; i < GEOMETRY_INDEX.length; i++) {
    const velocity = quantize(speed[i] + (target[GEOMETRY_INDEX[i]] - pose[i]) * STIFFNESS[i] - speed[i] * DAMPING[i]);
    speed[i] = velocity;
    pose[i] = quantize(pose[i] + velocity * TICK);
  }
}
