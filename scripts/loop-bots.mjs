#!/usr/bin/env node
/**
 * Headless balance harness for FEAST.
 *
 * Six deterministic bots play the pure simulation. Nothing here reads a
 * clock, a renderer or `Math.random`: a bot's only randomness is aim noise
 * drawn from its own seeded stream, so a reported table is reproducible from
 * `--seed` alone.
 *
 *   naive     never aims: the default angle and power, fired the instant the
 *             launcher is ready, cycling the three snacks in order. A beginner
 *             who has found the fire button and nothing else.
 *   moderate  aims at the mouth through a 250 ms delay with +/-4 degrees of
 *             noise, does not fire into a chew it can see coming, serves the
 *             craving when there is one, and tries a bank shot now and then.
 *   good      150 ms and +/-1.5 degrees, and goes looking for banks on purpose.
 *   casual    a person who is not a gamer: aims by eye at the middle of the
 *             mouth through a 450 ms delay with +/-12 degrees of noise, taps or
 *             holds the charge, fires at most once every 0.83 s, never hunts a
 *             bank. The reference for how long a shift should last (D174).
 *
 * `BOT_EXTRA`, a JSON object of extra bot configs, adds or overrides bots for a
 * calibration sweep without editing this file.
 *
 * Reported per bot: survival-time percentiles, feeds, accuracy, frenzies and
 * banks per run, score, cause of death, deaths per 30-second bucket, and the
 * pacing — when the first mutation level, size ×1.5, size ×2.0, the first
 * ingredient at ×3 and all three at ×3 arrive. A run that never gets there is
 * counted as "never", which sorts after every time, so a pacing median reads
 * "never" when fewer than half the runs reached the mark. The moderate bot
 * additionally reports decision density — how often per minute the best
 * available action actually changes.
 *
 * Usage:
 *   node --experimental-strip-types scripts/loop-bots.mjs [--shifts 200]
 *        [--seed 1] [--density-shifts 8] [--bots naive,moderate,good]
 *        [--json FILE] [--fixtures FILE] [--inherited metal|balloon|pepper]
 *   --bots also takes casual, lopsided, human, fixed and fixedDirect.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import * as arcade from "../lib/game/arcade.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { ARENA, FOODS, TUNING, createArcade, launchFood, stepArcade, replayArcade, probeFlight, cooldownFor } = arcade;

const TICKS = ARENA.tickRate;
const MAX_TICKS = ARENA.maxTicks;
const PROBE_TICKS = 200;

/* ------------------------------------------------------------------ *
 * Deterministic noise, owned by the bot rather than by the rules.
 * ------------------------------------------------------------------ */
function stream(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The delayed snapshot a bot decides from. Only the fields a decision reads
 * are copied; the projectile list is shared because the bot never writes it.
 */
function viewOf(state) {
  return {
    seed: state.seed, tick: state.tick, phase: state.phase,
    hunger: state.hunger, rage: state.rage, appetite: state.appetite, wanted: state.wanted,
    size: state.size, creature: arcade.copyCreature(state.creature),
    mutations: state.mutations, craving: state.craving, threat: state.threat,
    servings: state.servings, frenzyUntil: state.frenzyUntil, slickUntil: state.slickUntil,
    vent: state.vent, flame: state.flame, crates: state.crates,
    lastLaunchTick: state.lastLaunchTick, projectiles: state.projectiles,
    // The face reacts to what just happened, and the face is the mouth: a bot
    // reading the creature sees its reactions too.
    events: state.events, phase: state.phase, failureReason: state.failureReason,
    hatchClosedUntil: state.hatchClosedUntil, hatchReadyAt: state.hatchReadyAt, reloadUntil: state.reloadUntil,
  };
}

/* ------------------------------------------------------------------ *
 * Aiming.
 *
 * The ballistic solution to the mouth's centre seeds the candidates; the
 * rules' own `probeFlight` decides. Nothing in here can disagree with the
 * physics because nothing in here is the physics.
 * ------------------------------------------------------------------ */
const POWERS = [];
for (let p = ARENA.maxPower; p >= ARENA.minPower; p -= 1) POWERS.push(p);

/**
 * The launch angles (degrees, arena convention: negative is up) whose flight,
 * with nothing in the way, passes closest to (tx, ty) at `power` — the coin's
 * own gravity, speed and straight burn included. A free-flight model only
 * seeds the candidates; the rules' `probeFlight` decides.
 */
function solveAngles(tx, ty, power, ingredient = "metal", reach = 70) {
  const flight = arcade.flightOf(ingredient);
  const speed = arcade.launchSpeed(ingredient, power);
  const straight = arcade.straightTicks(ingredient, power);
  const errs = [];
  for (let angle = ARENA.minAngle; angle <= ARENA.maxAngle; angle += 1) {
    const r = angle * Math.PI / 180;
    let x = ARENA.launcher.x + Math.cos(r) * ARENA.barrelLength;
    let y = ARENA.launcher.y + Math.sin(r) * ARENA.barrelLength;
    let vx = Math.cos(r) * speed;
    let vy = Math.sin(r) * speed;
    // How close the free flight passes to the target, anywhere along it: a
    // steep lob drops into the mouth from above long before it reaches the
    // mouth's centre line, so the error at that line would miss it.
    let err = Infinity;
    for (let age = 1; age <= 240 && x < tx + 120 && y < 720; age += 1) {
      if (age > straight) vy += flight.gravity;
      x += vx; y += vy;
      err = Math.min(err, Math.hypot(x - tx, y - ty));
    }
    errs.push({ angle, err });
  }
  // Local minima that pass within the mouth's height of its centre.
  const out = [];
  for (let i = 0; i < errs.length; i += 1) {
    const e = errs[i];
    if (e.err > reach) continue;
    const left = i > 0 ? errs[i - 1].err : Infinity;
    const right = i < errs.length - 1 ? errs[i + 1].err : Infinity;
    if (e.err <= left && e.err <= right) out.push(e.angle);
  }
  return out;
}

const clampAngle = (angle) => Math.round(Math.max(ARENA.minAngle, Math.min(ARENA.maxAngle, angle)));

/**
 * Whether a shot arriving at `arrival` would meet a mouth still chewing one
 * of this bot's own earlier shots. The probe knows the chew that is already
 * happening; this is the one it cannot know about yet.
 */
function intoOwnChew(pending, arrival, view) {
  if (arrival < view.frenzyUntil) return false;
  for (const landing of pending) {
    if (arrival >= landing && arrival < landing + TUNING.chewTicks) return true;
  }
  return false;
}

/** Which snack to serve: the craving, else whichever it has eaten least of. */
function pickIngredient(view) {
  // DNFI_BOT_ONLY=metal|balloon|pepper: one coin whatever it craves, to measure what ignoring cravings costs.
  if (process.env.DNFI_BOT_ONLY) return process.env.DNFI_BOT_ONLY;
  if (view.craving) return view.craving.ingredient;
  let best = FOODS[0];
  for (const food of FOODS) if (view.servings[food] < view.servings[best]) best = food;
  return best;
}

/**
 * The best shot available from `view`.
 *
 * Direct shots first: the analytic solution at every power, with a degree of
 * slack either side for the rounding. Then, if the bot is the kind that looks
 * for them, a coarse sweep for bank shots. A bank is preferred when it lands
 * and the belly is not urgent; otherwise the shot that lands soonest wins.
 */
function bestAction(view, config, pending, wantBank, now = view.tick) {
  if (view.phase !== "playing") return null;
  const ingredient = pickIngredient(view);
  const mouth = view.creature;
  const frenzy = view.tick < view.frenzyUntil;
  const urgent = view.hunger < 40;
  // A shot is only as good as it is under the bot's own hand: the window of
  // angles around it that also land is what the noise will be drawn from.
  const spread = Math.ceil(config.noise) + 1;
  // The snapshot is stale by the bot's latency, but the shot leaves the
  // launcher now: the probe is run from the present tick so the creature's
  // visible rhythm (the bob) is led rather than lagged, the way a player
  // leads a target. Everything else about the snapshot stays stale.
  const base = now === view.tick ? view : { ...view, tick: now };
  const cache = new Map();
  const probe = (angle, power) => {
    const key = angle * 100 + power;
    let result = cache.get(key);
    if (result === undefined) {
      result = probeFlight(base, ingredient, angle, power, PROBE_TICKS);
      if (result.fed && intoOwnChew(pending, now + result.ticks, view)) result = { ...result, fed: false };
      cache.set(key, result);
    }
    return result;
  };
  let best = null;
  const offer = (angle, power, robustness) => {
    const result = probe(angle, power);
    if (!result.fed) return;
    // A serving that pinballs round the kitchen for two seconds is not a plan
    // a hungry player makes; only a bank-hunter takes the slow road.
    if (result.ticks > 90 && (!wantBank || urgent)) return;
    const bank = result.bank > 0 ? arcade.bankMultiplier(result.bank, result.bounces) : 1;
    const value = robustness * 30 + (wantBank && !urgent && bank > 1 ? bank * 60 : 0) - result.ticks * (urgent ? 2 : 1);
    if (!best || value > best.value) best = { verb: "launch", ingredient, angle, power, ticks: result.ticks, bank, robustness, value };
  };
  /**
   * The centre of the widest run of landing angles in a window around
   * `centre`. The window is twice the hand's spread: the free-flight seed
   * aims at the mouth's centre, and the coins that land enter its open half,
   * a few degrees off the seed.
   */
  const widest = (centre, power) => {
    let runStart = null;
    let bestRun = null;
    const span = 2 * spread;
    for (let angle = centre - span; angle <= centre + span + 1; angle += 1) {
      const lands = angle <= centre + span && angle >= ARENA.minAngle && angle <= ARENA.maxAngle && probe(angle, power).fed;
      if (lands && runStart === null) runStart = angle;
      if (!lands && runStart !== null) {
        const length = angle - runStart;
        if (!bestRun || length > bestRun.length) bestRun = { start: runStart, length };
        runStart = null;
      }
    }
    return bestRun;
  };
  for (const power of POWERS) {
    // Seeds: angles whose free flight passes within the mouth's own reach of
    // its centre (a grown mouth is a bigger target, entered off-centre).
    const reach = Math.max(70, (mouth.ry ?? 69) * (mouth.gape ?? 1) * 1.1);
    for (const degrees of solveAngles(mouth.x, mouth.y, power, ingredient, reach)) {
      const run = widest(clampAngle(degrees), power);
      if (run) offer(Math.round(run.start + (run.length - 1) / 2), power, run.length);
    }
    // The fastest shot whose whole window lands is the shot; the slower powers
    // only matter when the fast ones are blocked or into a chew.
    if (best && !wantBank && best.robustness >= 2 * spread + 1) break;
  }
  if (wantBank && !frenzy) {
    for (const power of [16, 15, 14]) {
      for (let angle = ARENA.minAngle; angle <= ARENA.maxAngle; angle += 3) {
        const result = probe(angle, power);
        if (!result.fed || result.bank === 0) continue;
        const run = widest(angle, power);
        if (run) offer(Math.round(run.start + (run.length - 1) / 2), power, run.length);
      }
    }
  }
  if (!best) return { verb: "wait" };
  // A shot whose window is mostly misses is a shot a player holds. Unless the
  // belly is nearly empty, in which case anything is better than nothing.
  const needed = frenzy ? spread : spread + 1;
  if (best.robustness < needed && !urgent) return { verb: "wait" };
  return best;
}

/**
 * The best shot at a crate on the rail, or null. A coarse sweep of the barrel
 * at a few charges finds the shots the rules say will break it; the widest
 * run of neighbouring angles that also break it is what the bot's own noise
 * can live with. The coin is the crate's own: no other opens it.
 */
function crateAction(view, config, now) {
  if (!view.crates || !view.crates.length) return null;
  // A crate only opens for its own coin.
  const ingredient = view.crates[0].ingredient;
  const base = now === view.tick ? view : { ...view, tick: now };
  const spread = Math.ceil(config.noise) + 1;
  const cache = new Map();
  const hits = (angle, power) => {
    if (angle < ARENA.minAngle || angle > ARENA.maxAngle) return false;
    const key = angle * 100 + power;
    let result = cache.get(key);
    if (result === undefined) { result = probeFlight(base, ingredient, angle, power, 160); cache.set(key, result); }
    return result.crate === true;
  };
  let best = null;
  for (const power of [16, 14, 12, 10]) {
    for (let angle = ARENA.minAngle; angle <= ARENA.maxAngle; angle += 2) {
      if (!hits(angle, power)) continue;
      // The run of neighbouring angles that also break it.
      let lo = angle; while (lo - 1 >= angle - spread && hits(lo - 1, power)) lo -= 1;
      let hi = angle; while (hi + 1 <= angle + spread && hits(hi + 1, power)) hi += 1;
      const robustness = hi - lo + 1;
      const centre = Math.round((lo + hi) / 2);
      const ticks = cache.get(centre * 100 + power)?.ticks ?? 99;
      const value = robustness * 30 - ticks;
      if (!best || value > best.value) best = { verb: "launch", ingredient, angle: centre, power, ticks, bank: 1, robustness, value, crate: true };
    }
  }
  if (!best || best.robustness < Math.max(2, spread)) return null;
  return best;
}

/**
 * Whether two plans are different decisions rather than the same decision
 * expressed a degree apart.
 */
function differs(a, b) {
  if (!a || !b) return a !== b;
  if (a.verb !== b.verb) return true;
  if (a.verb !== "launch") return false;
  if (a.ingredient !== b.ingredient) return true;
  if (Math.abs(a.angle - b.angle) >= 6) return true;
  if (Math.abs(a.power - b.power) >= 3) return true;
  return false;
}

/** A plan has to hold for this many ticks before it counts as a decision. */
const SETTLE_TICKS = 5;

function canLaunch(state, config = null) {
  if (state.phase !== "playing") return false;
  if (state.tick - state.lastLaunchTick < cooldownFor(state)) return false;
  // A hand slower than the launcher: at least this long between shots, frenzy or not.
  if (config && config.shotGap && state.tick - state.lastLaunchTick < config.shotGap) return false;
  if (state.projectiles.filter((item) => item.kind === "food").length >= ARENA.maxProjectiles) return false;
  if (state.hatchClosedUntil > state.tick) return false;
  if (state.reloadUntil > state.tick) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * The bots.
 * ------------------------------------------------------------------ */
/**
 * `feedBelow` is where a bot starts serving. FEAST wants constant feeding, so
 * the thresholds are high; what separates the tiers is aim, chew-reading and
 * bank-seeking, not rationing.
 */
const BOTS = {
  naive: { blind: true, latency: 0, noise: 0 },
  // Sets the barrel once — the one angle and charge that lands the most coins
  // at the start of the shift — and never touches it again. Otherwise plays
  // like the moderate bot: serves the craving, waits for the mouth to open.
  // The player the stage 6 brief is about: is one setting enough?
  fixed: { fixed: true, latency: Math.round(0.25 * TICKS), noise: 4, feedBelow: 80 },
  // The same, but the one setting is chosen from shots that go straight in —
  // no bank off a prop — which is what "set the cannon at the right angle"
  // means to a person.
  fixedDirect: { fixed: true, direct: true, latency: Math.round(0.25 * TICKS), noise: 4, feedBelow: 80 },
  moderate: { latency: Math.round(0.25 * TICKS), noise: 4, feedBelow: 80, bankChance: 0.25, crateChance: 0.6, crateBelow: 84 },
  // The moderate bot with a human's hands: dead on with HEMI's straight shot,
  // loose with Ether's float and worse with Bitcoin's lob. The player who
  // never switches coins is this bot with DNFI_BOT_ONLY=pepper.
  lopsided: { latency: Math.round(0.25 * TICKS), noise: 4, noiseBy: { pepper: 1.5, balloon: 8, metal: 12 }, feedBelow: 80, bankChance: 0.25, crateChance: 0.6, crateBelow: 84 },
  // The lopsided bot with a person's other costs: most of a second to change
  // coins and find the new arc, and no faster than a shot every half second.
  human: { latency: Math.round(0.3 * TICKS), noise: 4, noiseBy: { pepper: 2, balloon: 8, metal: 12 }, switchDelay: Math.round(0.8 * TICKS), shotGap: 30, feedBelow: 80, bankChance: 0, crateChance: 0.4, crateBelow: 84 },
  good: { latency: Math.round(0.15 * TICKS), noise: 1.5, feedBelow: 78, bankChance: 1, crateChance: 1, crateBelow: 82 },
  // Not a gamer. `eyeball` aims at the middle of the mouth with a free-flight
  // guess instead of searching the rules for the widest landing window; the
  // hand is loose (±12°) and slow (450 ms); the charge is a tap or a full
  // hold; a shot goes off at most every `shotGap` ticks however fast the
  // launcher reloads. What makes it a person is the hand and the pace, not
  // the aim: it still asks the rules' probe which of its one or two candidate
  // angles would land, and almost every shot it fires is one that would.
  // Calibrated against a non-gamer playtester's shifts (about 1:40 on average
  // before D174): on the v8 rules, 200 shifts, its median was 91 s and its mean 123 s.
  casual: { eyeball: true, latency: Math.round(0.45 * TICKS), noise: 12, feedBelow: 80, powers: [11, ARENA.maxPower], shotGap: 50 },
};
// Development only: extra or overriding bot configs for a calibration sweep.
if (process.env.BOT_EXTRA) {
  try {
    Object.assign(BOTS, JSON.parse(process.env.BOT_EXTRA));
  } catch (error) {
    throw new Error(`BOT_EXTRA is not a JSON object of bot configs: ${error.message}`);
  }
}

function mutationCount(state) {
  return FOODS.filter((food) => (state.mutations[food] ?? 0) > 0).length;
}

/**
 * Plays one shift. `trackDensity` turns on the every-tick evaluation of the
 * best action, which is too slow to leave on for every run.
 */
export function playShift(name, seed, { trackDensity = false, timeline = false, inherited = null, configOverride = null } = {}) {
  const config = configOverride ? { ...BOTS[name], ...configOverride } : BOTS[name];
  const noise = stream(seed ^ 0x5bf03635);
  const state = createArcade(seed, inherited);
  const commands = [];
  const history = [];
  const depth = config.latency + 1;
  let changes = 0;
  let ticksObserved = 0;
  let run = { action: null, count: 0 };
  let counted = null;
  let pending = [];
  let cycle = 0;
  // A hand changing coins: the coin last fired, and when a switch to another one is ready.
  let loaded = null; let switchReady = null;
  const crateWanted = new Map();
  let crateShots = 0;
  let setting = null;
  if (config.fixed) {
    // The single best setting at the start: most coins landing, then the widest window.
    let best = null;
    for (let power = ARENA.minPower; power <= ARENA.maxPower; power += 1) {
      for (let angle = ARENA.minAngle; angle <= ARENA.maxAngle; angle += 1) {
        let coins = 0; let window = 0;
        const lands = (r) => r.fed && (!config.direct || (r.bank === 0 && r.bounces === 0));
        for (const food of FOODS) {
          if (!lands(probeFlight(state, food, angle, power, PROBE_TICKS))) continue;
          coins += 1;
          for (let d = -4; d <= 4; d += 1) if (lands(probeFlight(state, food, angle + d, power, PROBE_TICKS))) window += 1;
        }
        const value = coins * 100 + window;
        if (!best || value > best.value) best = { angle, power, value };
      }
    }
    setting = best;
  }
  if (process.env.BOT_DEBUG && setting) console.log(`[${name}] setting ${setting.angle}° p${setting.power} (value ${setting.value})`);
  /** The angle each launch was planned at, before the bot's own noise. */
  const planned = [];
  const samples = [];
  const markers = {
    firstMutation: null, firstStack: null, firstFrenzy: null, end: null,
    // Pacing: the tick each mark was reached, or null if the run never got there.
    firstLevel: null, size15: null, size20: null, firstMax: null, allMax: null,
    // Stage 6: the first block broken open.
    firstBlock: null,
  };

  while (state.phase === "playing" && state.tick < MAX_TICKS) {
    history.push(viewOf(state));
    if (history.length > depth) history.shift();
    const view = history[0];
    pending = pending.filter((landing) => landing + TUNING.chewTicks > state.tick);

    if (trackDensity && !config.blind) {
      const action = bestAction(view, config, pending, false, state.tick);
      ticksObserved += 1;
      if (run.action && !differs(action, run.action)) run.count += 1;
      else run = { action, count: 1 };
      if (run.count === SETTLE_TICKS) {
        if (counted !== null && differs(run.action, counted)) changes += 1;
        if (counted === null || differs(run.action, counted)) counted = run.action;
      }
    }

    if (config.fixed) {
      const frenzy = view.tick < view.frenzyUntil;
      const urgentCraving = view.craving && view.craving.endsAt - view.tick < 180;
      const open = frenzy || view.tick >= view.creature.chewUntil;
      if (canLaunch(state, config) && open && (view.hunger < config.feedBelow || urgentCraving || frenzy)) {
        const ingredient = pickIngredient(view);
        const angle = clampAngle(setting.angle + (noise() * 2 - 1) * config.noise);
        if (launchFood(state, ingredient, angle, setting.power)) {
          commands.push({ tick: state.tick, kind: "launch", ingredient, angle, power: setting.power });
          planned.push(setting.angle);
        }
      }
    } else if (config.eyeball) {
      // A person's shot: the barrel at the middle of the mouth by a free-flight
      // guess, with a loose hand on top. It fires when the probe says the coin
      // goes in; when none of its candidates would, it fires anyway within a
      // tick or two (a coin flip a tick), or at once if the belly is low — so
      // nearly every shot is a probe-confirmed lander (97 % over 30 shifts),
      // and every shot it fires is remembered as a possible landing, so it
      // leads its own chew as if the coin went in.
      const frenzy = view.tick < view.frenzyUntil;
      const urgentCraving = view.craving && view.craving.endsAt - view.tick < 180;
      const open = frenzy || view.tick >= view.creature.chewUntil;
      if (canLaunch(state, config) && open && (view.hunger < config.feedBelow || urgentCraving || frenzy)) {
        const ingredient = pickIngredient(view);
        const base = { ...view, tick: state.tick };
        const mouth = view.creature;
        const reach = Math.max(70, (mouth.ry ?? 69) * (mouth.gape ?? 1) * 1.1);
        let choice = null;
        for (const power of config.powers ?? POWERS) {
          for (const degrees of solveAngles(mouth.x, mouth.y, power, ingredient, reach)) {
            const angle = clampAngle(degrees);
            const result = probeFlight(base, ingredient, angle, power, PROBE_TICKS);
            const lands = result.fed && !intoOwnChew(pending, state.tick + result.ticks, view);
            const value = (lands ? 1000 : 0) - result.ticks;
            if (!choice || value > choice.value) choice = { angle, power, lands, ticks: result.ticks, value };
          }
        }
        if (choice && (choice.lands || view.hunger < 40 || noise() < 0.5)) {
          const angle = clampAngle(choice.angle + (noise() * 2 - 1) * config.noise);
          if (launchFood(state, ingredient, angle, choice.power)) {
            commands.push({ tick: state.tick, kind: "launch", ingredient, angle, power: choice.power });
            planned.push(choice.angle);
            pending.push(state.tick + choice.ticks);
          }
        }
      }
    } else if (config.blind) {
      if (canLaunch(state, config)) {
        const ingredient = FOODS[cycle % FOODS.length];
        if (launchFood(state, ingredient, ARENA.defaultAngle, ARENA.defaultPower)) {
          cycle += 1;
          commands.push({ tick: state.tick, kind: "launch", ingredient, angle: ARENA.defaultAngle, power: ARENA.defaultPower });
        }
      }
    } else if (canLaunch(state, config) && (() => {
      // A crate on the rail: a bot that has decided to go for this one shoots
      // at it whenever it has a shot, and does not wait for the belly.
      const crate = view.crates && view.crates[0];
      if (!crate || view.hunger >= config.crateBelow) return false;
      if (!crateWanted.has(crate.id)) crateWanted.set(crate.id, config.crateChance >= 1 || noise() < config.crateChance);
      if (!crateWanted.get(crate.id)) return false;
      const action = crateAction(view, config, state.tick);
      if (!action) return false;
      const jitter = (noise() * 2 - 1) * config.noise;
      const angle = clampAngle(action.angle + jitter);
      if (!launchFood(state, action.ingredient, angle, action.power)) return false;
      commands.push({ tick: state.tick, kind: "launch", ingredient: action.ingredient, angle, power: action.power });
      planned.push(action.angle);
      crateShots += 1;
      return true;
    })()) {
      // fired at a crate
    } else if (canLaunch(state, config)) {
      const frenzy = view.tick < view.frenzyUntil;
      const urgentCraving = view.craving && view.craving.endsAt - view.tick < 180;
      if (view.hunger < config.feedBelow || urgentCraving || frenzy) {
        // Trick shots are for a full belly. Below the line, the fast shot.
        const wantBank = view.hunger > 60 && (config.bankChance >= 1 || (config.bankChance > 0 && noise() < config.bankChance));
        const action = bestAction(view, config, pending, wantBank, state.tick);
        // A person needs a moment to press another number and find the new arc.
        let switching = false;
        if (action && action.verb === "launch" && config.switchDelay && loaded !== null && action.ingredient !== loaded) {
          switchReady ??= state.tick + config.switchDelay;
          switching = state.tick < switchReady;
        }
        if (action && action.verb === "launch" && !switching) {
          loaded = action.ingredient; switchReady = null;
          let jitter = (noise() * 2 - 1) * (config.noiseBy?.[action.ingredient] ?? config.noise);
          // A fumbled shot now and then, wide enough to miss outright: a person's hands, not a bot's.
          if (config.fumble && noise() < config.fumble) jitter += (noise() < 0.5 ? -1 : 1) * (10 + 10 * noise());
          const angle = clampAngle(action.angle + jitter);
          if (launchFood(state, action.ingredient, angle, action.power)) {
            commands.push({ tick: state.tick, kind: "launch", ingredient: action.ingredient, angle, power: action.power });
            planned.push(action.angle);
            pending.push(state.tick + action.ticks);
            if (process.env.BOT_DEBUG) console.log(`[bot] t=${state.tick} plan a=${action.angle} p=${action.power} robust=${action.robustness} bank=${action.bank} ticks=${action.ticks} wantBank=${wantBank} fired a=${angle} hunger=${view.hunger.toFixed(0)} frenzy=${frenzy}`);
          }
        }
      }
    }
    stepArcade(state);
    const live = mutationCount(state);
    if (live >= 1 && markers.firstMutation === null) markers.firstMutation = state.tick;
    if (live >= 2 && markers.firstStack === null) markers.firstStack = state.tick;
    if (state.frenzies >= 1 && markers.firstFrenzy === null) markers.firstFrenzy = state.tick;
    if ((state.cratesBroken ?? 0) >= 1 && markers.firstBlock === null) markers.firstBlock = state.tick;
    if (markers.firstLevel === null && arcade.mutationLoad(state.mutations) >= 1) markers.firstLevel = state.tick;
    if (markers.size15 === null && state.size >= 1.5) markers.size15 = state.tick;
    if (markers.size20 === null && state.size >= 2) markers.size20 = state.tick;
    if (markers.firstMax === null && FOODS.some((food) => state.mutations[food] >= TUNING.maxLevel)) markers.firstMax = state.tick;
    if (markers.allMax === null && FOODS.every((food) => state.mutations[food] >= TUNING.maxLevel)) markers.allMax = state.tick;
    if (timeline && state.tick % TICKS === 0) {
      samples.push({ t: state.tick / TICKS, size: state.size, hunger: Math.round(state.hunger), rage: Math.round(state.rage), feeds: state.totalFeeds,
        appetite: state.appetite, frenzy: state.tick < state.frenzyUntil, levels: arcade.mutationLoad(state.mutations), drain: round(arcade.drainPerTick(state) * TICKS, 2) });
    }
  }
  markers.end = state.tick;

  return {
    seed,
    markers,
    ticks: state.tick,
    seconds: state.tick / TICKS,
    score: state.score,
    feeds: state.totalFeeds,
    shots: state.shots,
    clanks: state.clanks,
    misses: state.misses,
    frenzies: state.frenzies,
    banks: state.banks,
    cooked: state.cooked,
    utensils: state.utensils,
    cratesBroken: state.cratesBroken ?? 0,
    cratesLost: state.cratesLost ?? 0,
    crateShots,
    ...aimMoves(commands, state.tick, planned),
    bestCombo: state.bestCombo,
    size: state.size,
    mutations: { ...state.mutations },
    phase: state.phase,
    cause: state.failureReason ?? (state.phase === "playing" ? "hit-tick-cap" : state.phase),
    commands,
    timeline: timeline ? samples : null,
    density: trackDensity && ticksObserved > 0 ? changes / (ticksObserved / TICKS / 60) : null,
  };
}

/**
 * How much the barrel moves between shots: re-aims per minute (a launch at
 * least 5° from the one before it), and the mean move in degrees.
 */
function aimMoves(commands, ticks, planned = []) {
  // The share of planned shots within 4° of the shift's single best angle:
  // how far one setting of the barrel would have got this bot.
  let oneAngle = 0;
  if (planned.length) {
    for (let a = ARENA.minAngle; a <= ARENA.maxAngle; a += 1) {
      const n = planned.filter((x) => Math.abs(x - a) <= 4).length;
      if (n > oneAngle) oneAngle = n;
    }
    oneAngle /= planned.length;
  }
  let laneChanges = 0;
  for (let i = 1; i < planned.length; i += 1) if (Math.abs(planned[i] - planned[i - 1]) >= 8) laneChanges += 1;
  let moves = 0; let total = 0; let previous = null; let shots = 0;
  for (const command of commands) {
    if (command.kind !== "launch") continue;
    shots += 1;
    if (previous !== null) {
      const delta = Math.abs(command.angle - previous);
      total += delta;
      if (delta >= 5) moves += 1;
    }
    previous = command.angle;
  }
  return {
    reaimsPerMin: ticks > 0 ? moves / (ticks / TICKS / 60) : 0, meanMove: shots > 1 ? total / (shots - 1) : 0,
    oneAngle, laneChangesPerMin: ticks > 0 ? laneChanges / (ticks / TICKS / 60) : 0,
  };
}

/* ------------------------------------------------------------------ *
 * Reporting.
 * ------------------------------------------------------------------ */
const percentile = (sorted, p) => {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[index];
};
const round = (value, places = 1) => Math.round(value * 10 ** places) / 10 ** places;
const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const median = (values) => percentile([...values].sort((a, b) => a - b), 0.5);

/** Deaths per 30-second bucket, which is the spread gate. */
function buckets(runs) {
  const out = new Map();
  for (const run of runs) {
    const key = Math.floor(run.seconds / 30) * 30;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0])
    .map(([from, count]) => ({ bucket: `${from}-${from + 30}s`, count, share: round(count / runs.length * 100) }));
}

/**
 * Percentiles of a time-to-mark, with the runs that never reached it counted
 * as `Infinity` so that a median of "never" is reported as such rather than
 * as the median of the lucky runs. `reached` is the share of runs that did.
 */
function pacing(runs, key) {
  const times = runs.map((run) => (run.markers[key] === null ? Infinity : run.markers[key] / TICKS)).sort((a, b) => a - b);
  const finite = times.filter(Number.isFinite);
  const pick = (p) => { const value = percentile(times, p); return Number.isFinite(value) ? round(value) : null; };
  return {
    reached: round(finite.length / runs.length * 100),
    p10: pick(0.1), median: pick(0.5), p90: pick(0.9),
    medianOfReached: finite.length ? round(percentile(finite, 0.5)) : null,
  };
}

const PACING_KEYS = ["firstLevel", "size15", "size20", "firstMax", "allMax"];
const PACING_NAMES = { firstLevel: "first level", size15: "size ×1.5", size20: "size ×2.0", firstMax: "first ×3", allMax: "all three ×3" };
const fmtTime = (value) => (value === null ? "never" : `${value}s`);

function summarise(name, runs) {
  const seconds = runs.map((run) => run.seconds).sort((a, b) => a - b);
  const causes = {};
  for (const run of runs) causes[run.cause] = (causes[run.cause] ?? 0) + 1;
  const share = buckets(runs);
  const shots = runs.reduce((a, r) => a + r.shots, 0);
  const feeds = runs.reduce((a, r) => a + r.feeds, 0);
  return {
    bot: name,
    shifts: runs.length,
    survival: {
      p10: round(percentile(seconds, 0.1)),
      median: round(percentile(seconds, 0.5)),
      mean: round(mean(seconds)),
      p90: round(percentile(seconds, 0.9)),
      max: round(seconds[seconds.length - 1]),
    },
    feeds: { median: round(median(runs.map((r) => r.feeds))), mean: round(mean(runs.map((r) => r.feeds))) },
    accuracy: shots ? round(feeds / shots * 100) : 0,
    frenzies: { mean: round(mean(runs.map((r) => r.frenzies)), 2), withAtLeastOne: round(runs.filter((r) => r.frenzies > 0).length / runs.length * 100) },
    banks: { mean: round(mean(runs.map((r) => r.banks)), 2) },
    clanks: { mean: round(mean(runs.map((r) => r.clanks)), 1) },
    cooked: { mean: round(mean(runs.map((r) => r.cooked)), 1) },
    utensils: { mean: round(mean(runs.map((r) => r.utensils)), 2) },
    aim: {
      reaimsPerMin: round(mean(runs.map((r) => r.reaimsPerMin)), 1),
      meanMove: round(mean(runs.map((r) => r.meanMove)), 1),
      oneAngle: round(mean(runs.map((r) => r.oneAngle)) * 100),
      laneChangesPerMin: round(mean(runs.map((r) => r.laneChangesPerMin)), 1),
    },
    crates: {
      brokenPerRun: round(mean(runs.map((r) => r.cratesBroken)), 2),
      shotsPerRun: round(mean(runs.map((r) => r.crateShots)), 2),
      hitRate: round(runs.reduce((a, r) => a + r.cratesBroken, 0) / Math.max(1, runs.reduce((a, r) => a + r.cratesBroken + r.cratesLost, 0)) * 100),
    },
    bestCombo: { median: median(runs.map((r) => r.bestCombo)) },
    score: { median: round(median(runs.map((r) => r.score))) },
    size: { median: round(median(runs.map((r) => r.size)), 2) },
    firstFrenzy: { median: round(median(runs.filter((r) => r.markers.firstFrenzy !== null).map((r) => r.markers.firstFrenzy / TICKS))) },
    pacing: Object.fromEntries(PACING_KEYS.map((key) => [key, pacing(runs, key)])),
    causes,
    deathSpread: share,
    worstBucketShare: share.length ? Math.max(...share.map((item) => item.share)) : 0,
  };
}

function table(rows) {
  const head = ["bot", "n", "p10", "median", "mean", "p90", "max", "feeds", "acc", "frenzies", "banks", "score", "size", "worst 30s"];
  const body = rows.map((row) => [
    row.bot, String(row.shifts), `${row.survival.p10}s`, `${row.survival.median}s`, `${row.survival.mean}s`,
    `${row.survival.p90}s`, `${row.survival.max}s`, String(row.feeds.median), `${row.accuracy}%`,
    String(row.frenzies.mean), String(row.banks.mean),
    String(row.score.median), String(row.size.median), `${row.worstBucketShare}%`,
  ]);
  const widths = head.map((_, index) => Math.max(head[index].length, ...body.map((row) => row[index].length)));
  const line = (cells) => `| ${cells.map((cell, index) => cell.padEnd(widths[index])).join(" | ")} |`;
  return [line(head), `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`, ...body.map(line)].join("\n");
}

function pacingTable(rows) {
  const head = ["bot", ...PACING_KEYS.map((key) => PACING_NAMES[key])];
  const body = rows.map((row) => [row.bot, ...PACING_KEYS.map((key) => {
    const p = row.pacing[key];
    return `${fmtTime(p.median)} (p10 ${fmtTime(p.p10)}, p90 ${fmtTime(p.p90)}, ${p.reached}%)`;
  })]);
  const widths = head.map((_, index) => Math.max(head[index].length, ...body.map((row) => row[index].length)));
  const line = (cells) => `| ${cells.map((cell, index) => cell.padEnd(widths[index])).join(" | ")} |`;
  return [line(head), `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`, ...body.map(line)].join("\n");
}

function parseArgs(argv) {
  const args = { shifts: 200, seed: 1, densityShifts: 8, json: null, fixtures: null, bots: ["naive", "casual", "moderate", "good"], inherited: null };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--shifts") args.shifts = Number(argv[++i]);
    else if (item === "--seed") args.seed = Number(argv[++i]);
    else if (item === "--density-shifts") args.densityShifts = Number(argv[++i]);
    else if (item === "--json") args.json = argv[++i];
    else if (item === "--fixtures") args.fixtures = argv[++i];
    else if (item === "--bots") args.bots = argv[++i].split(",");
    else if (item === "--inherited") args.inherited = argv[++i];
  }
  if (args.inherited !== null && !FOODS.includes(args.inherited)) throw new Error(`--inherited must be one of ${FOODS.join(", ")}`);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const report = { generatedAt: new Date().toISOString(), gameVersion: arcade.GAME_VERSION, shifts: args.shifts, seedBase: args.seed, inherited: args.inherited, bots: [] };
  const shiftOptions = { inherited: args.inherited };

  for (const name of args.bots) {
    const runs = [];
    for (let i = 0; i < args.shifts; i += 1) runs.push(playShift(name, (args.seed + i * 7919) >>> 0, shiftOptions));
    report.bots.push(summarise(name, runs));
    if (name === "moderate") report.sampleRun = { ...runs[0], commands: runs[0].commands.length };
  }

  const density = [];
  for (let i = 0; i < (args.bots.includes("moderate") ? args.densityShifts : 0); i += 1) {
    const run = playShift("moderate", (args.seed + i * 7919) >>> 0, { ...shiftOptions, trackDensity: true });
    if (run.density !== null) density.push(run.density);
  }
  density.sort((a, b) => a - b);
  report.decisionDensity = {
    shifts: density.length,
    median: round(percentile(density, 0.5), 2),
    min: round(density[0] ?? 0, 2),
    max: round(density[density.length - 1] ?? 0, 2),
  };

  // Gates, from the design brief (re-targeted in D174–D176) and the stage 3
  // pacing brief, evaluated here so no report can quietly disagree with them.
  // A gate whose bot was not run is left out rather than failed.
  const byName = Object.fromEntries(report.bots.map((row) => [row.bot, row]));
  const { naive, casual, moderate, good } = byName;
  const between = (value, low, high) => value !== null && value >= low && value <= high;
  // "Not before N s" on a median that may be "never": never is after N.
  const notBefore = (value, low) => value === null || value >= low;
  // Shift length is gated on the casual bot since D174: a person who is not a
  // gamer lasts about three minutes. The bot never misses a craving and never
  // fumbles, so it outlasts a person: on Oct 24 a practiced player lasted
  // 2:17 when this bot's median was 3:47, and the gate moved up to keep the
  // person at three. The never-aiming bot still dies inside a minute and a
  // half, and the moderate bot's shift is long but ends.
  report.gates = {
    ...(naive ? {
      naiveMedian40to80: between(naive.survival.median, 40, 80),
      naiveFeedsAtLeast6: naive.feeds.median >= 6,
    } : {}),
    ...(casual ? {
      casualMedian180to300: between(casual.survival.median, 180, 300),
      casualDeathSpread: casual.worstBucketShare <= 40,
    } : {}),
    ...(moderate ? {
      moderateMedian240to480: between(moderate.survival.median, 240, 480),
      moderateAccuracyAtLeast55: moderate.accuracy >= 55,
      moderateFrenziesAtLeast1: moderate.frenzies.mean >= 1,
      moderateDeathSpread: moderate.worstBucketShare <= 40,
      // Pacing (stage 3): the escalation is the whole shift.
      moderateFirstLevel25to45: between(moderate.pacing.firstLevel.median, 25, 45),
      moderateSize15At60to90: between(moderate.pacing.size15.median, 60, 90),
      moderateSize20At120to180: between(moderate.pacing.size20.median, 120, 180),
      moderateFirstMaxNotBefore150: notBefore(moderate.pacing.firstMax.median, 150),
      // Was 240 when the moderate shift was 150 s; its shift doubled in D174 and
      // the level thresholds did not move, so all three at ×3 lands at about
      // half its shift (D176 has the option of raising the third threshold).
      moderateAllMaxNotBefore180: notBefore(moderate.pacing.allMax.median, 180),
      moderateFirstFrenzyInside40: moderate.firstFrenzy.median <= 40 && moderate.frenzies.withAtLeastOne >= 50,
    } : {}),
    // Decision density is only a gate when it was measured (`--density-shifts`).
    ...(moderate && report.decisionDensity.shifts > 0 ? { decisionDensityAtLeast6: report.decisionDensity.median >= 6 } : {}),
    ...(naive && good ? { goodAtLeast1p8xNaive: good.survival.median >= naive.survival.median * 1.8 } : {}),
  };
  report.gatesPass = Object.values(report.gates).every(Boolean);
  report.elapsedSeconds = round((Date.now() - started) / 1000);

  console.log(table(report.bots));
  console.log("");
  for (const row of report.bots) {
    console.log(`${row.bot.padEnd(9)} causes: ${JSON.stringify(row.causes)}  clanks/run ${row.clanks.mean}  cooked/run ${row.cooked.mean}  utensils/run ${row.utensils.mean}  best combo ${row.bestCombo.median}  first frenzy ${row.firstFrenzy.median}s (${row.frenzies.withAtLeastOne}% of runs)`);
    console.log(`${"".padEnd(9)} aim: ${row.aim.oneAngle}% of planned shots within 4° of one barrel setting; ${row.aim.laneChangesPerMin} planned moves of 8°+ per min; ${row.aim.reaimsPerMin} actual moves of 5°+ per min, mean move ${row.aim.meanMove}°`);
    console.log(`${"".padEnd(9)} crates: broken/run ${row.crates.brokenPerRun}, shots at crates/run ${row.crates.shotsPerRun}, crates broken ${row.crates.hitRate}% of those that came`);
    console.log(`${"".padEnd(9)} deaths: ${row.deathSpread.map((b) => `${b.bucket} ${b.share}%`).join(", ")}`);
  }
  console.log("");
  console.log("pacing (median; p10, p90; share of runs that reached it):");
  console.log(pacingTable(report.bots));
  console.log("");
  if (byName.moderate) console.log(`decision density (moderate): median ${report.decisionDensity.median}/min over ${report.decisionDensity.shifts} shifts (${report.decisionDensity.min}-${report.decisionDensity.max})`);
  console.log("");
  for (const [gate, ok] of Object.entries(report.gates)) console.log(`${ok ? "PASS" : "FAIL"}  ${gate}`);
  console.log(`\n${report.gatesPass ? "ALL GATES PASS" : "GATES FAILING"}  (${report.elapsedSeconds}s)`);

  if (args.json) {
    await writeFile(path.resolve(ROOT, args.json), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${args.json}`);
  }

  // Six frozen traces — one per plain bot, then one per inherited trait — so
  // the replay test has something real to reproduce rather than a synthetic
  // command list.
  if (args.fixtures) {
    const traces = [];
    // Three plain shifts, then one per inherited trait (the moderate bot, a seed of its own each).
    const plans = ["naive", "moderate", "good"].map((name, index) => ({ name, index, inherited: null }));
    FOODS.forEach((trait, index) => plans.push({ name: "moderate", index: 3 + index, inherited: trait }));
    for (const { name, index, inherited } of plans) {
      const seed = (args.seed + index * 104729) >>> 0;
      const run = playShift(name, seed, { inherited });
      const final = replayArcade(seed, run.commands, run.ticks, inherited);
      traces.push({
        bot: name, seed, inherited, endTick: run.ticks, commands: run.commands,
        expect: { score: final.score, totalFeeds: final.totalFeeds, phase: final.phase, failureReason: final.failureReason },
      });
    }
    await writeFile(path.resolve(ROOT, args.fixtures),
      `${JSON.stringify({ gameVersion: arcade.GAME_VERSION ?? null, traces }, null, 2)}\n`);
    console.log(`wrote ${args.fixtures} (${traces.length} traces)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
