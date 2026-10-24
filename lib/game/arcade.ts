/**
 * FEAST — the feeding loop.
 *
 * This file is the whole rule set and the only authority on a result. It is
 * pure: a fixed 1/60-second tick, no wall clock, no `Math.random`, no renderer,
 * and every value quantized, so a command trace replays to a byte-identical
 * final state on any machine.
 *
 * The loop is a fast, generous, escalating physics feast. The mouth is open by
 * default and chews for a moment after every catch; a snack that arrives
 * mid-chew clanks off the teeth. The kitchen is a playground of bouncers that
 * multiply a serving. Five catches in a row is a FRENZY. Every serving grows
 * the creature, and growth is the ramp: the belly empties faster, the beats
 * come faster, the mutations stack and never wear off. It always wins.
 *
 * Stage 6, the cannon: each coin flies its own way (`TUNING.flight` —
 * Bitcoin heavy, Ether floaty, HEMI straight), so one barrel setting does not
 * feed every coin; and a crate shuttles on a rail under the ceiling that only
 * its own coin breaks open, pouring three coins into the mouth.
 */
import { bodyField, lipsAt, placeAperture, apertureOf, pointInMouth, swallows, takesCoin, coverage, distanceToMouth, toArena, type BodyChannels, type MouthShape } from "./body.ts";
import { G, copyFace, faceInputOf, restingFace, stepFace, type Face, type FaceInput } from "./face.ts";
import { atan2, cos, hypot, pow, sin } from "./detmath.ts";

export type Ingredient = "metal" | "balloon" | "pepper";
export const FOODS: readonly Ingredient[] = ["metal", "balloon", "pepper"];

/** Bumped whenever a rule, the trace format or the scoring changes. */
export const GAME_VERSION = 10;

/**
 * A static kitchen collider. A serving that comes off one and is then caught is
 * a BANK, and a bank multiplies the serving. `banks` is how many banks one
 * contact is worth: the lamp is the hard one, so it pays double.
 */
export type Bouncer =
  | { name: string; label: string; kind: "circle"; x: number; y: number; r: number; restitution: number; banks: number }
  | { name: string; label: string; kind: "segment"; x1: number; y1: number; x2: number; y2: number; restitution: number; banks: number };

export const BOUNCERS: readonly Bouncer[] = Object.freeze([
  { name: "pan", label: "OFF THE PAN", kind: "circle", x: 320, y: 195, r: 34, restitution: 0.85, banks: 1 },
  { name: "shelf", label: "OFF THE SHELF", kind: "segment", x1: 300, y1: 110, x2: 440, y2: 110, restitution: 0.8, banks: 1 },
  { name: "lamp", label: "OFF THE LAMP", kind: "circle", x: 760, y: 60, r: 26, restitution: 0.9, banks: 2 },
  { name: "chain", label: "OFF THE CHAIN", kind: "segment", x1: 1040, y1: 0, x2: 1040, y2: 110, restitution: 0.75, banks: 1 },
  { name: "pot", label: "OFF THE POT", kind: "circle", x: 540, y: 598, r: 36, restitution: 0.8, banks: 1 },
] as const);

export const ARENA = Object.freeze({
  width: 1200, height: 700, barrelLength: 70, launcher: { x: 210, y: 540 },
  /** Anything this close to the launcher is on the launcher. */
  launcherRadius: 54,
  /**
   * The resting mouth, at size 1: the anchor the creature is placed and grown
   * about, and a rough box for effects. Not the target: that is the opening
   * the face draws (`Creature.mouth`).
   */
  mouth: { x: 840, y: 279, rx: 113, ry: 69 }, floor: 620,
  /** The bench the launcher stands on, in x. A cooked snack landing here lights it. */
  bench: { from: 120, to: 720 },
  tickRate: 60,
  /** Endless in practice; the cap exists so a replay is bounded. Twelve minutes. */
  maxTicks: 43200,
  minAngle: -65, maxAngle: -5,
  /**
   * The default shot: a HEMI at the default charge lands in the resting
   * mouth, so a beginner who never aims still feeds it something.
   */
  defaultAngle: -30,
  /** Half a second between shots; half of that in a frenzy. */
  cooldownTicks: 30, frenzyCooldownTicks: 15, maxProjectiles: 6,
  /** Launch speed. Holding the key charges from `minPower` to `maxPower`. */
  minPower: 9 as number, maxPower: 16 as number, defaultPower: 13 as number, chargeTicks: 40 as number,
  /** The hatch: how long it stays shut, and how long before it can be used again. */
  hatchTicks: 84, hatchCooldown: 210,
  bouncers: BOUNCERS,
  /**
   * The rail under the ceiling the crates ride. A crate hangs on a long chain
   * in the open air left of the creature, under the lamps and above the caption
   * slot: lowered at `from`, it shuttles out towards `to` and back, and is
   * hoisted away. The creature's head takes the right end of the rail as it
   * grows (`crateLane`). `lower` is how long the lowering and the hoisting take.
   */
  rail: { y: 30, from: 420, to: 545, lower: 32 },
});

/**
 * Every number the balance depends on, in one place, so an iteration changes a
 * rule rather than hunting a constant through the file.
 */
export const TUNING = Object.freeze({
  /** Growth. The creature is the difficulty curve. */
  sizeMax: 2.4,
  /**
   * Stage 3 pacing: the escalation is the whole shift, not its first half
   * minute. `growthShape` bends the curve: positive front-loads it (the first
   * servings count most), negative back-loads it (a big creature grows
   * faster). Back-loaded, because the first frenzy gorges it early anyway.
   */
  growthPerFeed: 0.0115,
  growthShape: -0.45,
  growthPauseTicks: 60,
  growthPauseMax: 120,
  /** A `grow` event every time the size crosses one of these steps. */
  growStep: 0.2,

  /**
   * Appetite. The belly drains with size, with time on shift, and with appetite.
   *
   * Paced for a person who is not a gamer: the casual bot's median shift
   * is about three minutes, the never-aiming bot's a little over one. At 0.06
   * the base alone asked for 0.45 servings a second from the first tick, which
   * a casual hand (0.35 a second, measured) never had; the per-minute term is
   * what ends a shift that was holding.
   */
  hungerStart: 76,
  graceTicks: 300,
  drainBase: 0.048,
  drainPerSize: 0.008,
  drainPerMinute: 0.04,
  /**
   * One number per seed: a hungrier or a lazier creature, 0.7–1.3×.
   * Spreads the deaths. At 0.5–1.5× the draw outweighed the player: the same
   * casual hands lasted 65 s on a hungry creature and 230 s on a lazy one.
   */
  temperSpread: 0.6,
  /** Appetite never stops growing, even after the body does. */
  appetitePerFeed: 0.006,
  payPerMinute: 0.75,
  /** The belly line the passive score climbs above and stalls below. */
  payFloor: 30,
  restore: 8,
  restoreCraved: 18,
  /** A bigger belly gets less out of the same serving. */
  restoreShrink: 0.42,
  /** Feeding a creature that is not hungry: it swallows, gets little, grows double. */
  gorgeFrom: 85,
  gorgeRestore: 0.3,
  gorgeGrowth: 2,
  /** Stuffing a full creature is what really raises its appetite. A frenzy is exempt. */
  gorgeAppetite: 5,

  /** The chew: after every catch the mouth is teeth for this long. */
  chewTicks: 36,
  /**
   * The last ticks of a chew, when the jaws part again. Once the gap is wide
   * enough to take a coin it is an opening like any other; until then it is
   * teeth, and a coin on it clanks.
   */
  chewReopen: 10,
  /** How many ticks the jaws take to snap shut on a catch, and how far open "shut" is. */
  chewClose: 3,
  chewShut: 0.02,
  /**
   * The mouth as a target. There is no ring: the opening on screen is the
   * target, and the rules test a coin against exactly the lips that are drawn.
   *
   * `x` widens the drawn opening about its middle; `y` brings its top — the
   * upper lip and the corners — toward the jaw's floor. The painted mouth's
   * grin rides high at the corners, higher than the old inset ring, and at full
   * height it let HEMI's steeper shots in on Ether's angles (stage 6 keeps
   * those lanes apart), so the drawn opening is a little squatter.
   *
   * `coin`/`share`: a coin counts when at least `share` of its face — a
   * disc of radius `coin`, the coin as drawn — is inside the opening. Checked
   * at the end of the tick's move and halfway along it, so a coin that is
   * half in at any moment is swallowed then. At a half, along a lip a coin
   * counts exactly when its centre is past the lip — what a player calls in
   * — and a corner too thin to hold half a coin never takes one. (Two thirds,
   * tried first, refused coins that were visibly in: critic rounds 3–5.)
   *
   * `react`: how much of a one-shot reaction (the gulp and its verdict, a
   * flinch, the head following a coin) still moves the opening while it is
   * open — all of it moves the jaws while it chews. `settle`: how many ticks
   * before the jaws part the head starts coming back, so the mouth reopens
   * where it was.
   *
   * `lipOut`/`lipKick`: a coin that got at least `lipOut` of itself over the
   * open mouth and starts to come away again without going in has met the
   * lip, and is knocked off it — away from the opening at `lipKick` px a tick
   * or more, its slide along the lip damped — once per coin. A near miss is
   * decided at the lip, not by a coin riding it half in.
   */
  mouthFit: { x: 1, y: 0.76, coin: 23, share: 0.5, react: 0.2, settle: 12, lipOut: 0.3, lipKick: 5 },
  /** Presentation: how far open the mouth counts as "open". The rules test the opening itself. */
  openMin: 0.5,
  /** A clank costs almost nothing but the snack and the combo. */
  clankRage: 0.5,
  /** Legacy alias of `clankRage`, read by the current HUD copy. */
  snubRage: 0.5,
  missRage: 3,
  feedRage: 6,
  /** Irritation is a rate, not a ratchet: it cools while you are landing shots. */
  rageCool: 0.01,

  /** Combo and FRENZY. */
  frenzyAt: 5,
  frenzyTicks: 360,
  frenzyScore: 3,
  /**
   * How far the mouth gapes in a frenzy: the opening's height × this, its
   * width by a little over half the extra (`faceTargets`). The gape drawn is
   * the gape that catches.
   */
  frenzyGape: 1.5,
  comboBonus: 20,
  comboBonusMax: 9,
  /** A combo also feeds better: the creature enjoys a rhythm. */
  comboRestore: 0.08,

  /** Banks. */
  floorBank: 1.5,
  bankMults: [2, 3, 4] as readonly number[],
  cookedMult: 2,
  utensilScore: 500,

  /** The chest and belly, at size 1. A trampoline, not a wall. */
  belly: { x: 838, y: 372, rx: 236, ry: 150 },
  bellyBounce: 0.5,
  trampoline: 0.95,
  trampolineMin: 7,

  /** Where the mouth sits, as a function of size. Measured against the rig. */
  leanPerSize: 5.4,
  risePerSize: 48,
  mouthGrowX: 0.237,
  mouthGrowY: 0.456,
  bodyGrow: 0.085,

  /**
   * Mutations: a level lands when an ingredient's servings reach the next of
   * these thresholds (cumulative, per ingredient). Rising, so the first level
   * is quick and the third is a late-shift event. Nothing wears off.
   */
  levelServings: [13, 36, 110] as readonly number[],
  maxLevel: 3,

  /** METAL: a magnet mouth, and cutlery storms. */
  magnetPerLevel: 0.055,
  magnetRange: 300,
  magnetRangePerLevel: 80,
  utensilEvery: 420,
  utensilEveryPerLevel: 90,
  utensilFirst: 120,
  utensilGravity: 0.1,
  utensilJams: 45,

  /** BALLOON: it floats and bobs, and the belly is a trampoline. */
  liftPerLevel: 12,
  liftRate: 0.2,
  bobPerLevel: 10,
  bobPeriod: 240,

  /** PEPPER: fire breath. */
  flameEvery: 540,
  flameEveryPerLevel: 90,
  flameFirst: 180,
  flameTell: 40,
  flameTicks: 50,
  flameHalfAngle: 0.17,
  flameScatter: 0.2,
  flameReach: 0.7,
  flameReachPerLevel: 0.15,
  singeJams: 45,
  benchFireTicks: 180,
  benchFireRage: 0.015,

  /** Cravings, with a clock. */
  cravingTicks: 780,
  cravingTicksMin: 430,
  cravingGap: 120,
  cravingBonus: 260,
  cravingCalm: 13,
  cravingFeed: 8,
  /**
   * The craved coin curves toward the mouth while the craving is up (per tick²,
   * within `cravingPullRange` px of the opening): switching is made easy. Any
   * other coin, while it waits, goes down for `offCraving` of its serving and
   * of its calm: staying put costs something you can see — NOT THAT.
   */
  cravingPull: 0.05,
  cravingPullRange: 340,
  offCraving: 0.5,
  pausePerStreak: 0.25,
  appetiteReliefFrom: 2,
  appetiteRelief: 0.02,
  tantrumRage: 12,
  tantrumJams: 40,
  /** A tantrum is exertion: it burns what it ate. */
  tantrumHunger: 6,

  /** Autonomous beats: what it does between shots, on its own. */
  beatEvery: 620,
  beatEveryPerSize: 150,
  beatJitter: 0.55,
  lungeTell: 54,
  lungeRage: 7,
  lungeHunger: 6,
  lungeJams: 40,
  sneezeJams: 26,
  droolTicks: 660,

  /** Hungry tracking: it leans toward incoming food when the belly is low. */
  trackFrom: 46,
  trackRange: 46,
  trackRate: 0.09,

  /**
   * How each coin flies. Bitcoin is heavy, Ether is gas, HEMI is turbo:
   * `gravity` is per tick²; `lo` and `hi` are its launch speed at the least
   * and the most charge (each coin has its own range, so the charge moves
   * each one by its own amount); `burn` is how far, in pixels, it flies dead
   * straight before gravity takes it. The same barrel and the same charge
   * put each coin somewhere else, so switching coins is re-aiming.
   */
  flight: {
    // Steep lobs: only a full charge reaches the mouth, from −46°…−62° early in a shift.
    metal: { gravity: 0.3, lo: 9, hi: 15, burn: 0 },
    // The middle band: floaty and nearly charge-blind, −31°…−41° early in a shift.
    balloon: { gravity: 0.09, lo: 11, hi: 12.5, burn: 0 },
    // Flat: 300 px dead straight at any charge, then normal; −26°…−32° early.
    pepper: { gravity: 0.16, lo: 14, hi: 18, burn: 300 },
  } as Readonly<Record<Ingredient, Flight>>,

  /**
   * Crates on the rail. A crate of coins shuttles along a rail under the
   * ceiling; its own coin breaks it open, and what was inside pours into the
   * mouth. Seeded, one at a time: the first a few seconds into the shift, the
   * next a gap after the last one is gone. A shuttle is one trip out along
   * the rail and back, and it runs faster as the creature grows.
   */
  crateFirst: 360,
  crateGapMin: 120,
  crateGapMax: 300,
  crateShuttleMin: 170,
  crateShuttleMax: 260,
  /** How long a crate stays on the rail before it is hoisted away. */
  crateLifeMin: 330,
  crateLifeMax: 450,
  /** Where the crate hangs: the y of its centre. */
  crateDropMin: 175,
  crateDropMax: 195,
  crateSwingMin: 6,
  crateSwingMax: 14,
  crateSwingPeriod: 150,
  /**
   * The creature's head takes this much of the rail's right end per unit of
   * growth, so a crate never swings in front of its face; once less than
   * `crateLaneMin` of rail is left, no more crates come.
   */
  crateLaneShrink: 125,
  crateLaneMin: 50,
  /** Collision radius of a crate, before the serving's own. */
  crateRadius: 30,
  /** A coin that is not the crate's own glances off it. */
  crateBounce: 0.55,
  /** Coins inside. Each one is a serving, swallowed whole. */
  crateCoins: 3,
  /** What each coin out of a crate pays, on top of the serving's own multipliers. */
  crateMult: 2,
  /** A coin out of a crate is in the mouth by this age, wherever it was. */
  pourMaxAge: 100,
  /** A coin out of a crate lands in the mouth this many ticks after it comes out. */
  pourArrive: 34,
  /** Ticks between one coin coming out of a crate and the next. */
  pourStagger: 10,
  /** A coin first pops straight up out of the crate, under this fall, for this many ticks... */
  pourPop: 10,
  pourPopGravity: 0.45,
  /** ...at this speed... */
  pourSpeed: 8,
  /**
   * ...then turns, over this many ticks, onto its path into the mouth. The
   * path's "gravity" is negative: it drops fast and levels out, so the coin
   * comes in at mouth height, under the eyes, as if inhaled.
   */
  pourTurn: 6,
  pourGravity: -0.15,
});

/** How a coin flies (`TUNING.flight`). */
export interface Flight { gravity: number; lo: number; hi: number; burn: number }
export const flightOf = (ingredient: Ingredient): Flight => TUNING.flight[ingredient];
/** A coin's launch speed at this charge (power, `minPower`..`maxPower`). */
export function launchSpeed(ingredient: Ingredient, power: number): number {
  const f = flightOf(ingredient);
  const t = (power - ARENA.minPower) / (ARENA.maxPower - ARENA.minPower);
  return f.lo + (f.hi - f.lo) * Math.max(0, Math.min(1, t));
}
/** Ticks a coin launched at this charge flies dead straight: its burn distance at its speed. */
export function straightTicks(ingredient: Ingredient, power: number): number {
  const f = flightOf(ingredient);
  return f.burn > 0 ? Math.round(f.burn / launchSpeed(ingredient, power)) : 0;
}

/**
 * One player input. The trace is the whole record of a run: a launch carries
 * the two things the player chose. The hatch stays in the trace for
 * compatibility; the game is fully playable without it.
 */
export type ArcadeCommand =
  | { tick: number; kind: "launch"; ingredient: Ingredient; angle: number; power: number }
  | { tick: number; kind: "hatch" };

export interface Projectile {
  id: number; ingredient: Ingredient;
  /**
   * `food` is a serving. `junk` is a piece of kitchen metal in a cutlery storm.
   * `pour` is a coin out of a broken crate, on its way into the mouth.
   * `spit` is no longer produced; it stays in the union so an older renderer
   * still type-checks.
   */
  kind: "food" | "junk" | "spit" | "pour";
  x: number; y: number; vx: number; vy: number;
  age: number;
  /** Floor bounces. */
  bounces: number;
  /** Credited bank contacts (bouncers, the vent, a trampoline belly). */
  bank: number;
  /** Bitmask of bouncers already credited, so a snack resting on a shelf is paid once. */
  hitMask: number;
  /** Name of the last surface it came off. Presentation. */
  lastSurface: string;
  /** Name of the last surface that was credited as a bank. The bank label. */
  lastBank: string;
  hazardBounces: number; assisted: boolean;
  /** It passed through fire breath. Worth double. */
  cooked: boolean;
  /** It clanked off the teeth. Still flies, feeds nothing, costs nothing more. */
  spent: boolean;
  /** How much of it was over the open mouth at the end of its last move (0–1). */
  cover?: number;
  /** It came off a lip once already: one lip-out per coin. */
  lipped?: boolean;
  /** The crate it hit, on the tick it hit it. */
  crateId?: number;
  /** Ticks it flies dead straight from launch (HEMI's burn). */
  straight?: number;
  /** A coin out of a crate: the age at which it lands in the mouth (it comes out at age 1). */
  arrive?: number;
}

export interface MutationLevels { metal: number; balloon: number; pepper: number }

/** Something the creature has telegraphed. */
export interface Threat { kind: "spit" | "lunge" | "flame"; tick: number; x: number; y: number }

/** A craving, with the clock the player is deciding against. */
export interface Craving { ingredient: Ingredient; startedAt: number; endsAt: number }

/** The kitchen damage the creature has done, which does not repair itself. */
export interface Vent { since: number }

/**
 * A crate of coins on the rail. Where it is at any tick is a pure function of
 * these numbers (`crateAt`), so the probe, the guide and the bots can see it
 * coming exactly as the rules will move it.
 */
export interface Crate {
  id: number;
  /** What is inside. */
  ingredient: Ingredient;
  /** The tick it came down through the hatch. */
  born: number;
  /** Ticks for one shuttle: out along the rail and back. */
  shuttle: number;
  /** The stretch of rail it shuttles along, fixed when it comes down. */
  lo: number; hi: number;
  /** Ticks on the rail, hoisting included. */
  life: number;
  /** The y of its centre: how long its cable is. */
  drop: number;
  /** How far it swings either side of its hook, and where in the swing it started (0..1). */
  swing: number; phase: number;
  /** Ticks before the next crate, once this one is broken or gone. */
  gap: number;
}

/**
 * Where a crate is at `tick`: its hook shuttles along the rail and back, the
 * crate swings under it like a pendulum (rising a little at each end of the
 * swing), and it is lowered at the start and hoisted at the end.
 */
export function crateAt(crate: Crate, tick: number): { x: number; y: number; hookX: number } {
  const t = tick - crate.born;
  const { lower } = ARENA.rail;
  const hookX = crate.lo + (crate.hi - crate.lo) * (1 - cos(2 * Math.PI * t / crate.shuttle)) / 2;
  const offset = crate.swing * sin(2 * Math.PI * (t / TUNING.crateSwingPeriod + crate.phase));
  const cable = Math.max(1, crate.drop - ARENA.rail.y);
  const down = Math.min(1, t / lower);
  const up = Math.max(0, Math.min(1, (t - (crate.life - lower)) / lower));
  const hang = (1 - pow(1 - down, 2)) * (1 - up * up);
  const y = ARENA.rail.y + (crate.drop - ARENA.rail.y) * hang - offset * offset / (2 * cable) * hang;
  return { x: quantize(hookX + offset * hang), y: quantize(y), hookX: quantize(hookX) };
}

/** Fire breath in progress: the tell, then the cone. */
export interface Flame {
  /** The cone starts here; before it, the creature is inhaling. */
  tellUntil: number;
  /** The cone ends here. */
  until: number;
  /** Direction of the cone, radians, from the mouth. */
  angle: number;
  /** Length of the cone, pixels. */
  length: number;
}

/**
 * The creature, as the rules see it. The renderer reads exactly this — scale,
 * position, aperture and the channels — rather than being told which face to pull.
 */
export interface Creature {
  size: number;
  /**
   * The mouth's anchor and rough half-axes in arena space, after growth, lean,
   * lift and bob: where effects and the bots' first guesses aim. The target
   * itself is `mouth`.
   */
  x: number; y: number; rx: number; ry: number;
  /** The chest and belly below the mouth. A trampoline. */
  bx: number; by: number; brx: number; bry: number;
  /** 0 shut, 1 as wide as it goes. Open by default; it shuts to chew. */
  aperture: number;
  /** Same as `aperture`. Kept for the renderer. */
  open: number;
  /** The mouth is teeth until this tick. */
  chewUntil: number;
  /** Ticks until the chew ends; -1 while the mouth is open. */
  untilOpen: number;
  /** The frenzy gape the face opens to (`TUNING.frenzyGape`); 1 otherwise. */
  gape: number;
  /** Vertical tracking offset: it leans toward food when it is hungry. */
  track: number;
  /** How far the balloon has floated it off the counter, in pixels. */
  lift: number;
  /** The bob on top of the lift, in pixels, positive is up. */
  bob: number;
  /** Irritation as a 0..1 channel for the face. */
  flush: number;
  /** Hunger as a 0..1 channel for the face: 1 is starving. */
  brow: number;
  /** Legacy channels, always 0 now. Kept so an older renderer type-checks. */
  pressure: number; clog: number;
  /**
   * The face's geometry channels — jaw, lips, head, body — sprung in tick time.
   * They decide the mouth's shape and where the skin around it sits, so they
   * are rules: the renderer draws exactly these during a shift.
   */
  face: Face;
  /** The opening as it is this tick, in arena space. Food inside it is swallowed. */
  mouth: MouthShape;
  /** The opening as it would be fully open, with the same mood: the jaws. The chest starts below its lower lip. */
  muzzle: MouthShape;
}

export interface ArcadeEvent {
  id: number; tick: number;
  type: "launch" | "feed" | "miss" | "chew" | "clank" | "bounce" | "bank" | "frenzy"
  | "utensil" | "cooked" | "fire" | "flame" | "jam" | "mutation" | "grow" | "craving"
  | "tantrum" | "beat" | "hatch" | "block" | "end" | "crate" | "lip"
  // Legacy types, no longer emitted. Kept so an older renderer type-checks.
  | "snub" | "clog" | "sneeze" | "spit" | "hit" | "burp" | "gust";
  x: number; y: number; label: string;
  /** Presentation-only tag. Never read by the rules, replay or scoring. */
  ingredient?: Ingredient;
  /** Presentation-only tag: the craving matched on an accepted serving. */
  craved?: boolean;
  /** Presentation-only payload: points, a multiplier, a duration, a size. */
  value?: number;
  /** Presentation-only payload: a surface name, a cause, start/end. */
  name?: string;
}

export interface ArcadeState {
  seed: number; tick: number; phase: "playing" | "lost";
  failureReason: "empty-belly" | "kitchen-destroyed" | "outgrew-the-kitchen" | null;
  creature: Creature;
  /** Mirror of `creature.size`, kept at the top level for the HUD and harness. */
  size: number;
  /** Multiplier on appetite. Rises with every serving. */
  appetite: number;
  wanted: Ingredient; hunger: number; rage: number; score: number;
  /** Consecutive catches. A miss or a clank resets it. */
  combo: number; bestCombo: number;
  /** FRENZY runs until this tick. */
  frenzyUntil: number; frenzies: number;
  totalFeeds: number; correctFeeds: number; shots: number; misses: number; clanks: number;
  banks: number; cooked: number; utensils: number;
  /** Legacy counter, always 0 now. Kept so an older HUD type-checks. */
  snubs: number;
  servings: Record<Ingredient, number>; mutationEvents: number; lastLaunchTick: number;
  growthPausedUntil: number;
  /** Permanent, stacking. Zero means the creature has not eaten three yet. */
  mutations: MutationLevels;
  /**
   * The trait it came in with: the community's dominant coin of the last epoch
   * anyone fed it, as that mutation at level 1 from tick 0. Null in practice.
   * Fixed for the shift; the trace does not carry it, the ticket does.
   */
  inherited: Ingredient | null;
  /** Ticks the launcher is jammed for. */
  reloadUntil: number;
  /** Next cutlery storm piece, next fire breath, next autonomous beat. */
  junkAt: number; flameAt: number; beatAt: number;
  flame: Flame | null;
  /** The bench burns until this tick. */
  benchFireUntil: number;
  threat: Threat | null;
  craving: Craving | null;
  cravingNextAt: number;
  cravingsMet: number; cravingsMissed: number; cravingStreak: number;
  /** The hatch. Shut until `hatchClosedUntil`, unusable until `hatchReadyAt`. */
  hatchClosedUntil: number; hatchReadyAt: number; hatchSaves: number;
  /** Legacy, always 0. Kept so an older HUD type-checks. */
  hungerDebt: number;
  /** Tick the one last serving was granted on, or -1 while it is unspent. */
  lastServingAt: number;
  /** Ticks spent with the belly above the pay line. */
  paidTicks: number;
  lastServingSpent: boolean;
  /** Drool on the floor: snacks keep their speed and get a second bounce until this tick. */
  slickUntil: number;
  /** The vent it bit off, once it has. */
  vent: Vent | null;
  /** Crates on the rail right now, the tick the next one comes out, and how many were broken or got away. */
  crates: Crate[]; crateAt: number; cratesBroken: number; cratesLost: number;
  /** Which of the escalating fail screens this run earned. */
  ending: number;
  announcement: string;
  /** Seeded draw counters. One stream per subsystem. */
  rolls: { rhythm: number; craving: number; beat: number; flame: number; junk: number; crate: number };
  /** Presentation-only: the launcher's charge, mirrored for the HUD. */
  charge: number;
  projectiles: Projectile[]; events: ArcadeEvent[]; nextEventId: number; nextProjectileId: number;
}

const MAX_EVENTS = 48;
const LIFE_TICKS = 300;
const FOOD_RADIUS = 10;
const MAX_COMMANDS = Math.ceil(ARENA.maxTicks / ARENA.frenzyCooldownTicks)
  + Math.ceil(ARENA.maxTicks / ARENA.hatchCooldown) + 2;

/**
 * How the shift ends, by how big it got. None of these may name a cause of
 * death; they describe the size it reached and nothing else.
 */
export const ENDINGS: readonly string[] = [
  "It has eaten the employee handbook.",
  "It has eaten the shift supervisor.",
  "It no longer fits behind the counter.",
  "It no longer fits through the door. It has been promoted.",
];
export function endingFor(size: number): number {
  const t = clamp01((size - 1) / (TUNING.sizeMax - 1));
  if (t < 0.3) return 0;
  if (t < 0.6) return 1;
  if (t < 0.88) return 2;
  return 3;
}

export const MUTATION_LABELS: Record<Ingredient, string> = {
  metal: "MAGNET MOUTH · metal curves in, and so does the cutlery",
  balloon: "BALLOON BELLY · it floats, and the belly bounces",
  pepper: "FIRE BREATH · it cooks what it breathes on",
};
export const MUTATION_NAMES: Record<Ingredient, string> = {
  metal: "Magnet mouth", balloon: "Balloon belly", pepper: "Fire breath",
};
export const MUTATION_RULES: Record<Ingredient, string> = {
  metal: "Metal snacks curve in. Forks fly. A fork in the mouth is a bonus.",
  balloon: "It floats and bobs. Bounce a snack off the belly, into the mouth.",
  pepper: "Fire breath cooks a snack for double. Mind the bench.",
};

/**
 * How much fullness the belly loses per tick, right now. A readout, not a
 * rule: it computes exactly the expression `stepArcade` applies.
 */
export function drainPerTick(state: ArcadeState): number {
  return drainAt(state, state.tick);
}

/** The drain at `tick`, as it stands: what a prediction empties the belly by as its flight goes on. */
function drainAt(state: Pick<ArcadeState, "creature" | "appetite" | "seed">, tick: number): number {
  if (tick <= TUNING.graceTicks) return 0;
  return quantize((TUNING.drainBase + (state.creature.size - 1) * TUNING.drainPerSize
    + TUNING.drainPerMinute * (tick / (60 * ARENA.tickRate)))
    * (state.appetite ?? 1) * temperOf(state.seed));
}

export function payRate(paidTicks: number): number {
  return quantize(1 + (paidTicks / (60 * ARENA.tickRate)) * TUNING.payPerMinute);
}

/** Whether the mouth is in a frenzy right now. */
export const inFrenzy = (state: Pick<ArcadeState, "tick" | "frenzyUntil">) => state.tick < state.frenzyUntil;

/** Ticks between shots, right now. */
export const cooldownFor = (state: Pick<ArcadeState, "tick" | "frenzyUntil">) =>
  inFrenzy(state) ? ARENA.frenzyCooldownTicks : ARENA.cooldownTicks;

/**
 * What a serving's bank contacts multiply it by. Floor-only is a lesser bank;
 * one bouncer doubles, two triple, three or more quadruple.
 */
export function bankMultiplier(bank: number, bounces: number): number {
  if (bank <= 0) return bounces > 0 ? TUNING.floorBank : 1;
  return TUNING.bankMults[Math.min(TUNING.bankMults.length, bank) - 1];
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const clamp01 = (value: number) => clamp(value, 0, 1);
const quantize = (value: number) => Math.round(value * 10000) / 10000;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Seeded draws. A counter-based hash rather than a running generator: a
 * stream's n-th value depends only on the seed, the stream and n.
 */
function roll(seed: number, stream: number, counter: number): number {
  let x = (seed ^ Math.imul(stream, 0x9e3779b1) ^ Math.imul(counter, 0x85ebca6b)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}
const STREAM = { rhythm: 1, craving: 2, beat: 3, flame: 4, junk: 5, crate: 6 } as const;

/** One number per seed: how hungry a creature you drew. */
const temperOf = (seed: number) => quantize(1 - TUNING.temperSpread / 2 + TUNING.temperSpread * roll(seed, STREAM.rhythm, 7777));
/** One number per seed: where in its bob the creature starts. */
const bobPhaseOf = (seed: number) => roll(seed, STREAM.rhythm, 4242);

function event(state: ArcadeState, type: ArcadeEvent["type"], x: number, y: number, label: string,
               extra?: { ingredient?: Ingredient; craved?: boolean; value?: number; name?: string }) {
  state.events.push({ id: state.nextEventId++, tick: state.tick, type, x: quantize(x), y: quantize(y), label, ...extra });
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
}

/** A new craving, drawn from the seed. Never the one it just had. */
function nextCraving(state: ArcadeState): Craving {
  const counter = state.rolls.craving;
  state.rolls.craving += 1;
  const previous = state.craving?.ingredient ?? state.wanted;
  const pick = Math.floor(roll(state.seed, STREAM.craving, counter * 2) * 2);
  const options = FOODS.filter((food) => food !== previous);
  const ingredient = options[Math.min(options.length - 1, pick)];
  const span = mix(TUNING.cravingTicks, TUNING.cravingTicksMin, sizeT(state.creature.size))
    * (0.82 + 0.36 * roll(state.seed, STREAM.craving, counter * 2 + 1));
  return { ingredient, startedAt: state.tick, endsAt: state.tick + Math.round(span) };
}

/** How far along the growth curve the creature is, 0 at birth and 1 at the cap. */
const sizeT = (size: number) => clamp01((size - 1) / (TUNING.sizeMax - 1));

/**
 * The aperture during a chew, from the ticks left in it. Shuts fast, holds,
 * opens over the last ten ticks so the reopening is a telegraph of its own.
 * The rules do not read this number: they test coins against the opening it
 * shapes (`shapeMouth`).
 */
function chewAperture(remaining: number): number {
  const total = TUNING.chewTicks;
  const elapsed = total - remaining;
  // Snaps shut over the first ticks, holds shut, parts over the last ones.
  if (elapsed < TUNING.chewClose) return quantize(mix(1, TUNING.chewShut, (elapsed + 1) / TUNING.chewClose));
  if (remaining < TUNING.chewReopen) return quantize(mix(TUNING.chewShut, 1, (TUNING.chewReopen - remaining) / TUNING.chewReopen));
  return TUNING.chewShut;
}

/**
 * What the aperture will be `ticksAhead` from now. A readout for the renderer:
 * the mouth is open unless it is chewing, and the chew has a known end.
 */
export function apertureAhead(creature: Creature, ticksAhead: number): number {
  if (!Number.isFinite(ticksAhead) || ticksAhead < 0) return creature.open;
  const remaining = creature.untilOpen - Math.round(ticksAhead);
  if (creature.untilOpen < 0 || remaining <= 0) return 1;
  return chewAperture(remaining);
}

/** Where the mouth sits for a given size, before tracking, lift and bob. */
function mouthFor(size: number) {
  const grow = size - 1;
  const body = 1 + grow * TUNING.bodyGrow;
  return {
    x: quantize(ARENA.mouth.x - grow * TUNING.leanPerSize),
    y: quantize(ARENA.mouth.y - grow * TUNING.risePerSize),
    rx: quantize(ARENA.mouth.rx * (1 + grow * TUNING.mouthGrowX)),
    ry: quantize(ARENA.mouth.ry * (1 + grow * TUNING.mouthGrowY)),
    // The belly rises with the mouth, so the chest never climbs into the
    // flight path as the creature grows: the mouth's bottom lip stays clear.
    bx: quantize(TUNING.belly.x - grow * TUNING.leanPerSize * 0.6),
    by: quantize(TUNING.belly.y - grow * TUNING.risePerSize),
    brx: quantize(TUNING.belly.rx * body),
    bry: quantize(TUNING.belly.ry * body),
  };
}

function makeCreature(): Creature {
  const placed = mouthFor(1);
  const face = restingFace();
  const creature: Creature = {
    size: 1, ...placed, aperture: 1, open: 1, chewUntil: 0, untilOpen: -1, gape: 1,
    track: 0, lift: 0, bob: 0, flush: 0, brow: 0, pressure: 0, clog: 0,
    face, mouth: null as unknown as MouthShape, muzzle: null as unknown as MouthShape,
  };
  shapeMouth(creature, false);
  return creature;
}

/**
 * The mouth's shape from the face: the aperture its channels describe, moved
 * by the part of the body warp that reaches the mouth, then scaled and placed
 * the way the creature layer is drawn. `muzzle` is the same with the jaw fully
 * open — where the teeth are when it is shut.
 */
function shapeMouth(creature: Creature, chewing: boolean): void {
  const pose = bodyOf(creature.face);
  const scaleX = creature.face.pose[G.bodyScaleX];
  const scaleY = creature.face.pose[G.bodyScaleY];
  creature.mouth = toArena(placeAperture(apertureOf(pose, TUNING.mouthFit), bodyField(pose)), creature.x, creature.y, scaleX, scaleY);
  // The jaws only matter while it chews; open, they are the mouth.
  if (chewing) {
    pose.jawOpen = 1;
    creature.muzzle = toArena(placeAperture(apertureOf(pose, TUNING.mouthFit), bodyField(pose)), creature.x, creature.y, scaleX, scaleY);
  } else {
    creature.muzzle = creature.mouth;
  }
}

/** The face's channels by name, in one reused object: the shape is read straight off it. */
const bodyScratch: BodyChannels = {
  jawOpen: 0, mouthWidth: 1, cornerLift: 0, lipPress: 0, jawShift: 0, mouthScaleX: 1, mouthScaleY: 1,
  headX: 0, headY: 0, headTilt: 0, lean: 0, squashX: 1, squashY: 1, bodyRise: 0,
  cheekPuff: 0, throat: 0, throatTravel: 0,
};
function bodyOf(face: Face): BodyChannels {
  const p = face.pose;
  const b = bodyScratch;
  b.jawOpen = p[G.jawOpen]; b.mouthWidth = p[G.mouthWidth]; b.cornerLift = p[G.cornerLift];
  b.lipPress = p[G.lipPress]; b.jawShift = p[G.jawShift]; b.mouthScaleX = p[G.mouthScaleX];
  b.mouthScaleY = p[G.mouthScaleY]; b.headX = p[G.headX]; b.headY = p[G.headY]; b.headTilt = p[G.headTilt];
  b.lean = p[G.lean]; b.squashX = p[G.squashX]; b.squashY = p[G.squashY]; b.bodyRise = p[G.bodyRise];
  b.cheekPuff = p[G.cheekPuff]; b.throat = p[G.throat]; b.throatTravel = p[G.throatTravel];
  return b;
}

/** A deep copy of a creature, for a prediction or a view that must not share the live face. */
export function copyCreature(creature: Creature): Creature {
  const mouth = { ...creature.mouth };
  return { ...creature, face: copyFace(creature.face), mouth,
    muzzle: creature.muzzle === creature.mouth ? mouth : { ...creature.muzzle } };
}

/**
 * A fresh shift. `inherited` is the mutation it starts with at level 1 — the
 * community's doing, not this shift's: `servings` stay at zero, no mutation
 * event fires, and the next level lands at the normal threshold because a
 * level never goes away. The first storm or flame is scheduled as on a real
 * level-up, so the trait shows itself a legible moment in.
 */
export function createArcade(seed: number, inherited: Ingredient | null = null): ArcadeState {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Invalid arcade seed");
  if (inherited !== null && !FOODS.includes(inherited)) throw new Error("Unknown inherited trait");
  const creature = makeCreature();
  const state: ArcadeState = {
    seed, tick: 0, phase: "playing", failureReason: null,
    creature, size: 1, appetite: 1,
    wanted: "metal", hunger: TUNING.hungerStart, rage: 0, score: 0, combo: 0, bestCombo: 0,
    frenzyUntil: 0, frenzies: 0,
    totalFeeds: 0, correctFeeds: 0, shots: 0, misses: 0, clanks: 0, banks: 0, cooked: 0, utensils: 0, snubs: 0,
    servings: { metal: 0, balloon: 0, pepper: 0 }, mutationEvents: 0,
    lastLaunchTick: -ARENA.cooldownTicks, growthPausedUntil: 0,
    mutations: { metal: 0, balloon: 0, pepper: 0 },
    reloadUntil: 0, junkAt: TUNING.utensilEvery, flameAt: TUNING.flameEvery,
    beatAt: TUNING.beatEvery, flame: null, benchFireUntil: 0, threat: null,
    craving: null, cravingNextAt: 180, cravingsMet: 0, cravingsMissed: 0, cravingStreak: 0,
    hatchClosedUntil: 0, hatchReadyAt: 0, hatchSaves: 0, hungerDebt: 0,
    lastServingAt: -1, lastServingSpent: false, paidTicks: 0,
    slickUntil: 0, vent: null, ending: 0, charge: 0,
    crates: [], crateAt: TUNING.crateFirst, cratesBroken: 0, cratesLost: 0,
    announcement: "Feed it. Not while it is chewing.",
    rolls: { rhythm: 0, craving: 0, beat: 0, flame: 0, junk: 0, crate: 0 },
    inherited,
    projectiles: [], events: [], nextEventId: 1, nextProjectileId: 1,
  };
  if (inherited) {
    state.mutations[inherited] = 1;
    if (inherited === "metal") state.junkAt = TUNING.utensilFirst;
    if (inherited === "pepper") state.flameAt = TUNING.flameFirst;
  }
  stepCreature(creature, seed, 0, 0, state.hunger, null, state.mutations, false, faceInputOf(state, false));
  return state;
}

/**
 * Advances the creature one tick: lift and bob, the chew, the body.
 *
 * `nearest` is the food it would lean toward, or null. Tracking only happens
 * when the belly is low, which makes a desperate creature easier to feed.
 */
function stepCreature(creature: Creature, seed: number, tick: number, rage: number, hunger: number,
                      nearest: Projectile | null, levels: MutationLevels, frenzy: boolean, face: FaceInput): void {
  // Balloon. It floats to a height set by its level and bobs there; the bob is
  // seeded so two players on one seed face the same creature.
  const liftTarget = TUNING.liftPerLevel * levels.balloon;
  creature.lift = quantize(creature.lift + clamp(liftTarget - creature.lift, -TUNING.liftRate, TUNING.liftRate));
  creature.bob = levels.balloon > 0
    ? quantize(TUNING.bobPerLevel * levels.balloon * sin(2 * Math.PI * (tick / TUNING.bobPeriod + bobPhaseOf(seed))))
    : 0;

  // The chew. The mouth is teeth until `chewUntil`; a frenzy does not chew.
  const chewing = !frenzy && tick < creature.chewUntil;
  creature.untilOpen = chewing ? creature.chewUntil - tick : -1;
  creature.aperture = chewing ? chewAperture(creature.chewUntil - tick) : 1;
  creature.open = creature.aperture;
  creature.gape = frenzy ? TUNING.frenzyGape : 1;

  const placed = mouthFor(creature.size);
  creature.rx = placed.rx;
  creature.ry = placed.ry;
  creature.x = placed.x;
  creature.brx = placed.brx;
  creature.bry = placed.bry;
  creature.bx = placed.bx;

  const eager = clamp01((TUNING.trackFrom - hunger) / TUNING.trackFrom);
  let want = 0;
  if (nearest && eager > 0.02 && nearest.x > 380) {
    want = clamp(nearest.y - placed.y, -TUNING.trackRange, TUNING.trackRange) * eager;
  }
  creature.track = quantize(creature.track + (want - creature.track) * TUNING.trackRate);
  creature.y = quantize(placed.y + creature.track - creature.lift - creature.bob);
  creature.by = quantize(placed.by + creature.track * 0.4 - creature.lift - creature.bob);
  creature.flush = quantize(clamp01(rage / 100));
  creature.brow = quantize(clamp01((60 - hunger) / 60));

  // The face, then the mouth it makes. Last, so it reads this tick's body.
  stepFace(creature.face, face);
  shapeMouth(creature, chewing);
}

function makeProjectile(id: number, ingredient: Ingredient, angle: number, power: number): Projectile {
  const radians = angle * Math.PI / 180;
  const speed = launchSpeed(ingredient, power);
  return {
    id, ingredient, kind: "food",
    x: quantize(ARENA.launcher.x + cos(radians) * ARENA.barrelLength),
    y: quantize(ARENA.launcher.y + sin(radians) * ARENA.barrelLength),
    vx: quantize(cos(radians) * speed), vy: quantize(sin(radians) * speed),
    age: 0, bounces: 0, bank: 0, hitMask: 0, lastSurface: "", lastBank: "", hazardBounces: 0,
    assisted: false, cooked: false, spent: false,
    straight: straightTicks(ingredient, power),
  };
}

const cleanPower = (power: number) =>
  Math.round(clamp(Number.isFinite(power) ? power : ARENA.defaultPower, ARENA.minPower, ARENA.maxPower));

/**
 * A piece of kitchen metal torn off a wall by the magnet. Three seeded
 * origins: across the kitchen from the left wall, down from the ceiling on the
 * creature's side, and straight down onto the launcher.
 */
function makeUtensil(id: number, seed: number, counter: number): Projectile {
  const u = roll(seed, STREAM.junk, counter * 3);
  const v = roll(seed, STREAM.junk, counter * 3 + 1);
  let x: number; let y: number; let vx: number; let vy: number;
  if (u < 0.5) {
    x = 70; y = 120 + v * 300; vx = 3 + v * 2.5; vy = -3 + v * 2;
  } else if (u < 0.78) {
    x = 900 + v * 200; y = -10; vx = -2 - v * 2; vy = 0;
  } else {
    x = 160 + v * 110; y = -10; vx = (v - 0.5) * 1.5; vy = 0;
  }
  return {
    id, ingredient: "metal", kind: "junk",
    x: quantize(x), y: quantize(y), vx: quantize(vx), vy: quantize(vy),
    age: 0, bounces: 0, bank: 0, hitMask: 0, lastSurface: "", lastBank: "", hazardBounces: 0,
    assisted: true, cooked: false, spent: false,
  };
}

/**
 * Angle and power are quantized here; save the same rounded values in a replay
 * command. Power is the launch speed.
 */
export function launchFood(state: ArcadeState, ingredient: Ingredient, angle: number,
                           power: number = ARENA.defaultPower): boolean {
  if (!FOODS.includes(ingredient)) throw new Error("Unknown ingredient");
  if (!Number.isFinite(angle)) throw new Error("Invalid launch angle");
  if (state.phase !== "playing" || state.tick - state.lastLaunchTick < cooldownFor(state) ||
      state.tick < state.reloadUntil || state.tick < state.hatchClosedUntil ||
      state.projectiles.filter((item) => item.kind === "food").length >= ARENA.maxProjectiles) return false;
  const food = makeProjectile(state.nextProjectileId++, ingredient,
    Math.round(clamp(angle, ARENA.minAngle, ARENA.maxAngle)), cleanPower(power));
  // Launched through a bench fire: cooked for free.
  if (state.tick < state.benchFireUntil) {
    food.cooked = true;
    state.cooked += 1;
  }
  state.projectiles.push(food);
  state.lastLaunchTick = state.tick;
  state.shots++;
  event(state, "launch", food.x, food.y, ingredient, { ingredient });
  if (food.cooked) event(state, "cooked", food.x, food.y, "COOKED", { ingredient });
  return true;
}

/**
 * The hatch. Kept for compatibility: it shuts the serving hatch, which blocks
 * a lunge and a singe, and locks the launcher while it is down. Nothing in the
 * game requires it.
 */
export function slamHatch(state: ArcadeState): boolean {
  if (state.phase !== "playing" || state.tick < state.hatchReadyAt) return false;
  state.hatchClosedUntil = state.tick + ARENA.hatchTicks;
  state.hatchReadyAt = state.tick + ARENA.hatchCooldown;
  if (state.threat && state.threat.kind === "lunge") {
    state.threat = null;
    state.announcement = "The hatch comes down. It thinks better of it.";
    event(state, "hatch", ARENA.launcher.x, ARENA.launcher.y - 70, "HATCH — LUNGE STOPPED");
    state.hatchSaves += 1;
    state.score += 150;
  } else {
    event(state, "hatch", ARENA.launcher.x, ARENA.launcher.y - 70, "HATCH");
  }
  return true;
}

export interface KitchenHazard { x: number; y: number; width: number; height: number; warning: boolean }

/**
 * The vent flap. It only exists once the creature has bitten it off the wall,
 * which it does when a lunge is not stopped. It is damage, it is permanent,
 * and it is one more thing to bank a serving off.
 */
export function getHazard(vent: Vent | null, tick: number): KitchenHazard | null {
  if (!vent) return null;
  const since = tick - vent.since;
  const phase = Math.max(0, since - 120) % 300 / 300;
  // It swings under the ceiling, above the direct line to the mouth, so it is
  // one more thing a lob can come off rather than a wall across the kitchen.
  const center = 100 + 60 * (1 - 4 * Math.abs(phase - 0.5));
  return { x: 620, y: quantize(center - 45), width: 16, height: 90, warning: since < 120 };
}

/** The flame cone, for the renderer and the rules alike. Null when it is not breathing. */
export interface FlameCone { x: number; y: number; angle: number; half: number; length: number; telling: boolean }
export function flameCone(state: Pick<ArcadeState, "tick" | "flame" | "creature">): FlameCone | null {
  const flame = state.flame;
  if (!flame || state.tick >= flame.until) return null;
  const c = state.creature;
  return {
    x: quantize(c.x - c.rx * 0.6), y: c.y, angle: flame.angle, half: TUNING.flameHalfAngle,
    length: flame.length, telling: state.tick < flame.tellUntil,
  };
}

function insideCone(cone: FlameCone, x: number, y: number): boolean {
  const dx = x - cone.x;
  const dy = y - cone.y;
  const distance = hypot(dx, dy);
  if (distance > cone.length || distance < 1) return false;
  let delta = atan2(dy, dx) - cone.angle;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return Math.abs(delta) <= cone.half;
}

/**
 * Everything outside a projectile that its flight depends on. Passing this
 * explicitly is what lets the prediction and the live rules share one physics
 * step without the prediction being able to touch the state.
 */
interface Env {
  tick: number;
  mouthX: number; mouthY: number; mouthRx: number; mouthRy: number; gape: number;
  /** The opening this tick, and the jaws around it. */
  mouth: MouthShape; muzzle: MouthShape;
  /** Chewing, and the jaws too close together to take a coin: the mouth is teeth. */
  teeth: boolean;
  bellyX: number; bellyY: number; bellyRx: number; bellyRy: number;
  chewing: boolean;
  slick: boolean;
  vent: Vent | null;
  levels: MutationLevels;
  crates: readonly Crate[];
  /** The coin it is craving this tick, if any: that coin is pulled in. */
  craving: Ingredient | null;
}

/**
 * Whether the mouth is teeth right now: chewing, with the jaws too nearly shut
 * to take a coin. A coin on its lips clanks. For the renderer; the rules read
 * the same test off `Env.teeth`.
 */
export function mouthIsTeeth(creature: Pick<Creature, "untilOpen" | "mouth">): boolean {
  return creature.untilOpen > 0 && !takesCoin(creature.mouth, TUNING.mouthFit.coin, TUNING.mouthFit.share);
}

function envOf(state: ArcadeState): Env {
  const c = state.creature;
  const chewing = !inFrenzy(state) && state.tick < c.chewUntil;
  return {
    tick: state.tick, mouthX: c.x, mouthY: c.y, mouthRx: c.rx, mouthRy: c.ry, gape: c.gape,
    mouth: c.mouth, muzzle: c.muzzle, teeth: chewing && !takesCoin(c.mouth, TUNING.mouthFit.coin, TUNING.mouthFit.share),
    bellyX: c.bx, bellyY: c.by, bellyRx: c.brx, bellyRy: c.bry,
    chewing,
    slick: state.tick < state.slickUntil, vent: state.vent, levels: state.mutations,
    crates: state.crates, craving: state.craving?.ingredient ?? null,
  };
}

function envFromCreature(creature: Creature, tick: number, frenzy: boolean, slick: boolean,
                         vent: Vent | null, levels: MutationLevels, crates: readonly Crate[],
                         craving: Ingredient | null): Env {
  const chewing = !frenzy && tick < creature.chewUntil;
  return {
    tick, mouthX: creature.x, mouthY: creature.y, mouthRx: creature.rx, mouthRy: creature.ry, gape: creature.gape,
    mouth: creature.mouth, muzzle: creature.muzzle,
    teeth: chewing && !takesCoin(creature.mouth, TUNING.mouthFit.coin, TUNING.mouthFit.share),
    bellyX: creature.bx, bellyY: creature.by, bellyRx: creature.brx, bellyRy: creature.bry,
    chewing, slick, vent, levels, crates, craving,
  };
}

/**
 * Knocks a coin off the lip it is leaving by: its motion along the lip is
 * damped and it is sent away from the opening, along the lip's outward
 * normal, at least `mouthFit.lipKick` px a tick. Past a corner, away from it.
 */
function lipOut(food: Projectile, mouth: MouthShape): void {
  let nx = food.x < mouth.midX ? -1 : 1;
  let ny = 0;
  const lips = lipsAt(mouth, food.x);
  const a = lipsAt(mouth, food.x - 1);
  const b = lipsAt(mouth, food.x + 1);
  if (lips && a && b) {
    const upper = food.y - lips.upper < lips.lower - food.y;
    const dy = upper ? b.upper - a.upper : b.lower - a.lower;
    // The tangent is (2, dy); the normal away from the opening.
    const length = hypot(2, dy);
    nx = (upper ? dy : -dy) / length;
    ny = (upper ? -2 : 2) / length;
  }
  const along = food.vx * nx + food.vy * ny;
  const tx = food.vx - along * nx;
  const ty = food.vy - along * ny;
  const away = Math.max(along, TUNING.mouthFit.lipKick);
  food.vx = quantize(tx * 0.6 + nx * away);
  food.vy = quantize(ty * 0.6 + ny * away);
  food.lipped = true;
  food.lastSurface = "lip";
}

type Outcome = "flying" | "fed" | "utensil" | "clanked" | "banked" | "bounced" | "lipped"
  | "struck" | "missed" | "dropped" | "crate";

/** Reflects a velocity about a unit normal, with restitution. */
function reflect(food: Projectile, nx: number, ny: number, restitution: number) {
  const dot = food.vx * nx + food.vy * ny;
  if (dot >= 0) return;
  food.vx = quantize((food.vx - 2 * dot * nx) * restitution);
  food.vy = quantize((food.vy - 2 * dot * ny) * restitution);
}

/**
 * A coin out of a broken crate. It pops up out of the crate, fanned, and
 * turns onto a lob that drops it into the middle of the mouth at its own
 * `arrive` age, one coin after another: the arc is solved afresh every tick
 * from where the mouth is now, so it lands whatever the creature does. It is
 * swallowed whole on arrival, chewing or not.
 */
function movePour(food: Projectile, env: Env): Outcome {
  food.age++;
  // Still in the broken crate, waiting its turn to come out.
  if (food.age <= 0) return "flying";
  if (food.age <= TUNING.pourPop) {
    // The pop: straight up out of the top of the crate.
    food.vy = quantize(food.vy + TUNING.pourPopGravity);
    food.x = quantize(food.x + food.vx);
    food.y = quantize(food.y + food.vy);
    return "flying";
  }
  const arrive = food.arrive ?? TUNING.pourArrive;
  const g = TUNING.pourGravity;
  // Ticks left to the mouth, this one included.
  const left = Math.max(1, arrive - food.age + 1);
  // Aimed into the left third of the opening, a little low, so it comes in under the eyes.
  const goal = pointInMouth(env.mouth, 0.36, 0.58);
  const dx = goal.x - food.x;
  const dy = goal.y - food.y;
  // The velocity that lands it there in `left` ticks under `g`.
  const wantX = dx / left;
  const wantY = (dy - g * left * (left + 1) / 2) / left;
  // Eased: the top of the pop rounds over, then it commits.
  const turn = Math.min(1, pow((food.age - TUNING.pourPop) / TUNING.pourTurn, 2));
  food.vx = quantize(food.vx + (wantX - food.vx) * turn);
  food.vy = quantize(food.vy + (wantY - food.vy) * turn + g);
  food.x = quantize(food.x + food.vx);
  food.y = quantize(food.y + food.vy);
  const inside = swallows(env.mouth, food.x, food.y, TUNING.mouthFit.coin, TUNING.mouthFit.share);
  if (inside || food.age >= arrive || food.age >= TUNING.pourMaxAge) return "fed";
  return "flying";
}

/** One physics step, shared by live play, the probe and the guide. */
function moveFood(food: Projectile, env: Env): Outcome {
  if (food.kind === "pour") return movePour(food, env);
  food.age++;
  const previousX = food.x;
  const previousY = food.y;
  let ax = 0;
  const flight = flightOf(food.ingredient);
  let ay = food.kind === "junk" ? TUNING.utensilGravity : food.age <= (food.straight ?? 0) ? 0 : flight.gravity;
  // Magnet mouth: metal, and the kitchen's metal, curve toward it.
  if (env.levels.metal > 0 && food.ingredient === "metal" && !food.spent) {
    const dx = env.mouth.midX - food.x;
    const dy = env.mouth.midY - food.y;
    const distance = hypot(dx, dy);
    const range = TUNING.magnetRange + TUNING.magnetRangePerLevel * env.levels.metal;
    if (distance < range && distance > 1) {
      const pull = TUNING.magnetPerLevel * env.levels.metal * (food.kind === "junk" ? 1.6 : 1);
      ax += dx / distance * pull;
      ay += dy / distance * pull;
      food.assisted = true;
    }
  }
  // The craving: the coin it wants curves in. A thrown coin only, not the kitchen's metal.
  if (env.craving !== null && food.kind === "food" && food.ingredient === env.craving && !food.spent) {
    const dx = env.mouth.midX - food.x;
    const dy = env.mouth.midY - food.y;
    const distance = hypot(dx, dy);
    if (distance < TUNING.cravingPullRange && distance > 1) {
      ax += dx / distance * TUNING.cravingPull;
      ay += dy / distance * TUNING.cravingPull;
      food.assisted = true;
    }
  }
  food.vx = quantize(clamp(food.vx + ax, -20, 20));
  food.vy = quantize(clamp(food.vy + ay, -16, 16));
  food.x = quantize(food.x + food.vx);
  food.y = quantize(food.y + food.vy);

  // The mouth first: the opening the player can see, exactly. A snack goes
  // down when most of it (TUNING.mouthFit.share) is between the lips; one that
  // only grazes a lip or a corner flies on. It is tested at the end of the
  // tick's move and halfway along it, so a fast shot cannot skip the opening.
  if (!food.spent) {
    // No chew gate: a chewing mouth is a shut mouth, and a shut mouth cannot
    // hold half a coin. Whatever fits in the opening as drawn — as the
    // jaws snap shut, or as they part again — goes down.
    {
      const fit = TUNING.mouthFit;
      // At the end of this tick's move, or halfway along it: no coin crosses
      // the mouth mostly inside it without being taken.
      const midX = (previousX + food.x) / 2;
      const midY = (previousY + food.y) / 2;
      const over = coverage(env.mouth, food.x, food.y, fit.coin);
      if (over >= fit.share) return food.kind === "junk" ? "utensil" : "fed";
      if (swallows(env.mouth, midX, midY, fit.coin, fit.share)) {
        // Taken halfway along the move: that is where it went in.
        food.x = quantize(midX);
        food.y = quantize(midY);
        return food.kind === "junk" ? "utensil" : "fed";
      }
      // A lip-out. A coin that got a good part of itself over the opening and
      // is now coming away without going in has met the lip: it is knocked
      // off it, outward, there and then, instead of riding the lip half in.
      const before = food.cover ?? 0;
      const now = quantize(over);
      food.cover = now;
      if (!env.teeth && food.kind === "food" && !food.lipped && before >= fit.lipOut && now < before) {
        lipOut(food, env.mouth);
        return "lipped";
      }
    }
    // While it chews, jaws too close together to take a coin are teeth: a
    // coin that touches the lips (its centre within a coin's radius of them,
    // from any side, round the corners too) comes off them. A parting gap
    // wide enough to take one is an opening: a coin over its lips flies on
    // until half of it is in.
    const coin = TUNING.mouthFit.coin;
    if (env.teeth && distanceToMouth(env.mouth, food.x, food.y, coin) <= coin) {
      // Off the teeth. It keeps flying, feeds nothing, and costs nothing more.
      // Pushed out past the lips, away from the mouth's middle line.
      const m = env.mouth;
      const lips = lipsAt(m, food.x);
      const above = !lips || food.y < (lips.upper + lips.lower) / 2;
      if (lips) food.y = quantize(above ? Math.min(food.y, lips.upper - coin - 1) : Math.max(food.y, lips.lower + coin + 1));
      food.vx = quantize(-Math.abs(food.vx) * 0.45 - 1.5);
      food.vy = quantize(above ? -Math.abs(food.vy) * 0.3 - 2.5 : Math.abs(food.vy) * 0.3 + 1);
      food.spent = true;
      food.lastSurface = "teeth";
      return "clanked";
    }
  }

  // A crate on the rail. It only opens for its own coin: the right coin
  // breaks it open, any other glances off it.
  if (food.kind === "food" && !food.spent && food.lastSurface !== "crate") {
    for (const crate of env.crates) {
      // A prediction can run past a crate's life; the live rules have removed it by then.
      if (env.tick - crate.born >= crate.life) continue;
      const at = crateAt(crate, env.tick);
      const dx = food.x - at.x;
      const dy = food.y - at.y;
      const reach = TUNING.crateRadius + FOOD_RADIUS;
      if (dx * dx + dy * dy <= reach * reach) {
        food.lastSurface = "crate";
        if (food.ingredient === crate.ingredient) {
          food.crateId = crate.id;
          return "crate";
        }
        const length = Math.max(0.01, hypot(dx, dy));
        const nx = dx / length;
        const ny = dy / length;
        food.x = quantize(at.x + nx * (reach + 0.5));
        food.y = quantize(at.y + ny * (reach + 0.5));
        reflect(food, nx, ny, TUNING.crateBounce);
        return "bounced";
      }
    }
  }

  // The belly, below the mouth. A trampoline with a balloon in it, a soft
  // bump without one. Never a wall.
  // Only below the chin: the chest is under the mouth, never in front of it.
  // The chin is level with the open mouth's lower lip. (Any lower and the low
  // lobs of Ether and HEMI start to share barrel angles: tests/aim.test.mjs.)
  const chin = env.muzzle.bottom;
  if (food.y > chin && food.lastSurface !== "belly") {
    const bx = (food.x - env.bellyX) / env.bellyRx;
    const by = (food.y - env.bellyY) / env.bellyRy;
    if (bx * bx + by * by <= 1) {
      let nx: number;
      let ny: number;
      if (previousY <= chin) {
        // Down past the chin: the chest meets it right there, under the lips,
        // and it comes back up off the chin. (Thrown out to the far edge of
        // the belly instead, it would jump across the creature.)
        const at = (chin - previousY) / Math.max(1e-6, food.y - previousY);
        food.x = quantize(previousX + (food.x - previousX) * at);
        food.y = quantize(chin + 0.5);
        nx = 0; ny = -1;
      } else {
        const length = Math.max(0.01, hypot(bx, by));
        food.x = quantize(env.bellyX + bx / length * (env.bellyRx + 2));
        food.y = quantize(env.bellyY + by / length * (env.bellyRy + 2));
        nx = bx / env.bellyRx;
        ny = by / env.bellyRy;
        const nl = Math.max(0.0001, hypot(nx, ny));
        nx /= nl; ny /= nl;
      }
      food.lastSurface = "belly";
      if (env.levels.balloon > 0 && !food.spent && food.kind === "food") {
        reflect(food, nx, ny, 1);
        // Toward the mouth, and up. The new easy route.
        const speed = Math.max(TUNING.trampolineMin, hypot(food.vx, food.vy) * TUNING.trampoline);
        const rl = Math.max(0.01, hypot(food.vx, food.vy));
        const tx = env.mouth.midX - food.x;
        const ty = env.mouth.midY - food.y;
        const tl = Math.max(1, hypot(tx, ty));
        let dx = food.vx / rl * 0.45 + tx / tl * 0.55;
        let dy = food.vy / rl * 0.45 + ty / tl * 0.55;
        const dl = Math.max(0.01, hypot(dx, dy));
        dx /= dl; dy /= dl;
        food.vx = quantize(dx * speed);
        food.vy = quantize(Math.min(-4, dy * speed));
        food.bank += 1;
        food.lastBank = "belly";
        return "banked";
      }
      if (ny === -1 && coverage(env.mouth, food.x, food.y, TUNING.mouthFit.coin) > 0) {
        // Still partly over the opening: it was skimming the lower lip, and it
        // drops off it rather than bouncing back up along it.
        food.vx = quantize(food.vx * 0.8);
        food.vy = quantize(Math.max(food.vy, Math.abs(food.vy) * 0.3 + 0.5));
        return "bounced";
      }
      reflect(food, nx, ny, TUNING.bellyBounce);
      food.vy = quantize(food.vy + 1);
      return "bounced";
    }
  }

  // The kitchen. Pans, shelf, lamp, chain, pot: every one of them a bank.
  for (let index = 0; index < ARENA.bouncers.length; index++) {
    const bouncer = ARENA.bouncers[index];
    let nx = 0;
    let ny = 0;
    let hit = false;
    if (bouncer.kind === "circle") {
      const dx = food.x - bouncer.x;
      const dy = food.y - bouncer.y;
      const distance = hypot(dx, dy);
      if (distance < bouncer.r + FOOD_RADIUS) {
        const length = Math.max(0.01, distance);
        nx = dx / length; ny = dy / length;
        food.x = quantize(bouncer.x + nx * (bouncer.r + FOOD_RADIUS + 0.5));
        food.y = quantize(bouncer.y + ny * (bouncer.r + FOOD_RADIUS + 0.5));
        hit = true;
      }
    } else {
      const ex = bouncer.x2 - bouncer.x1;
      const ey = bouncer.y2 - bouncer.y1;
      const el = Math.max(0.01, ex * ex + ey * ey);
      const t = clamp01(((food.x - bouncer.x1) * ex + (food.y - bouncer.y1) * ey) / el);
      const cx = bouncer.x1 + ex * t;
      const cy = bouncer.y1 + ey * t;
      const dx = food.x - cx;
      const dy = food.y - cy;
      const distance = hypot(dx, dy);
      if (distance < FOOD_RADIUS + 3) {
        if (distance < 0.01) {
          // Dead centre: take the side it came from.
          nx = previousX - cx; ny = previousY - cy;
          const pl = Math.max(0.01, hypot(nx, ny));
          nx /= pl; ny /= pl;
        } else {
          nx = dx / distance; ny = dy / distance;
        }
        food.x = quantize(cx + nx * (FOOD_RADIUS + 3.5));
        food.y = quantize(cy + ny * (FOOD_RADIUS + 3.5));
        hit = true;
      }
    }
    if (!hit) continue;
    reflect(food, nx, ny, bouncer.restitution);
    // Never dead on the surface: a snack resting on the shelf is a snack that
    // falls off it.
    if (hypot(food.vx, food.vy) < 1.5) { food.vx = quantize(food.vx + nx * 1.5); food.vy = quantize(food.vy + ny * 1.5); }
    food.lastSurface = bouncer.name;
    const bit = 1 << index;
    if (!food.spent && food.kind === "food" && (food.hitMask & bit) === 0) {
      food.hitMask |= bit;
      food.bank += bouncer.banks;
      food.lastBank = bouncer.name;
      return "banked";
    }
    return "bounced";
  }

  // The vent flap, once it exists. Swept slab intersection against the flap
  // expanded by the snack radius.
  const hazard = getHazard(env.vent, env.tick);
  if (hazard && !hazard.warning && food.hazardBounces === 0) {
    let enter = 0;
    let leave = 1;
    for (const [origin, delta, min, max] of [
      [previousX, food.x - previousX, hazard.x - FOOD_RADIUS, hazard.x + hazard.width + FOOD_RADIUS],
      [previousY, food.y - previousY, hazard.y - FOOD_RADIUS, hazard.y + hazard.height + FOOD_RADIUS],
    ]) {
      if (delta === 0) {
        if (origin < min || origin > max) { enter = 2; break; }
      } else {
        const near = (min - origin) / delta;
        const far = (max - origin) / delta;
        enter = Math.max(enter, Math.min(near, far));
        leave = Math.min(leave, Math.max(near, far));
      }
    }
    if (enter <= leave) {
      food.x = quantize(previousX + (food.x - previousX) * enter);
      food.y = quantize(previousY + (food.y - previousY) * enter);
      // Reflect off the face it entered through.
      const throughX = food.x <= hazard.x - FOOD_RADIUS + 0.01 || food.x >= hazard.x + hazard.width + FOOD_RADIUS - 0.01;
      if (throughX) food.vx = quantize(-food.vx * 0.7); else food.vy = quantize(-food.vy * 0.7);
      food.hazardBounces = 1;
      food.lastSurface = "vent";
      if (!food.spent && food.kind === "food") { food.bank += 1; food.lastBank = "vent"; return "banked"; }
      return "bounced";
    }
  }

  // Kitchen metal on the launcher.
  if (food.kind === "junk" && hypot(food.x - ARENA.launcher.x, food.y - ARENA.launcher.y) < ARENA.launcherRadius) {
    return "struck";
  }
  if (food.age >= LIFE_TICKS || food.x < 20 || food.x > 1180 || food.y < -140 || food.y > 720) {
    return food.spent || food.kind !== "food" ? "dropped" : "missed";
  }
  if (food.y >= ARENA.floor - FOOD_RADIUS && food.vy > 0) {
    if (food.spent || food.kind !== "food") return "dropped";
    // Drool. A slick floor keeps more of the speed and allows a second bounce.
    const allowed = env.slick ? 2 : 1;
    if (food.bounces >= allowed) return "missed";
    food.y = ARENA.floor - FOOD_RADIUS;
    food.vy = quantize(-food.vy * (env.slick ? 0.88 : 0.72));
    food.vx = quantize(food.vx * (env.slick ? 0.97 : 0.86));
    food.bounces++;
    food.lastSurface = "floor";
    return "bounced";
  }
  return "flying";
}

/** The label a bank earns on the catch. */
function bankLabel(food: Projectile, multiplier: number): string {
  if (food.bank <= 0) return `OFF THE FLOOR ×${multiplier}`;
  if (food.bank === 1) {
    const bouncer = ARENA.bouncers.find((item) => item.name === food.lastBank);
    const name = bouncer ? bouncer.label : food.lastBank === "belly" ? "OFF THE BELLY"
      : food.lastBank === "vent" ? "OFF THE VENT" : "BANK";
    return `${name} ×${multiplier}`;
  }
  if (food.bank === 2) return `DOUBLE BANK ×${multiplier}`;
  return `TRIPLE BANK ×${multiplier}`;
}

function acceptFood(state: ArcadeState, food: Projectile) {
  const creature = state.creature;
  const frenzy = inFrenzy(state);
  // A coin out of a crate: swallowed whole, no chew, and it pays the crate's multiplier.
  const pour = food.kind === "pour";
  const craving = state.craving !== null && food.ingredient === state.craving.ingredient;
  // Not the one it is waiting for: eaten, grudgingly. A crate's coins are exempt.
  const snub = state.craving !== null && !craving && !pour;
  const grudging = snub ? TUNING.offCraving : 1;
  state.totalFeeds++;
  if (craving) state.correctFeeds++;
  state.servings[food.ingredient]++;
  state.combo += 1;
  state.bestCombo = Math.max(state.bestCombo, state.combo);
  const gorged = state.hunger >= TUNING.gorgeFrom;

  // Points: a base that climbs with the combo, multiplied by the bank, by the
  // cooking and by the frenzy; the craving bonus rides the frenzy only.
  const multiplier = bankMultiplier(food.bank, food.bounces);
  const base = 100 + TUNING.comboBonus * Math.min(TUNING.comboBonusMax, state.combo - 1);
  const factor = multiplier * (food.cooked ? TUNING.cookedMult : 1) * (frenzy ? TUNING.frenzyScore : 1)
    * (pour ? TUNING.crateMult : 1);
  const points = Math.round(base * factor) + (craving ? Math.round(TUNING.cravingBonus * (frenzy ? TUNING.frenzyScore : 1)) : 0);
  state.score += points;
  const restore = (craving ? TUNING.restoreCraved : TUNING.restore) * grudging * (gorged ? TUNING.gorgeRestore : 1)
    * (1 + TUNING.comboRestore * Math.min(TUNING.comboBonusMax, state.combo - 1))
    / (1 + TUNING.restoreShrink * (creature.size - 1));
  state.hunger = quantize(Math.min(100, state.hunger + restore));
  state.rage = Math.max(0, state.rage - (craving ? TUNING.cravingCalm : TUNING.feedRage * grudging));
  // Appetite rises with every serving, and five times as fast when it was not
  // hungry. A frenzy is the one feast that costs nothing: the power fantasy
  // has no bill.
  if (!frenzy) state.appetite = quantize(state.appetite + TUNING.appetitePerFeed * (gorged ? TUNING.gorgeAppetite : 1));

  // Growth. This is the whole point: the reward and the problem are the same event.
  if (state.tick >= state.growthPausedUntil) {
    const before = creature.size;
    const step = TUNING.growthPerFeed * (1 + TUNING.growthShape * (1 - sizeT(creature.size)))
      * (gorged ? TUNING.gorgeGrowth : 1);
    creature.size = quantize(Math.min(TUNING.sizeMax, creature.size + step));
    state.size = creature.size;
    if (Math.floor((before - 1) / TUNING.growStep + 1e-9) !== Math.floor((creature.size - 1) / TUNING.growStep + 1e-9)) {
      event(state, "grow", creature.x, creature.y - creature.ry - 96, "BIGGER.", { value: creature.size });
    }
  }

  // The chew. Not in a frenzy, and not for a crate's coins: those go down whole.
  if (!frenzy && !pour) {
    creature.chewUntil = state.tick + TUNING.chewTicks;
    event(state, "chew", creature.x, creature.y, "CHOMP", { value: TUNING.chewTicks });
  }

  const word = pour ? "CRATE" : food.cooked ? "COOKED" : food.bank > 0 || food.bounces > 0 ? "BANK" : craving ? "CRAVING" : snub ? "NOT THAT" : gorged ? "STUFFED" : "NOM";
  state.announcement = gorged ? "It was not even hungry. It got bigger anyway."
    : pour ? "Straight out of the crate."
    : food.bank > 0 ? "A bank shot. It respects the technique."
    : craving ? "Exactly what it was craving."
    : snub ? "Not that. It ate it anyway, for half."
    : "It eats anything.";
  event(state, "feed", food.x, food.y, `${word} +${points}`, { ingredient: food.ingredient, craved: craving, value: points, ...(snub ? { name: "snub" } : {}) });
  if (food.bank > 0 || food.bounces > 0) {
    state.banks += 1;
    event(state, "bank", food.x, food.y - 40, bankLabel(food, multiplier), { value: multiplier, name: food.bank > 0 ? food.lastBank : "floor" });
  }

  // Five in a row. The power fantasy: no chewing, half the cooldown, triple
  // everything, for six seconds. It does not extend itself: the combo is spent
  // when the frenzy ends, and the next one has to be earned from zero.
  if (!frenzy && state.combo === TUNING.frenzyAt) {
    state.frenzies += 1;
    creature.chewUntil = 0;
    state.frenzyUntil = state.tick + TUNING.frenzyTicks;
    state.announcement = "FRENZY. Feed it everything.";
    event(state, "frenzy", creature.x, creature.y - creature.ry - 60, "FRENZY", { value: TUNING.frenzyTicks, name: "start" });
  }

  // A craving satisfied in time calms it and pauses the growth, which is the
  // only brake in the game and the reason to chase one.
  if (craving) {
    state.cravingsMet += 1;
    state.craving = null;
    state.cravingStreak += 1;
    const pause = Math.min(TUNING.growthPauseMax,
      Math.round(TUNING.growthPauseTicks * (1 + TUNING.pausePerStreak * (state.cravingStreak - 1))));
    state.growthPausedUntil = state.tick + pause;
    state.hunger = quantize(Math.min(100, state.hunger + TUNING.cravingFeed));
    state.cravingNextAt = state.tick + TUNING.cravingGap;
    if (state.cravingStreak >= TUNING.appetiteReliefFrom) {
      state.appetite = quantize(Math.max(1, state.appetite - TUNING.appetiteRelief));
      event(state, "craving", creature.x, creature.y - creature.ry - 40,
        `IT EASES OFF ×${state.cravingStreak}`, { name: "relief", value: state.cravingStreak });
    }
  }

  // A level lands at each serving threshold, and a level never goes away.
  const level = levelFor(state.servings[food.ingredient]);
  if (level > state.mutations[food.ingredient]) {
    // The first level starts its clock from now, so the first storm and the
    // first flame arrive a legible moment after the chip lights up.
    if (state.mutations[food.ingredient] === 0) {
      if (food.ingredient === "metal") state.junkAt = state.tick + TUNING.utensilFirst;
      if (food.ingredient === "pepper") state.flameAt = state.tick + TUNING.flameFirst;
    }
    state.mutations[food.ingredient] = level;
    state.mutationEvents++;
    state.announcement = MUTATION_LABELS[food.ingredient];
    event(state, "mutation", creature.x, creature.y - creature.ry - 60,
      `${MUTATION_NAMES[food.ingredient].toUpperCase()} ×${level}`, { ingredient: food.ingredient, value: level });
  }
}

/** The mutation level this many servings of one ingredient has earned. */
export function levelFor(servings: number): number {
  let level = 0;
  for (const threshold of TUNING.levelServings) if (servings >= threshold) level += 1;
  return Math.min(TUNING.maxLevel, level);
}

/** The fewest servings of one ingredient that earn `level`. Zero for level 0. */
export function servingsForLevel(level: number): number {
  if (level <= 0) return 0;
  return TUNING.levelServings[Math.min(TUNING.levelServings.length, level) - 1];
}

/** Total mutation levels the creature is carrying. */
export const mutationLoad = (levels: MutationLevels) => levels.metal + levels.balloon + levels.pepper;

/**
 * The stretch of rail a crate can use at this size: the creature's head takes
 * the right end as it grows. Null once there is too little left.
 */
export function crateLane(size: number): { lo: number; hi: number } | null {
  const lo = ARENA.rail.from;
  const hi = Math.min(ARENA.rail.to, ARENA.rail.to - TUNING.crateLaneShrink * (size - 1));
  return hi - lo >= TUNING.crateLaneMin ? { lo, hi: quantize(hi) } : null;
}

/** The next crate out of the wall, drawn from the seed. Faster as the creature grows. */
function spawnCrate(state: ArcadeState): void {
  const lane = crateLane(state.creature.size);
  if (!lane) return;
  const n = state.rolls.crate;
  state.rolls.crate += 1;
  const r = (k: number) => roll(state.seed, STREAM.crate, n * 8 + k);
  const crate: Crate = {
    id: state.nextProjectileId++,
    ingredient: FOODS[Math.min(FOODS.length - 1, Math.floor(r(0) * FOODS.length))],
    born: state.tick,
    shuttle: Math.round(mix(TUNING.crateShuttleMin, TUNING.crateShuttleMax, r(1)) / (1 + 0.3 * sizeT(state.creature.size))),
    lo: lane.lo, hi: lane.hi,
    life: Math.round(mix(TUNING.crateLifeMin, TUNING.crateLifeMax, r(6))),
    drop: quantize(mix(TUNING.crateDropMin, TUNING.crateDropMax, r(2))),
    swing: quantize(mix(TUNING.crateSwingMin, TUNING.crateSwingMax, r(3))),
    phase: quantize(r(4)),
    gap: Math.round(mix(TUNING.crateGapMin, TUNING.crateGapMax, r(5))),
  };
  state.crates.push(crate);
  event(state, "crate", lane.lo, ARENA.rail.y, "CRATE", { ingredient: crate.ingredient, name: "spawn" });
}

/**
 * A serving hit a crate. The serving is spent on it; the coins inside fan out
 * and pour into the mouth. A cooked serving cooks what was inside.
 */
function breakCrate(state: ArcadeState, food: Projectile, into: Projectile[]): void {
  const index = state.crates.findIndex((item) => item.id === food.crateId);
  if (index < 0) return;
  const crate = state.crates[index];
  const at = crateAt(crate, state.tick);
  state.crates.splice(index, 1);
  state.cratesBroken += 1;
  state.crateAt = state.tick + crate.gap;
  for (let i = 0; i < TUNING.crateCoins; i++) {
    // Straight up out of the top of the crate one after another, fanned a
    // little and leaning back over the open air (away from the lamp and the
    // creature's eyes), then each on its own lob into the mouth.
    const a = -Math.PI / 2 - 0.35 + (i - (TUNING.crateCoins - 1) / 2) * 0.2;
    const speed = TUNING.pourSpeed;
    into.push({
      id: state.nextProjectileId++, ingredient: crate.ingredient, kind: "pour",
      x: at.x, y: at.y,
      vx: quantize(cos(a) * speed), vy: quantize(sin(a) * speed),
      age: -i * TUNING.pourStagger, bounces: 0, bank: 0, hitMask: 0, lastSurface: "crate", lastBank: "", hazardBounces: 0,
      assisted: true, cooked: food.cooked, spent: false,
      arrive: TUNING.pourArrive,
    });
  }
  state.announcement = "Crate. Everything in it is going down.";
  event(state, "crate", at.x, at.y, `CRATE ×${TUNING.crateCoins}`,
    { ingredient: crate.ingredient, name: "hit", value: TUNING.crateCoins });
}

function jam(state: ArcadeState, ticks: number, cause: string, label: string, x: number, y: number) {
  state.reloadUntil = Math.max(state.reloadUntil, state.tick + ticks);
  event(state, "jam", x, y, label, { name: cause, value: ticks });
}

/** Mutates only the owned state; call exactly once per fixed 1/60-second tick. */
export function stepArcade(state: ArcadeState): void {
  if (state.phase !== "playing") return;
  state.tick++;
  state.events = state.events.filter((item) => state.tick - item.tick < 180);

  // Irritation cools on its own, at the top of the tick, before anything can raise it.
  if (state.rage > 0) state.rage = quantize(Math.max(0, state.rage - TUNING.rageCool));

  const creature = state.creature;
  const levels = state.mutations;

  // The frenzy ends, and takes the combo with it.
  if (state.frenzyUntil > 0 && state.tick === state.frenzyUntil) {
    state.combo = 0;
    state.announcement = "It catches its breath.";
    event(state, "frenzy", creature.x, creature.y - creature.ry - 60, "FRENZY OVER", { name: "end" });
  }

  // The craving clock. Ignoring one is a decision with a consequence.
  if (state.craving && state.tick >= state.craving.endsAt) {
    const ignored = state.craving.ingredient;
    state.craving = null;
    state.cravingNextAt = state.tick + TUNING.cravingGap;
    state.cravingsMissed += 1;
    state.cravingStreak = 0;
    state.rage = Math.min(100, state.rage + TUNING.tantrumRage);
    state.hunger = quantize(Math.max(1, state.hunger - TUNING.tantrumHunger));
    state.announcement = "It wanted that. It swipes the shelf instead.";
    event(state, "tantrum", 470, 470, "TANTRUM", { ingredient: ignored });
    jam(state, TUNING.tantrumJams, "tantrum", "TANTRUM", ARENA.launcher.x, ARENA.launcher.y - 40);
    for (const item of state.projectiles) {
      item.vx = quantize(item.vx * -0.35);
      item.vy = quantize(item.vy - 2.6);
    }
  }
  if (!state.craving && state.tick >= state.cravingNextAt) {
    state.craving = nextCraving(state);
    state.wanted = state.craving.ingredient;
    event(state, "craving", creature.x, creature.y - creature.ry - 40,
      `IT WANTS ${state.craving.ingredient.toUpperCase()}`, { ingredient: state.craving.ingredient, name: "start" });
  }
  if (state.craving) state.wanted = state.craving.ingredient;

  // What it does on its own, between shots. Seeded, so a beat is part of the
  // shift rather than something that happened to you.
  if (state.tick >= state.beatAt) {
    const counter = state.rolls.beat;
    state.rolls.beat += 1;
    const gap = Math.max(220, (TUNING.beatEvery - TUNING.beatEveryPerSize * (creature.size - 1))
      * (1 - TUNING.beatJitter / 2 + TUNING.beatJitter * roll(state.seed, STREAM.beat, counter * 3)));
    state.beatAt = state.tick + Math.round(gap);
    const pick = roll(state.seed, STREAM.beat, counter * 3 + 1);
    if (pick < 0.38) {
      // A sneeze. Everything in the air moves and the bench takes a moment.
      state.announcement = "It sneezes. Half the bench is on the floor.";
      event(state, "beat", creature.x, creature.y, "SNEEZE", { name: "sneeze" });
      jam(state, TUNING.sneezeJams, "sneeze", "SNEEZED ON", ARENA.launcher.x, ARENA.launcher.y - 40);
      for (const item of state.projectiles) {
        item.vx = quantize(item.vx * -0.5 - 2.2);
        item.vy = quantize(item.vy - 1.8);
      }
    } else if (pick < 0.72) {
      // A lunge, telegraphed. It is going to bite something.
      state.threat = { kind: "lunge", tick: state.tick + TUNING.lungeTell, x: creature.x, y: creature.y };
      state.announcement = "It is leaning out of the hatch.";
      event(state, "beat", creature.x, creature.y, "IT IS COMING OUT", { name: "lunge" });
    } else {
      state.slickUntil = state.tick + TUNING.droolTicks;
      state.announcement = "It drools on the floor. Everything slides now.";
      event(state, "beat", creature.x, creature.y + creature.ry, "DROOL", { name: "drool", value: TUNING.droolTicks });
    }
  }
  // A lunge nobody stopped: it eats a prop.
  if (state.threat && state.threat.kind === "lunge" && state.tick >= state.threat.tick) {
    state.threat = null;
    if (!state.vent) {
      state.vent = { since: state.tick };
      state.announcement = "It has bitten the extractor vent off the wall.";
      event(state, "beat", 550, 200, "IT ATE THE VENT", { name: "bite" });
    } else {
      state.announcement = "It takes the whole tray off the bench.";
      event(state, "beat", ARENA.launcher.x + 60, ARENA.launcher.y - 40, "IT TOOK THE TRAY", { name: "bite" });
    }
    state.rage = Math.min(100, state.rage + TUNING.lungeRage);
    state.hunger = quantize(Math.max(1, state.hunger - TUNING.lungeHunger));
    jam(state, TUNING.lungeJams, "lunge", "BITTEN", ARENA.launcher.x, ARENA.launcher.y - 40);
  }

  // METAL: cutlery storms. Loose kitchen metal tears off the walls and flies.
  if (levels.metal > 0 && state.tick >= state.junkAt) {
    state.junkAt = state.tick + Math.max(90, Math.round(
      (TUNING.utensilEvery - TUNING.utensilEveryPerLevel * levels.metal)
      * (0.7 + 0.6 * roll(state.seed, STREAM.junk, state.rolls.junk * 3 + 2))));
    const piece = makeUtensil(state.nextProjectileId++, state.seed, state.rolls.junk);
    state.rolls.junk += 1;
    state.projectiles.push(piece);
    event(state, "utensil", piece.x, piece.y, "CUTLERY", { ingredient: "metal", name: "loose" });
  }

  // PEPPER: fire breath. A tell, then a cone toward the launcher.
  if (levels.pepper > 0 && state.tick >= state.flameAt && !state.flame) {
    const counter = state.rolls.flame;
    state.rolls.flame += 1;
    state.flameAt = state.tick + TUNING.flameTell + TUNING.flameTicks + Math.max(120, Math.round(
      (TUNING.flameEvery - TUNING.flameEveryPerLevel * levels.pepper)
      * (0.72 + 0.56 * roll(state.seed, STREAM.flame, counter * 2))));
    const toLauncher = atan2(ARENA.launcher.y - creature.y, ARENA.launcher.x - (creature.x - creature.rx * 0.6));
    const angle = quantize(toLauncher + (roll(state.seed, STREAM.flame, counter * 2 + 1) - 0.5) * 2 * TUNING.flameScatter);
    const reach = hypot(ARENA.launcher.x - (creature.x - creature.rx * 0.6), ARENA.launcher.y - creature.y)
      * (TUNING.flameReach + TUNING.flameReachPerLevel * levels.pepper);
    state.flame = {
      tellUntil: state.tick + TUNING.flameTell, until: state.tick + TUNING.flameTell + TUNING.flameTicks,
      angle, length: quantize(reach),
    };
    state.threat = { kind: "flame", tick: state.tick + TUNING.flameTell, x: creature.x, y: creature.y };
    state.announcement = "It inhales.";
    event(state, "flame", creature.x - creature.rx, creature.y, "IT INHALES", { name: "tell", value: TUNING.flameTell });
  }
  if (state.flame && state.tick === state.flame.tellUntil) {
    const cone = flameCone(state);
    state.announcement = "FIRE BREATH.";
    event(state, "flame", creature.x - creature.rx, creature.y, "FIRE BREATH", { name: "breath", value: TUNING.flameTicks });
    if (state.threat && state.threat.kind === "flame") state.threat = null;
    if (cone && insideCone(cone, ARENA.launcher.x, ARENA.launcher.y)) {
      if (state.tick < state.hatchClosedUntil) {
        state.hatchSaves += 1;
        state.score += 220;
        state.announcement = "Off the hatch. That is what it is for.";
        event(state, "block", ARENA.launcher.x, ARENA.launcher.y - 46, "BLOCKED +220");
      } else {
        state.announcement = "Singed. The launcher is smoking.";
        jam(state, TUNING.singeJams, "singe", "SINGED", ARENA.launcher.x, ARENA.launcher.y - 40);
      }
    }
  }
  if (state.flame && state.tick >= state.flame.until) state.flame = null;

  // The bench fire: free cooking, rising irritation.
  if (state.tick < state.benchFireUntil) {
    state.rage = Math.min(100, quantize(state.rage + TUNING.benchFireRage));
  } else if (state.benchFireUntil > 0 && state.tick === state.benchFireUntil) {
    event(state, "fire", (ARENA.bench.from + ARENA.bench.to) / 2, ARENA.floor, "FIRE OUT", { name: "out" });
  }

  // Crates on the rail: one comes down through the hatch when it is time, and
  // one nobody broke is hoisted away at the end of its life.
  for (let i = state.crates.length - 1; i >= 0; i--) {
    const crate = state.crates[i];
    const at = crateAt(crate, state.tick);
    if (state.tick - crate.born >= crate.life) {
      state.crates.splice(i, 1);
      state.cratesLost += 1;
      state.crateAt = state.tick + crate.gap;
      event(state, "crate", at.x, at.y, "CRATE GONE", { ingredient: crate.ingredient, name: "gone" });
    }
  }
  if (state.crates.length === 0 && state.tick >= state.crateAt) spawnCrate(state);

  // The body moves before the food does.
  let nearest: Projectile | null = null;
  for (const item of state.projectiles) if (item.kind === "food" && (!nearest || item.x > nearest.x)) nearest = item;
  stepCreature(creature, state.seed, state.tick, state.rage, state.hunger, nearest, levels, inFrenzy(state),
    faceInputOf(state, inFrenzy(state)));

  const env = envOf(state);
  const cone = flameCone(state);
  const breathing = cone !== null && !cone.telling;
  const remaining: Projectile[] = [];
  for (const food of state.projectiles) {
    const outcome = moveFood(food, env);
    // Through the fire. Worth double when it lands.
    if (breathing && cone && food.kind === "food" && !food.cooked && !food.spent
        && (outcome === "flying" || outcome === "banked" || outcome === "bounced" || outcome === "lipped" || outcome === "fed")
        && insideCone(cone, food.x, food.y)) {
      food.cooked = true;
      state.cooked += 1;
      event(state, "cooked", food.x, food.y, "COOKED", { ingredient: food.ingredient });
    }
    if (outcome === "fed") {
      acceptFood(state, food);
      // Anything else arriving this tick meets the opening as it is this tick:
      // the jaws start to close from the next one.
    } else if (outcome === "utensil") {
      state.utensils += 1;
      const points = TUNING.utensilScore * (inFrenzy(state) ? TUNING.frenzyScore : 1);
      state.score += points;
      state.announcement = "A fork. It did not mind.";
      event(state, "utensil", food.x, food.y, `UTENSIL +${points}`, { ingredient: "metal", name: "caught", value: points });
    } else if (outcome === "clanked") {
      if (food.kind === "food") {
        state.clanks++;
        state.combo = 0;
        state.rage = Math.min(100, quantize(state.rage + TUNING.clankRage));
        state.announcement = "Off the teeth. It was chewing.";
      }
      event(state, "clank", food.x, food.y, "CLANK", { ingredient: food.ingredient });
      remaining.push(food);
    } else if (outcome === "crate") {
      breakCrate(state, food, remaining);
    } else if (outcome === "struck") {
      state.announcement = "A fork in the works.";
      jam(state, TUNING.utensilJams, "utensil", "FORK IN THE WORKS", ARENA.launcher.x, ARENA.launcher.y - 40);
    } else if (outcome === "missed") {
      state.misses++;
      state.combo = 0;
      state.rage = Math.min(100, state.rage + TUNING.missRage);
      state.announcement = "On the floor.";
      event(state, "miss", clamp(food.x, 20, 1180), clamp(food.y, 0, ARENA.floor), "ON THE FLOOR", { ingredient: food.ingredient });
      if (food.cooked && food.y >= ARENA.floor - FOOD_RADIUS - 1 && food.x >= ARENA.bench.from && food.x <= ARENA.bench.to
          && state.tick >= state.benchFireUntil) {
        state.benchFireUntil = state.tick + TUNING.benchFireTicks;
        state.announcement = "The bench is on fire.";
        event(state, "fire", food.x, ARENA.floor, "THE BENCH IS ON FIRE", { name: "start", value: TUNING.benchFireTicks });
      }
    } else if (outcome === "dropped") {
      // A spent snack or a piece of cutlery reaching the floor. Paid for already.
    } else if (outcome === "lipped") {
      // Off the lip: not a bank, not a miss. Presentation: the glint, there.
      event(state, "lip", food.x, food.y, "LIP", { ingredient: food.ingredient });
      remaining.push(food);
    } else {
      if (outcome === "banked") {
        const bouncer = ARENA.bouncers.find((item) => item.name === food.lastSurface);
        const label = bouncer ? bouncer.label : food.lastSurface === "belly" ? "OFF THE BELLY" : "OFF THE VENT";
        event(state, "bounce", food.x, food.y, label, { ingredient: food.ingredient, name: food.lastSurface, value: food.bank });
      } else if (outcome === "bounced") {
        const label = food.lastSurface === "floor" ? "OFF THE FLOOR" : food.lastSurface === "belly" ? "OFF THE BELLY"
          : food.lastSurface === "crate" ? "WRONG COIN" : "BOUNCE";
        event(state, "bounce", food.x, food.y, label, { ingredient: food.ingredient, name: food.lastSurface, value: 0 });
        // A cooked snack landing on the bench lights it, even if it bounces on.
        if (food.lastSurface === "floor" && food.cooked && food.kind === "food" && !food.spent
            && food.x >= ARENA.bench.from && food.x <= ARENA.bench.to && state.tick >= state.benchFireUntil) {
          state.benchFireUntil = state.tick + TUNING.benchFireTicks;
          state.announcement = "The bench is on fire.";
          event(state, "fire", food.x, ARENA.floor, "THE BENCH IS ON FIRE", { name: "start", value: TUNING.benchFireTicks });
        }
      }
      remaining.push(food);
    }
  }
  state.projectiles = remaining;

  // Appetite. A bigger, older, hungrier creature empties faster.
  if (state.tick > TUNING.graceTicks) {
    state.hunger = quantize(Math.max(0, state.hunger - drainPerTick(state)));
  }

  // Passive score: time kept fed.
  if (state.hunger > TUNING.payFloor) state.paidTicks += 1;
  if (state.tick % 10 === 0 && state.hunger > TUNING.payFloor) {
    state.score += Math.max(1, Math.round(payRate(state.paidTicks)));
  }

  // THE LAST SERVING — once a shift, a serving already in the air gets to land.
  const inFlight = state.projectiles.some((p) => (p.kind === "food" || p.kind === "pour") && !p.spent);
  if (state.hunger > 0 && state.lastServingAt >= 0) {
    state.lastServingAt = -1;
    state.lastServingSpent = true;
  }
  let riding = state.hunger <= 0 && inFlight && state.lastServingAt >= 0;
  if (state.hunger <= 0 && inFlight && !riding && !state.lastServingSpent) {
    state.lastServingAt = state.tick;
    state.announcement = "Everything rides on the one in the air.";
    event(state, "beat", ARENA.launcher.x + 40, ARENA.launcher.y - 90, "THE LAST SERVING", { name: "last-serving" });
    riding = true;
  }
  if (state.hunger <= 0 && !riding) {
    state.phase = "lost";
    state.failureReason = "empty-belly";
  } else if (state.rage >= 100) {
    state.phase = "lost";
    state.failureReason = "kitchen-destroyed";
  } else if (state.tick >= ARENA.maxTicks) {
    state.phase = "lost";
    state.failureReason = "outgrew-the-kitchen";
  }
  if (state.phase !== "playing") {
    state.ending = endingFor(state.creature.size);
    const cause = state.failureReason === "empty-belly"
      ? "Empty belly."
      : state.failureReason === "kitchen-destroyed"
        ? "The kitchen is wrecked."
        : "Twelve minutes.";
    state.announcement = `${cause} ${ENDINGS[state.ending]}`;
    event(state, "end", state.creature.x, state.creature.y, state.announcement);
  }
}

/** A copy of the creature the prediction can step without touching the state. */
function projectCreature(state: ArcadeState): Creature {
  return copyCreature(state.creature);
}

/**
 * What a prediction tells the face: the shift as it stands, with the one
 * projectile being predicted as the only thing in the air.
 */
function projectFace(state: ArcadeState, creature: Creature, food: Projectile): FaceInput {
  const input = faceInputOf(state, false);
  input.creature = creature;
  input.nearest = food;
  input.pourInFlight = false;
  return input;
}

/**
 * A prediction's own events. The one thing a lone shot can do in flight that
 * the face answers is come off the belly: the shift records that bounce and
 * the face flinches at it from the next tick, so the prediction records it
 * too, the same way.
 */
function projectEvents(face: FaceInput, food: Projectile, outcome: Outcome, before: string, tick: number): void {
  if ((outcome !== "bounced" && outcome !== "banked") || food.lastSurface !== "belly" || before === "belly") return;
  face.events = [...face.events, {
    id: -1, tick, type: "bounce", x: quantize(food.x), y: quantize(food.y), label: "OFF THE BELLY",
    ingredient: food.ingredient, name: "belly", value: outcome === "banked" ? food.bank : 0,
  }];
}

export interface FlightResult {
  fed: boolean; clanked: boolean; ticks: number; bounces: number; bank: number;
  x: number; y: number;
  /** It broke a crate open (and so fed nothing itself). */
  crate?: boolean;
}

/**
 * What one shot would do, right now, under the rules as they stand, if nothing
 * else lands first. Used by the balance bots and by the trajectory guide, so
 * neither can drift from the rules: this runs the same `moveFood` and the same
 * creature step.
 */
export function probeFlight(state: ArcadeState, ingredient: Ingredient, angle: number,
                            power: number | null, maxTicks = 240): FlightResult {
  if (!FOODS.includes(ingredient) || !Number.isFinite(angle)) {
    return { fed: false, clanked: false, ticks: 0, bounces: 0, bank: 0, x: 0, y: 0 };
  }
  const food = makeProjectile(0, ingredient,
    Math.round(clamp(angle, ARENA.minAngle, ARENA.maxAngle)), cleanPower(power ?? ARENA.defaultPower));
  const creature = projectCreature(state);
  const face = projectFace(state, creature, food);
  let hunger = state.hunger;
  let rage = state.rage;
  for (let i = 1; i <= maxTicks; i++) {
    const tick = state.tick + i;
    const frenzy = tick < state.frenzyUntil;
    face.tick = tick; face.frenzy = frenzy;
    // Irritation cools at the top of the tick, as it does on the shift.
    if (rage > 0) rage = quantize(Math.max(0, rage - TUNING.rageCool));
    face.hunger = hunger; face.rage = rage;
    stepCreature(creature, state.seed, tick, rage, hunger, food, state.mutations, frenzy, face);
    const env = envFromCreature(creature, tick, frenzy, tick < state.slickUntil, state.vent, state.mutations, state.crates,
      state.craving && tick < state.craving.endsAt ? state.craving.ingredient : null);
    const surface = food.lastSurface;
    const outcome = moveFood(food, env);
    projectEvents(face, food, outcome, surface, tick);
    // And the belly empties at the end of it: the face reads both.
    hunger = quantize(Math.max(0, hunger - drainAt(state, tick)));
    if (outcome === "fed") return { fed: true, clanked: false, ticks: i, bounces: food.bounces, bank: food.bank, x: food.x, y: food.y };
    if (outcome === "clanked") return { fed: false, clanked: true, ticks: i, bounces: food.bounces, bank: food.bank, x: food.x, y: food.y };
    if (outcome === "crate") {
      return { fed: false, clanked: false, crate: true, ticks: i, bounces: food.bounces, bank: food.bank, x: food.x, y: food.y };
    }
    if (outcome === "missed" || outcome === "dropped") {
      return { fed: false, clanked: false, ticks: i, bounces: food.bounces, bank: food.bank, x: food.x, y: food.y };
    }
  }
  return { fed: false, clanked: false, ticks: maxTicks, bounces: food.bounces, bank: food.bank, x: food.x, y: food.y };
}

/** Partial guide: predicts `steps` ticks of the actual rules without changing state. */
export function trajectoryPreview(state: ArcadeState, ingredient: Ingredient, angle: number,
                                  power = ARENA.defaultPower, steps = 36): { x: number; y: number }[] {
  return previewFlight(state, ingredient, angle, power, steps).points;
}

/**
 * The same forward run as `trajectoryPreview`, with the two facts the renderer
 * needs and the points alone cannot carry: how many ticks the serving is in the
 * air before its first contact, and whether the run actually ENDED in that time.
 */
export function previewFlight(state: ArcadeState, ingredient: Ingredient, angle: number,
                              power = ARENA.defaultPower, steps = 36):
                              { points: { x: number; y: number }[]; ticks: number; settled: boolean;
                                arrival: { x: number; y: number } | null } {
  const empty = { points: [] as { x: number; y: number }[], ticks: 0, settled: false, arrival: null };
  if (!FOODS.includes(ingredient) || !Number.isFinite(angle)) return empty;
  const food = makeProjectile(0, ingredient,
    Math.round(clamp(angle, ARENA.minAngle, ARENA.maxAngle)), cleanPower(power));
  const creature = projectCreature(state);
  const face = projectFace(state, creature, food);
  let hunger = state.hunger;
  let rage = state.rage;
  const points = [{ x: food.x, y: food.y }];
  let ticks = 0;
  let settled = false;
  let arrival: { x: number; y: number } | null = null;
  for (let i = 1; i <= steps; i++) {
    if (!settled) ticks = i;
    const tick = state.tick + i;
    const frenzy = tick < state.frenzyUntil;
    face.tick = tick; face.frenzy = frenzy;
    // Irritation cools at the top of the tick, as it does on the shift.
    if (rage > 0) rage = quantize(Math.max(0, rage - TUNING.rageCool));
    face.hunger = hunger; face.rage = rage;
    stepCreature(creature, state.seed, tick, rage, hunger, food, state.mutations, frenzy, face);
    const env = envFromCreature(creature, tick, frenzy, tick < state.slickUntil, state.vent, state.mutations, state.crates,
      state.craving && tick < state.craving.endsAt ? state.craving.ingredient : null);
    const surface = food.lastSurface;
    const outcome = moveFood(food, env);
    projectEvents(face, food, outcome, surface, tick);
    // And the belly empties at the end of it: the face reads both.
    hunger = quantize(Math.max(0, hunger - drainAt(state, tick)));
    if (i % 3 === 0) points.push({ x: food.x, y: food.y });
    if (!settled && outcome !== "flying") { settled = true; ticks = i; arrival = { x: food.x, y: food.y }; }
    if (outcome === "fed" || outcome === "missed" || outcome === "dropped" || outcome === "crate") break;
  }
  return { points, ticks, settled, arrival };
}

/** Strict local replay. Rejected launches and hatches must not enter the trace. */
export function replayArcade(seed: number, commands: readonly ArcadeCommand[], endTick: number,
                             inherited: Ingredient | null = null): ArcadeState {
  if (!Array.isArray(commands) || commands.length > MAX_COMMANDS) throw new Error("Too many arcade commands");
  if (!Number.isSafeInteger(endTick) || endTick < 0 || endTick > ARENA.maxTicks) throw new Error("Invalid arcade end tick");
  let previousTick = -1;
  for (const command of commands) {
    if (!command || !Number.isSafeInteger(command.tick) || command.tick < 0 || command.tick <= previousTick
        || command.tick > endTick) {
      throw new Error("Invalid arcade command");
    }
    if (command.kind === "launch") {
      if (!FOODS.includes(command.ingredient) || !Number.isInteger(command.angle)
          || command.angle < ARENA.minAngle || command.angle > ARENA.maxAngle
          || !Number.isInteger(command.power)
          || command.power < ARENA.minPower || command.power > ARENA.maxPower) {
        throw new Error("Invalid arcade command");
      }
    } else if (command.kind !== "hatch") {
      throw new Error("Invalid arcade command");
    }
    previousTick = command.tick;
  }
  const state = createArcade(seed, inherited);
  for (const command of commands) {
    while (state.tick < command.tick && state.phase === "playing") stepArcade(state);
    if (state.tick !== command.tick) throw new Error("Rejected arcade launch");
    const applied = command.kind === "hatch"
      ? slamHatch(state)
      : launchFood(state, command.ingredient, command.angle, command.power);
    if (!applied) throw new Error("Rejected arcade launch");
  }
  while (state.tick < endTick && state.phase === "playing") stepArcade(state);
  return state;
}
