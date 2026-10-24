import assert from "node:assert/strict";
import test from "node:test";
import {
  ARENA, BOUNCERS, FOODS, TUNING, GAME_VERSION, bankMultiplier, cooldownFor, createArcade, drainPerTick, launchSpeed,
  endingFor, flameCone, getHazard, launchFood, levelFor, mouthIsTeeth, previewFlight, probeFlight, pressE, replayArcade, servingsForLevel, slamHatch,
  stepArcade,
} from "../lib/game/arcade.ts";
import { PRESS_E_EVERY, PRESS_E_FIRST, PRESS_E_FLIGHT, PRESS_E_OPEN } from "../lib/game/pressE.ts";
import { decodeTrace, encodeTrace, validateTrace } from "../lib/chain/trace.ts";

const GRAVITY = 0.16;

function advance(state, tick) {
  while (state.tick < tick && state.phase === "playing") stepArcade(state);
}

function canLaunch(state) {
  return state.tick - state.lastLaunchTick >= cooldownFor(state) && state.tick >= state.reloadUntil
    && state.tick >= state.hatchClosedUntil
    && state.projectiles.filter((p) => p.kind === "food").length < ARENA.maxProjectiles;
}

/** The two launch angles that put a shot of `power` through (tx, ty), ignoring everything but gravity. */
function solveAngles(tx, ty, power) {
  const out = [];
  let sx = ARENA.launcher.x + Math.cos(-0.7) * ARENA.barrelLength;
  let sy = ARENA.launcher.y + Math.sin(-0.7) * ARENA.barrelLength;
  for (let pass = 0; pass < 2; pass += 1) {
    out.length = 0;
    const dx = tx - sx;
    const up = sy - ty;
    const v2 = power * power;
    const disc = v2 * v2 - GRAVITY * (GRAVITY * dx * dx + 2 * up * v2);
    if (disc < 0 || dx <= 0) return [];
    for (const sign of [1, -1]) {
      const degrees = -Math.atan((v2 + sign * Math.sqrt(disc)) / (GRAVITY * dx)) * 180 / Math.PI;
      if (degrees >= ARENA.minAngle && degrees <= ARENA.maxAngle) out.push(Math.round(degrees));
    }
    if (!out.length) return [];
    const radians = out[out.length - 1] * Math.PI / 180;
    sx = ARENA.launcher.x + Math.cos(radians) * ARENA.barrelLength;
    sy = ARENA.launcher.y + Math.sin(radians) * ARENA.barrelLength;
  }
  return out;
}

/**
 * A shot the rules themselves say will land right now, found once per state
 * with a bounded search: the ballistic solution to the mouth at every power,
 * a degree either side, then a coarse sweep only if that failed.
 */
function landingShot(state, ingredient = state.wanted, want = (r) => r.fed) {
  const tried = new Set();
  const probe = (angle, power) => {
    const key = `${angle}/${power}`;
    if (tried.has(key)) return null;
    tried.add(key);
    const result = probeFlight(state, ingredient, angle, power, 200);
    return want(result) ? { angle, power, ticks: result.ticks, result } : null;
  };
  for (let power = ARENA.maxPower; power >= ARENA.minPower; power -= 1) {
    for (const base of solveAngles(state.creature.x, state.creature.y, power)) {
      for (const angle of [base, base - 1, base + 1]) {
        if (angle < ARENA.minAngle || angle > ARENA.maxAngle) continue;
        const hit = probe(angle, power);
        if (hit) return hit;
      }
    }
  }
  for (let power = ARENA.maxPower; power >= ARENA.minPower; power -= 1) {
    for (let angle = ARENA.minAngle; angle <= ARENA.maxAngle; angle += 2) {
      const hit = probe(angle, power);
      if (hit) return hit;
    }
  }
  return null;
}

/** Waits for the launcher, takes the landing shot, and steps until it is swallowed. */
function feedOnce(state, ingredient = state.wanted, patience = 900) {
  const before = state.totalFeeds;
  for (let i = 0; i < patience && state.phase === "playing"; i += 1) {
    if (canLaunch(state)) {
      const shot = landingShot(state, ingredient);
      if (shot) {
        assert.ok(launchFood(state, ingredient, shot.angle, shot.power));
        const id = state.projectiles[state.projectiles.length - 1].id;
        while (state.phase === "playing" && state.projectiles.some((p) => p.id === id && !p.spent)
               && state.tick < ARENA.maxTicks) stepArcade(state);
        if (state.totalFeeds > before) return true;
        // The probe sees a shot alone in the air. A beat it could not see
        // coming (a sneeze blows everything in the air back) can spoil one;
        // take another.
        continue;
      }
    }
    stepArcade(state);
  }
  return false;
}

function fresh(seed = 1) {
  const state = createArcade(seed);
  // No crates on the rail: these tests are about the mouth, the props and the
  // mutations, and a crate coming down mid-flight is a thing the probe cannot
  // see coming (tests/aim.test.mjs covers the crates).
  state.crateAt = 1e9;
  // Past the grace period, so the drain is live and the first craving has arrived.
  advance(state, 260);
  return state;
}

function newEvents(state, sinceId) {
  return state.events.filter((e) => e.id >= sinceId);
}

function makeFood(state, ingredient, x, y, vx, vy, extra = {}) {
  const food = {
    id: state.nextProjectileId++, ingredient, kind: "food", x, y, vx, vy,
    age: 0, bounces: 0, bank: 0, hitMask: 0, lastSurface: "", lastBank: "", hazardBounces: 0,
    assisted: false, cooked: false, spent: false, ...extra,
  };
  state.projectiles.push(food);
  return food;
}

function mutate(state, ingredient, level) {
  // Jump to one serving short of the threshold, then land the one that counts,
  // so a level test does not spend forty catches getting there.
  state.servings[ingredient] = Math.max(state.servings[ingredient], servingsForLevel(level) - 1);
  assert.ok(feedOnce(state, ingredient), `could not land the serving that makes ${ingredient} level ${level}`);
  assert.equal(state.mutations[ingredient], level);
}

test("the version is 11, the shift is endless, and the pillars' constants hold", () => {
  assert.equal(GAME_VERSION, 11);
  assert.equal(ARENA.maxTicks, 43200);
  assert.equal(ARENA.cooldownTicks, 30);
  assert.equal(ARENA.frenzyCooldownTicks, 15);
  assert.equal(ARENA.maxProjectiles, 6);
  assert.equal(TUNING.chewTicks, 36);
  assert.equal(TUNING.frenzyAt, 5);
  assert.equal(TUNING.frenzyTicks, 360);
  assert.ok(BOUNCERS.length >= 5);
  assert.deepEqual(BOUNCERS.map((b) => b.name).sort(), ["chain", "lamp", "pan", "pot", "shelf"]);
});

test("the mouth is open by default and the default shot lands in it", () => {
  const state = createArcade(1);
  assert.equal(state.creature.aperture, 1);
  assert.equal(state.creature.untilOpen, -1);
  assert.equal(state.creature.chewUntil, 0);
  // The default is a HEMI: the coin the page loads first, the one that flies straight.
  const result = probeFlight(state, "pepper", ARENA.defaultAngle, ARENA.defaultPower);
  assert.ok(result.fed, "the default angle and power must feed a resting creature");
  assert.ok(result.ticks < 70, "and quickly");
});

test("every catch is followed by a chew, telegraphed on the creature and as an event", () => {
  const state = fresh();
  const seen = state.nextEventId;
  assert.ok(feedOnce(state));
  const chew = newEvents(state, seen).find((e) => e.type === "chew");
  assert.ok(chew, "a chew event");
  assert.equal(chew.value, TUNING.chewTicks);
  assert.equal(state.creature.chewUntil, chew.tick + TUNING.chewTicks);
  stepArcade(state);
  assert.ok(state.creature.aperture < 1, "the aperture closes while chewing");
  assert.ok(state.creature.untilOpen > 0 && state.creature.untilOpen < TUNING.chewTicks);
  assert.equal(state.creature.open, state.creature.aperture);
  advance(state, state.creature.chewUntil);
  assert.equal(state.creature.aperture, 1, "and reopens when the chew ends");
  assert.equal(state.creature.untilOpen, -1);
});

test("a snack arriving mid-chew clanks off the teeth: lost, combo reset, almost no irritation", () => {
  const state = fresh();
  assert.ok(feedOnce(state));
  // The jaws snap shut on a catch and stay shut for most of the chew: the
  // mouth is teeth. (A shot fired from the cannon after the catch takes
  // longer to arrive than they stay shut, so the snack is put in the air
  // beside the mouth: it is a coin that was already flying.)
  advance(state, state.tick + 10);
  assert.ok(mouthIsTeeth(state.creature), "the jaws are shut");
  state.combo = 3;
  const rage = state.rage;
  const feeds = state.totalFeeds;
  const seen = state.nextEventId;
  const m = state.creature.mouth;
  const id = makeFood(state, "pepper", m.midX - 60, m.midY, 8, 0).id;
  advance(state, state.tick + 10);
  const snack = state.projectiles.find((p) => p.id === id);
  assert.ok(snack && snack.spent, "the snack is spent, not swallowed");
  assert.equal(state.totalFeeds, feeds);
  assert.equal(state.clanks, 1);
  assert.equal(state.combo, 0);
  assert.ok(state.rage - rage <= TUNING.clankRage + 0.01, "a clank costs no more than a pinch of irritation");
  const clank = newEvents(state, seen).find((e) => e.type === "clank");
  assert.ok(clank && clank.ingredient === "pepper");
  // When it eventually drops it is not a miss: paid for already.
  const misses = state.misses;
  while (state.projectiles.some((p) => p.id === id) && state.phase === "playing") stepArcade(state);
  assert.equal(state.misses, misses);
});

test("bank multipliers: floor is a lesser bank, bouncers double, triple, quadruple", () => {
  assert.equal(bankMultiplier(0, 0), 1);
  assert.equal(bankMultiplier(0, 1), TUNING.floorBank);
  assert.equal(bankMultiplier(1, 0), 2);
  assert.equal(bankMultiplier(1, 1), 2);
  assert.equal(bankMultiplier(2, 0), 3);
  assert.equal(bankMultiplier(3, 0), 4);
  assert.equal(bankMultiplier(7, 0), 4);
});

test("a serving off a kitchen bouncer is caught as a named bank and pays the multiplier", () => {
  const state = fresh(3);
  let coin = null; let shot = null;
  for (const food of FOODS) { shot = landingShot(state, food, (r) => r.fed && r.bank >= 1); if (shot) { coin = food; break; } }
  assert.ok(shot, "a bank shot exists from the resting state");
  const seen = state.nextEventId;
  const score = state.score;
  assert.ok(launchFood(state, coin, shot.angle, shot.power));
  advance(state, state.tick + shot.ticks + 1);
  const events = newEvents(state, seen);
  const bounce = events.find((e) => e.type === "bounce" && e.name !== "floor");
  assert.ok(bounce, "a bounce event naming the surface");
  const names = [...BOUNCERS.map((b) => b.name), "belly", "vent"];
  assert.ok(names.includes(bounce.name), `bounce off a known surface, got ${bounce.name}`);
  const bank = events.find((e) => e.type === "bank");
  assert.ok(bank, "a bank event on the catch");
  assert.equal(bank.value, bankMultiplier(shot.result.bank, shot.result.bounces));
  assert.ok(bank.value >= 2);
  assert.match(bank.label, /×[234]$/);
  const feed = events.find((e) => e.type === "feed");
  assert.ok(feed.value >= 100 * bank.value, "the serving paid at least base times the multiplier");
  assert.ok(state.score - score >= feed.value);
  assert.equal(state.banks, 1);
});

test("the bouncers are static colliders a snack reflects off, and each one pays once per snack", () => {
  const state = createArcade(1);
  const pan = BOUNCERS.find((b) => b.kind === "circle" && b.name === "pan");
  // Drop a snack straight onto the pan from above.
  const food = makeFood(state, "metal", pan.x, pan.y - pan.r - 30, 0, 4);
  stepArcade(state);
  for (let i = 0; i < 12 && food.vy > 0; i += 1) stepArcade(state);
  assert.ok(food.vy < 0, "it bounced back up");
  assert.equal(food.bank, pan.banks);
  assert.equal(food.lastBank, "pan");
  // Every later touch of the same pan reflects, credited no further. (It may
  // bank off another surface on the way; that is the other surface's bank.)
  const seen = state.nextEventId;
  for (let i = 0; i < 90 && state.projectiles.includes(food); i += 1) stepArcade(state);
  const panBanks = newEvents(state, seen).filter((e) => e.type === "bounce" && e.name === "pan" && e.value > 0);
  assert.equal(panBanks.length, 0, "a second contact with the same pan is not a second bank");
});

test("five catches in a row is a FRENZY: huge mouth, no chewing, half cooldown, triple score, six seconds", () => {
  const state = fresh(2);
  for (let i = 0; i < TUNING.frenzyAt - 1; i += 1) assert.ok(feedOnce(state), `catch ${i + 1}`);
  assert.equal(state.combo, TUNING.frenzyAt - 1);
  assert.equal(state.frenzies, 0);
  const seen = state.nextEventId;
  assert.ok(feedOnce(state), "the fifth catch");
  assert.equal(state.frenzies, 1);
  const start = newEvents(state, seen).find((e) => e.type === "frenzy" && e.name === "start");
  assert.ok(start);
  assert.equal(start.value, TUNING.frenzyTicks);
  assert.equal(state.frenzyUntil, start.tick + TUNING.frenzyTicks);
  assert.equal(cooldownFor(state), ARENA.frenzyCooldownTicks);
  stepArcade(state);
  assert.equal(state.creature.gape, TUNING.frenzyGape);
  assert.equal(state.creature.aperture, 1, "a frenzy does not chew");
  // A catch inside the frenzy: no chew, triple points.
  const before = state.nextEventId;
  const combo = state.combo;
  assert.ok(feedOnce(state));
  const events = newEvents(state, before);
  assert.ok(!events.some((e) => e.type === "chew"), "no chew event in a frenzy");
  const feed = events.find((e) => e.type === "feed");
  const base = 100 + TUNING.comboBonus * Math.min(TUNING.comboBonusMax, combo);
  const bank = events.find((e) => e.type === "bank");
  const multiplier = bank ? bank.value : 1;
  const craved = feed.craved ? TUNING.cravingBonus * TUNING.frenzyScore : 0;
  assert.equal(feed.value, Math.round(base * multiplier * TUNING.frenzyScore) + craved);
  // It ends on its own and takes the combo with it.
  advance(state, state.frenzyUntil);
  const end = state.events.find((e) => e.type === "frenzy" && e.name === "end");
  assert.ok(end);
  assert.equal(state.combo, 0);
  assert.equal(cooldownFor(state), ARENA.cooldownTicks);
});

test("a floor miss resets the combo and costs irritation; the chew window does not", () => {
  const state = fresh();
  assert.ok(feedOnce(state));
  assert.ok(feedOnce(state));
  assert.equal(state.combo, 2);
  const rage = state.rage;
  // A shot nobody could land: flat and weak, straight onto the floor.
  while (!canLaunch(state)) stepArcade(state);
  assert.ok(launchFood(state, "metal", ARENA.maxAngle, ARENA.minPower));
  const id = state.projectiles[state.projectiles.length - 1].id;
  while (state.projectiles.some((p) => p.id === id)) stepArcade(state);
  assert.equal(state.misses, 1);
  assert.equal(state.combo, 0);
  assert.ok(state.rage > rage, "a miss costs irritation");
  assert.ok(state.events.some((e) => e.type === "miss"));
});

test("METAL: metal curves in, cutlery storms fly, a fork in the mouth pays, a fork on the launcher jams it", () => {
  const state = fresh(5);
  mutate(state, "metal", 1);
  assert.ok(state.events.some((e) => e.type === "mutation" && e.ingredient === "metal"));
  // Attraction: the same shot flies differently as metal than as pepper.
  const metal = probeFlight(state, "metal", -50, 12, 200);
  const pepper = probeFlight(state, "pepper", -50, 12, 200);
  assert.notDeepEqual([metal.x, metal.y, metal.ticks], [pepper.x, pepper.y, pepper.ticks]);
  // A storm piece arrives on the metal clock.
  const seen = state.nextEventId;
  advance(state, state.junkAt + 1);
  const loose = newEvents(state, seen).find((e) => e.type === "utensil" && e.name === "loose");
  assert.ok(loose, "cutlery tears off the wall");
  assert.ok(state.projectiles.some((p) => p.kind === "junk"));
  // A fork into the mouth is a bonus, not a chew.
  state.projectiles = [];
  advance(state, Math.max(state.tick, state.creature.chewUntil) + 1);
  const c = state.creature;
  const score = state.score;
  const chewUntil = c.chewUntil;
  makeFood(state, "metal", c.x - c.rx * 0.5, c.y, 2, 0, { kind: "junk", assisted: true });
  const before = state.nextEventId;
  stepArcade(state);
  assert.equal(state.utensils, 1);
  // The fork's bonus, plus the passive pay if this tick is a pay tick.
  const passive = state.tick % 10 === 0 && state.hunger > TUNING.payFloor ? state.score - score - TUNING.utensilScore : 0;
  assert.ok(passive >= 0 && passive < 20);
  assert.equal(state.score - score - passive, TUNING.utensilScore);
  assert.ok(newEvents(state, before).some((e) => e.type === "utensil" && e.name === "caught"));
  assert.equal(state.creature.chewUntil, chewUntil, "a fork does not start a chew");
  // A fork onto the launcher jams it.
  state.projectiles = [];
  makeFood(state, "metal", ARENA.launcher.x, ARENA.launcher.y - 80, 0, 6, { kind: "junk", assisted: true });
  const jamSeen = state.nextEventId;
  for (let i = 0; i < 30 && state.projectiles.length; i += 1) stepArcade(state);
  const jam = newEvents(state, jamSeen).find((e) => e.type === "jam" && e.name === "utensil");
  assert.ok(jam, "a jam event from the utensil");
  assert.equal(jam.value, TUNING.utensilJams);
  assert.ok(state.reloadUntil > state.tick);
  assert.equal(launchFood(state, "metal", ARENA.defaultAngle, ARENA.defaultPower), false);
});

test("BALLOON: it lifts and bobs, and the belly becomes a trampoline toward the mouth", () => {
  const state = fresh(4);
  mutate(state, "balloon", 1);
  advance(state, state.tick + 120);
  assert.ok(state.creature.lift > 0, "it floats");
  const bobs = new Set();
  for (let i = 0; i < 60; i += 1) { stepArcade(state); bobs.add(state.creature.bob); }
  assert.ok(bobs.size > 10, "and bobs");
  // A snack dropped onto the belly, below the chin.
  state.projectiles = [];
  const c = state.creature;
  const seen = state.nextEventId;
  const food = makeFood(state, "pepper", c.bx - c.brx * 0.5, c.by - c.bry * 0.6, 0, 5);
  stepArcade(state);
  for (let i = 0; i < 40 && food.bank === 0 && state.projectiles.includes(food); i += 1) stepArcade(state);
  assert.equal(food.bank, 1, "the belly is a bank");
  assert.equal(food.lastBank, "belly");
  assert.ok(food.vy < 0, "it goes up");
  assert.ok(food.vx > 0, "and toward the mouth");
  const bounce = newEvents(state, seen).find((e) => e.type === "bounce" && e.name === "belly");
  assert.ok(bounce);
  assert.equal(bounce.label, "OFF THE BELLY");
});

test("without a balloon the belly still bounces instead of blocking, but it is not a bank", () => {
  const state = fresh(4);
  advance(state, Math.max(state.tick, state.creature.chewUntil) + 1);
  const c = state.creature;
  const food = makeFood(state, "pepper", c.bx - c.brx * 0.5, c.by - c.bry * 0.6, 0, 5);
  const combo = (state.combo = 2);
  const rage = state.rage;
  for (let i = 0; i < 40 && food.lastSurface !== "belly"; i += 1) stepArcade(state);
  assert.equal(food.lastSurface, "belly");
  assert.ok(food.vy < 5, "it rebounds");
  assert.equal(food.bank, 0);
  assert.ok(state.projectiles.includes(food), "and keeps flying");
  assert.equal(state.combo, combo, "a bump off the belly is not a failure");
  assert.ok(state.rage <= rage);
});

test("PEPPER: fire breath is telegraphed, cooks a snack for double, and a cooked miss lights the bench", () => {
  const state = fresh(6);
  mutate(state, "pepper", 1);
  const seen = state.nextEventId;
  advance(state, state.flameAt + 1);
  assert.ok(state.flame, "a flame is scheduled");
  const tell = newEvents(state, seen).find((e) => e.type === "flame" && e.name === "tell");
  assert.ok(tell);
  assert.equal(tell.value, TUNING.flameTell);
  assert.equal(state.threat?.kind, "flame");
  assert.equal(flameCone(state)?.telling, true);
  advance(state, state.flame.tellUntil);
  const breath = state.events.find((e) => e.type === "flame" && e.name === "breath");
  assert.ok(breath, "then it breathes");
  const cone = flameCone(state);
  assert.ok(cone && !cone.telling);
  assert.equal(cone.length, state.flame.length);
  // A snack in the cone is cooked.
  state.projectiles = [];
  const food = makeFood(state, "balloon", cone.x + Math.cos(cone.angle) * 60, cone.y + Math.sin(cone.angle) * 60, 0, 0);
  const before = state.nextEventId;
  stepArcade(state);
  assert.equal(food.cooked, true);
  assert.equal(state.cooked, 1);
  assert.ok(newEvents(state, before).some((e) => e.type === "cooked"));
  // A cooked snack landing on the bench starts a fire; shots through it are cooked for free and irritation rises.
  state.projectiles = [];
  advance(state, state.flame ? state.flame.until : state.tick);
  makeFood(state, "balloon", 400, ARENA.floor - 40, 0, 4, { cooked: true });
  const fireSeen = state.nextEventId;
  for (let i = 0; i < 20 && state.tick >= state.benchFireUntil; i += 1) stepArcade(state);
  const fire = newEvents(state, fireSeen).find((e) => e.type === "fire" && e.name === "start");
  assert.ok(fire, "the bench is on fire");
  assert.equal(state.benchFireUntil, fire.tick + TUNING.benchFireTicks);
  state.projectiles = [];
  while (!canLaunch(state)) stepArcade(state);
  const rage = state.rage;
  assert.ok(launchFood(state, "metal", ARENA.defaultAngle, ARENA.defaultPower));
  assert.equal(state.projectiles[state.projectiles.length - 1].cooked, true, "launched through fire");
  advance(state, state.tick + 60);
  assert.ok(state.rage > rage, "the fire irritates it");
  advance(state, state.benchFireUntil);
  assert.ok(state.events.some((e) => e.type === "fire" && e.name === "out"));
});

test("a launcher inside the flame cone is singed; a shut hatch blocks it", () => {
  const state = fresh(6);
  const aim = (s) => {
    const c = s.creature;
    const ox = c.x - c.rx * 0.6;
    return { angle: Math.atan2(ARENA.launcher.y - c.y, ARENA.launcher.x - ox), length: Math.hypot(ARENA.launcher.x - ox, ARENA.launcher.y - c.y) + 50 };
  };
  const cone = aim(state);
  state.flame = { tellUntil: state.tick + 1, until: state.tick + 1 + TUNING.flameTicks, angle: cone.angle, length: cone.length };
  const seen = state.nextEventId;
  stepArcade(state);
  const singe = newEvents(state, seen).find((e) => e.type === "jam" && e.name === "singe");
  assert.ok(singe, "singed");
  assert.equal(singe.value, TUNING.singeJams);
  assert.ok(state.reloadUntil >= state.tick + TUNING.singeJams - 1);

  const shielded = fresh(6);
  const cone2 = aim(shielded);
  assert.ok(slamHatch(shielded));
  shielded.flame = { tellUntil: shielded.tick + 1, until: shielded.tick + 1 + TUNING.flameTicks, angle: cone2.angle, length: cone2.length };
  const seen2 = shielded.nextEventId;
  const reload = shielded.reloadUntil;
  stepArcade(shielded);
  assert.ok(newEvents(shielded, seen2).some((e) => e.type === "block"));
  assert.equal(shielded.reloadUntil, reload, "no jam behind the hatch");
  assert.equal(shielded.hatchSaves, 1);
});

test("mutation levels land at rising serving thresholds", () => {
  const [first, second, third] = TUNING.levelServings;
  assert.ok(first < second && second < third, "rising");
  assert.ok(second - first <= third - second, "and the steps do not shrink");
  assert.equal(levelFor(0), 0);
  assert.equal(levelFor(first - 1), 0);
  assert.equal(levelFor(first), 1);
  assert.equal(levelFor(second - 1), 1);
  assert.equal(levelFor(second), 2);
  assert.equal(levelFor(third), 3);
  assert.equal(levelFor(third * 3), TUNING.maxLevel);
  assert.equal(servingsForLevel(1), first);
  assert.equal(servingsForLevel(TUNING.maxLevel), third);
  assert.equal(servingsForLevel(0), 0);
  const state = fresh(8);
  state.servings.metal = first - 2;
  assert.ok(feedOnce(state, "metal"));
  assert.equal(state.mutations.metal, 0, "one short of the threshold is not a level");
  const seen = state.nextEventId;
  assert.ok(feedOnce(state, "metal"));
  assert.equal(state.mutations.metal, 1);
  assert.ok(newEvents(state, seen).some((e) => e.type === "mutation" && e.value === 1));
});

test("mutation levels are permanent, stack across ingredients, and cap at three", () => {
  const state = fresh(8);
  mutate(state, "metal", 1);
  mutate(state, "balloon", 1);
  assert.deepEqual(state.mutations, { metal: 1, balloon: 1, pepper: 0 });
  assert.equal(state.mutationEvents, 2);
  state.servings.pepper = servingsForLevel(TUNING.maxLevel) * 2 - 1;
  assert.ok(feedOnce(state, "pepper"));
  assert.equal(state.mutations.pepper, TUNING.maxLevel);
  advance(state, state.tick + 600);
  assert.deepEqual(state.mutations, { metal: 1, balloon: 1, pepper: TUNING.maxLevel }, "nothing wears off");
});

test("INHERITED: the trait it came in with is a level-1 mutation from tick 0 that fed it nothing", () => {
  for (const trait of FOODS) {
    const state = createArcade(21, trait);
    assert.equal(state.inherited, trait);
    assert.equal(state.mutations[trait], 1, `${trait}: level 1 from tick 0`);
    assert.deepEqual(state.servings, { metal: 0, balloon: 0, pepper: 0 }, `${trait}: it fed nothing`);
    assert.equal(state.mutationEvents, 0, `${trait}: no mutation event`);
    assert.equal(state.events.some((e) => e.type === "mutation"), false);
    for (const other of FOODS) if (other !== trait) assert.equal(state.mutations[other], 0);
    // The level never goes away and the next one lands at the normal threshold.
    const [first, second] = TUNING.levelServings;
    state.crateAt = Number.MAX_SAFE_INTEGER;
    state.servings[trait] = first;
    assert.ok(feedOnce(state, trait));
    assert.equal(state.mutations[trait], 1, `${trait}: the first threshold changes nothing`);
    state.servings[trait] = second - 1;
    const seen = state.nextEventId;
    assert.ok(feedOnce(state, trait));
    assert.equal(state.mutations[trait], 2, `${trait}: level 2 at the normal threshold`);
    assert.ok(newEvents(state, seen).some((e) => e.type === "mutation" && e.value === 2));
    assert.equal(state.mutationEvents, 1);
  }
  // The first storm and the first flame are scheduled as on a real level-up.
  assert.equal(createArcade(21, "metal").junkAt, TUNING.utensilFirst);
  assert.equal(createArcade(21, "pepper").flameAt, TUNING.flameFirst);
  assert.equal(createArcade(21, "balloon").junkAt, TUNING.utensilEvery, "balloon leaves the storms alone");
  assert.equal(createArcade(21).inherited, null);
  assert.throws(() => createArcade(21, "clock"), /Unknown inherited trait/);
});

test("INHERITED: a replay with the trait reproduces the shift, and without it is the plain creature", () => {
  const seed = 2026;
  const commands = [];
  const state = createArcade(seed, "balloon");
  for (let i = 0; i < 24 && state.phase === "playing"; i += 1) {
    while (!canLaunch(state) && state.phase === "playing") stepArcade(state);
    if (state.phase !== "playing") break;
    const angle = ARENA.defaultAngle + (i % 5) - 2;
    const power = ARENA.minPower + (i % 7);
    if (launchFood(state, state.wanted, angle, power)) commands.push({ tick: state.tick, kind: "launch", ingredient: state.wanted, angle, power });
    advance(state, state.tick + 40);
  }
  advance(state, state.tick + 120);
  const endTick = state.tick;
  const replayed = replayArcade(seed, commands, endTick, "balloon");
  assert.deepEqual(replayed, state, "bit-for-bit with the trait");
  const plain = replayArcade(seed, commands, endTick);
  assert.equal(plain.inherited, null);
  assert.equal(plain.mutations.balloon, 0);
  assert.notDeepEqual(plain.creature, state.creature, "without the trait it is a different creature");
  assert.deepEqual(replayArcade(seed, [], 0), createArcade(seed), "no trait is exactly the old creature");
});

test("every serving grows it, growth moves and widens the mouth, and a grow event marks each step", () => {
  const state = fresh(9);
  const { y, ry, size } = state.creature;
  let grows = 0;
  let feeds = 0;
  // Stage 3 pacing: the first BIGGER. step is no longer inside the first
  // handful of servings, but it must arrive well inside a shift.
  while (grows === 0 && feeds < 80) {
    const before = state.nextEventId;
    assert.ok(feedOnce(state));
    feeds += 1;
    grows += newEvents(state, before).filter((e) => e.type === "grow").length;
  }
  assert.ok(state.creature.size > size);
  assert.equal(state.size, state.creature.size);
  assert.ok(state.creature.ry > ry, "a bigger mouth");
  assert.ok(state.creature.y < y, "sitting higher");
  assert.ok(grows >= 1, "at least one BIGGER. card");
  assert.ok(feeds > 6, `the first step took ${feeds} servings; it should not be spent in the first six`);
  // The chest rises with it, so the mouth's bottom lip stays clear of the belly's top at the mouth's x.
  const c = state.creature;
  assert.ok(c.by - c.bry < c.y, "belly top is behind the face, never in front of it");
});

test("appetite: the belly drains faster with time and with size, and stuffing a full creature raises it", () => {
  const state = fresh(1);
  const early = drainPerTick(state);
  advance(state, state.tick + 3600);
  assert.ok(drainPerTick(state) > early, "later is hungrier");
  const small = createArcade(1);
  const big = createArcade(1);
  small.tick = big.tick = 3000;
  big.creature.size = 2;
  assert.ok(drainPerTick(big) > drainPerTick(small), "bigger is hungrier");
  const lean = fresh(2);
  lean.hunger = 50;
  const a0 = lean.appetite;
  assert.ok(feedOnce(lean));
  const leanGain = lean.appetite - a0;
  const stuffed = fresh(2);
  stuffed.hunger = 99;
  const b0 = stuffed.appetite;
  assert.ok(feedOnce(stuffed));
  const stuffedGain = stuffed.appetite - b0;
  assert.ok(stuffedGain > leanGain * 3, `gorging costs more appetite (${stuffedGain} vs ${leanGain})`);
});

test("a craving arrives with a clock; serving it pays, calms and pauses growth; ignoring it is a tantrum", () => {
  const state = createArcade(11);
  advance(state, 200);
  assert.ok(state.craving, "a craving by the first few seconds");
  assert.ok(state.events.some((e) => e.type === "craving" && e.name === "start"));
  assert.equal(state.wanted, state.craving.ingredient);
  const wanted = state.craving.ingredient;
  const size = state.creature.size;
  const rage = (state.rage = 20);
  assert.ok(feedOnce(state, wanted));
  assert.equal(state.cravingsMet, 1);
  assert.equal(state.craving, null);
  assert.ok(state.growthPausedUntil > state.tick);
  assert.ok(state.rage < rage - TUNING.feedRage, "a craving calms more than a plain serving");
  const paused = state.creature.size;
  assert.ok(paused > size, "the serving that met the craving still grew it");
  // While paused, a serving does not grow it.
  assert.ok(feedOnce(state, FOODS.find((f) => f !== wanted)));
  if (state.tick < state.growthPausedUntil) assert.equal(state.creature.size, paused);

  const sulk = createArcade(11);
  advance(sulk, 200);
  const ends = sulk.craving.endsAt;
  const hunger = (sulk.hunger = 60);
  advance(sulk, ends + 1);
  assert.equal(sulk.cravingsMissed, 1);
  assert.ok(sulk.events.some((e) => e.type === "tantrum"));
  assert.ok(sulk.events.some((e) => e.type === "jam" && e.name === "tantrum"));
  assert.ok(sulk.rage >= TUNING.tantrumRage - 1);
  assert.ok(sulk.hunger < hunger - TUNING.tantrumHunger + 1, "a tantrum burns what it ate");
});

test("while it craves, the craved coin curves in and any other coin fills and calms it less: NOT THAT", () => {
  const craving = fresh(11);
  assert.ok(craving.craving, "a craving by now");
  const wanted = craving.craving.ingredient;
  const other = FOODS.find((f) => f !== wanted && f !== "metal") ?? FOODS.find((f) => f !== wanted);
  // The same state with no craving up, and none coming.
  const calm = fresh(11);
  calm.craving = null; calm.cravingNextAt = 1e9;

  // The pull: the craved coin, at rest beside the mouth, starts toward it; with no craving it only falls.
  const m = craving.creature.mouth;
  const pulled = makeFood(craving, wanted, m.midX - 200, m.midY, 0, 0);
  const loose = makeFood(calm, wanted, m.midX - 200, m.midY, 0, 0);
  stepArcade(craving); stepArcade(calm);
  assert.ok(pulled.vx > loose.vx, "the craved coin curves toward the mouth");
  assert.equal(pulled.assisted, true);
  assert.equal(loose.assisted, false);
  // Any other coin flies as it always does.
  const plain = makeFood(craving, other, m.midX - 200, m.midY, 0, 0);
  stepArcade(craving);
  assert.equal(plain.vx, 0);
  assert.equal(plain.assisted, false);

  // The grudging serving: the same shot of another coin, with and without the craving up.
  const a = fresh(11); const b = fresh(11);
  b.craving = null; b.cravingNextAt = 1e9;
  for (const s of [a, b]) { s.hunger = 50; s.rage = 20; }
  const from = a.nextEventId;
  assert.ok(feedOnce(a, other)); assert.ok(feedOnce(b, other));
  assert.equal(a.tick, b.tick, "the same flight");
  assert.ok(a.craving, "still waiting for the coin it wanted");
  const feed = newEvents(a, from).find((e) => e.type === "feed");
  assert.equal(feed.name, "snub");
  assert.ok(feed.label.startsWith("NOT THAT"));
  assert.ok(a.hunger < b.hunger - 1, "the wrong coin barely fills it");
  assert.ok(a.rage > b.rage, "and calms it less");
  assert.equal(a.cravingsMet, 0);
});

/** Steps to `tick` with the belly held up, so a test can reach the later PRESS E signs alive. */
function advanceFed(state, tick, hunger = 80) {
  while (state.tick < tick && state.phase === "playing") { state.hunger = hunger; stepArcade(state); }
}

test("PRESS E works while the sign is up, once per sign, and tops a hungry belly up to the cap", () => {
  const state = createArcade(5);
  advanceFed(state, PRESS_E_FIRST - 1);
  assert.equal(pressE(state), false, "no sign yet: nothing happens");
  advanceFed(state, PRESS_E_FIRST + 10);
  state.hunger = 30;
  const from = state.nextEventId;
  assert.equal(pressE(state), true);
  assert.equal(state.hunger, TUNING.pressECap);
  const hit = state.events.filter((e) => e.id >= from).find((e) => e.type === "presse");
  assert.equal(hit.name, "refill");
  assert.equal(hit.value, TUNING.pressECap - 30);
  assert.equal(pressE(state), false, "one hit per sign");
  advanceFed(state, PRESS_E_FIRST + PRESS_E_FLIGHT + PRESS_E_OPEN);
  assert.equal(pressE(state), false, "the sign has gone");

  // The next sign: a nearly full belly is topped up to the cap and no further.
  advanceFed(state, PRESS_E_FIRST + PRESS_E_EVERY + 5);
  state.hunger = TUNING.pressECap - 5;
  assert.equal(pressE(state), true);
  assert.equal(state.hunger, TUNING.pressECap);
  // And the one after: a full belly gets nothing, and the sign is spent anyway.
  advanceFed(state, PRESS_E_FIRST + 2 * PRESS_E_EVERY + 5);
  state.hunger = TUNING.pressECap + 10;
  assert.equal(pressE(state), true);
  assert.equal(state.hunger, TUNING.pressECap + 10);
  assert.equal(pressE(state), false);
  assert.equal(state.pressEHits, 3);
});

test("a PRESS E hit is a trace command: it replays, encodes, and is refused with no sign up", () => {
  // A shift that waits for the first sign with a hungry creature, presses E, then keeps going.
  const live = createArcade(9);
  const commands = [];
  advance(live, PRESS_E_FIRST + 20);
  const before = live.hunger;
  assert.ok(before < TUNING.pressECap, "hungry by the first sign");
  assert.ok(pressE(live));
  commands.push({ tick: live.tick, kind: "e" });
  advance(live, PRESS_E_FIRST + 200);
  const replayed = replayArcade(9, commands, live.tick);
  assert.equal(replayed.hunger, live.hunger);
  assert.equal(replayed.pressEHits, 1);
  assert.equal(replayed.phase, live.phase);
  // Without the hit, the belly is lower: the command is what changed it.
  const without = replayArcade(9, [], live.tick);
  assert.ok(without.phase !== "playing" || without.hunger < replayed.hunger);

  // The canonical bytes carry it as kind 2, and decode back to the same command.
  const bytes = encodeTrace(commands, live.tick);
  assert.equal(bytes[7 + 4], 2);
  assert.deepEqual(decodeTrace(bytes), { commands, endTick: live.tick });
  validateTrace([{ tick: 5, kind: "launch", ingredient: "metal", angle: -30, power: 12 }, { tick: 9, kind: "e" }], 20);
  assert.throws(() => validateTrace([{ tick: 5, kind: "E" }], 20));

  // Replayed outside a sign, or twice on one sign, the trace is refused.
  assert.throws(() => replayArcade(9, [{ tick: 10, kind: "e" }], 100), /Rejected/);
  assert.throws(() => replayArcade(9, [...commands, { tick: commands[0].tick + 1, kind: "e" }], live.tick), /Rejected/);
});

test("beats: a lunge nobody stops eats the vent, which then swings under the ceiling as a bank", () => {
  const state = createArcade(13);
  assert.equal(getHazard(state.vent, state.tick), null);
  let guard = 0;
  while (!state.vent && state.phase === "playing" && guard++ < 20000) stepArcade(state);
  assert.ok(state.vent, "the vent gets bitten off eventually");
  const hazard = getHazard(state.vent, state.tick + 200);
  assert.ok(hazard && !hazard.warning);
  assert.ok(hazard.y + hazard.height < 200, "it hangs high, above the direct line to the mouth");
});

test("the hatch still works for compatibility: it locks the launcher and stops a lunge", () => {
  const state = fresh(13);
  assert.ok(slamHatch(state));
  assert.equal(launchFood(state, "metal", ARENA.defaultAngle, ARENA.defaultPower), false);
  assert.equal(slamHatch(state), false, "not twice in a row");
  advance(state, state.hatchClosedUntil);
  assert.ok(canLaunch(state));
  const lunge = fresh(13);
  lunge.threat = { kind: "lunge", tick: lunge.tick + 20, x: 0, y: 0 };
  const saves = lunge.hatchSaves;
  assert.ok(slamHatch(lunge));
  assert.equal(lunge.threat, null);
  assert.equal(lunge.hatchSaves, saves + 1);
});

test("a shift that is never fed ends on an empty belly, in finite time, and the ending escalates with size", () => {
  const state = createArcade(1);
  advance(state, ARENA.maxTicks);
  assert.equal(state.phase, "lost");
  assert.equal(state.failureReason, "empty-belly");
  assert.ok(state.tick < 3600, "well inside a minute");
  assert.ok(state.events.some((e) => e.type === "end"));
  assert.equal(endingFor(1), 0);
  assert.equal(endingFor(TUNING.sizeMax), 3);
  assert.ok(endingFor(1.6) >= 1);
  const wrecked = fresh(2);
  wrecked.rage = 100 - TUNING.missRage + 2;
  while (!canLaunch(wrecked)) stepArcade(wrecked);
  assert.ok(launchFood(wrecked, "metal", ARENA.maxAngle, ARENA.minPower));
  advance(wrecked, wrecked.tick + 300);
  assert.equal(wrecked.failureReason, "kitchen-destroyed");
});

test("terminal states are immutable", () => {
  const state = createArcade(1);
  advance(state, ARENA.maxTicks);
  const frozen = structuredClone(state);
  stepArcade(state);
  assert.equal(launchFood(state, "metal", ARENA.defaultAngle, ARENA.defaultPower), false);
  assert.equal(slamHatch(state), false);
  assert.deepEqual(state, frozen);
});

test("the probe agrees with the rules it predicts, and the preview does not touch the state", () => {
  const state = fresh(7);
  const shot = landingShot(state, "balloon");
  assert.ok(shot);
  const frozen = structuredClone(state);
  const preview = previewFlight(state, "balloon", shot.angle, shot.power, 200);
  assert.deepEqual(state, frozen, "previewFlight mutated the state");
  assert.ok(preview.settled && preview.arrival);
  assert.equal(preview.ticks, shot.ticks);
  const feeds = state.totalFeeds;
  assert.ok(launchFood(state, "balloon", shot.angle, shot.power));
  advance(state, state.tick + shot.ticks - 1);
  assert.equal(state.totalFeeds, feeds, "not yet");
  stepArcade(state);
  assert.equal(state.totalFeeds, feeds + 1, "lands exactly when the probe said");
});

test("two seeds are two different creatures: hunger and bob differ", () => {
  const a = createArcade(1);
  const b = createArcade(2);
  a.tick = b.tick = 3000;
  assert.notEqual(drainPerTick(a), drainPerTick(b));
  a.tick = b.tick = 0;
  a.mutations.balloon = b.mutations.balloon = 1;
  advance(a, 50);
  advance(b, 50);
  assert.notEqual(a.creature.bob, b.creature.bob);
});

test("food capacity, cooldown, event history, launch angles and flight time are bounded", () => {
  const state = fresh(1);
  for (let i = 0; i < ARENA.maxProjectiles; i += 1) makeFood(state, "metal", 100 + i, 100, 0, 0);
  assert.equal(launchFood(state, "metal", ARENA.defaultAngle, ARENA.defaultPower), false, "six in flight is the cap");
  // Cutlery does not count against the player's six.
  state.projectiles.pop();
  makeFood(state, "metal", 100, 100, 0, 0, { kind: "junk" });
  assert.ok(launchFood(state, "metal", ARENA.defaultAngle, ARENA.defaultPower));
  assert.equal(launchFood(state, "metal", ARENA.defaultAngle, ARENA.defaultPower), false, "cooldown");
  assert.equal(state.projectiles[state.projectiles.length - 1].vx > 0, true);
  // Angles and power are clamped on the way in.
  state.projectiles = [];
  advance(state, state.tick + ARENA.cooldownTicks);
  assert.ok(launchFood(state, "metal", -400, 99));
  const last = state.projectiles[state.projectiles.length - 1];
  assert.ok(Math.abs(Math.hypot(last.vx, last.vy) - launchSpeed("metal", ARENA.maxPower)) < 0.01, "clamped to full charge");
  assert.throws(() => launchFood(state, "soup", -40, 13));
  // Nothing stays in the air forever, however it rebounds, and the event log is bounded.
  const chaos = fresh(3);
  for (let t = 0; t < 2400; t += 1) {
    if (t % 40 === 0) makeFood(chaos, FOODS[t % 3], 300 + (t % 7) * 60, 100 + (t % 5) * 40, (t % 9) - 4, (t % 4) - 2);
    stepArcade(chaos);
    for (const p of chaos.projectiles) assert.ok(p.age <= 300, "no snack older than LIFE_TICKS");
    assert.ok(chaos.events.length <= 48);
  }
});

test("a real trace replays bit-for-bit, including the creature, the kitchen and the score", () => {
  const seed = 21;
  const live = createArcade(seed);
  const commands = [];
  let hatched = false;
  while (live.phase === "playing" && live.tick < 2400) {
    if (canLaunch(live) && live.tick % 2 === 0) {
      const ingredient = FOODS[live.shots % 3];
      const shot = live.shots % 4 === 3
        ? { angle: ARENA.maxAngle, power: ARENA.minPower }
        : landingShot(live, ingredient) ?? { angle: ARENA.defaultAngle, power: ARENA.defaultPower };
      if (launchFood(live, ingredient, shot.angle, shot.power)) {
        commands.push({ tick: live.tick, kind: "launch", ingredient, angle: shot.angle, power: shot.power });
      }
    } else if (!hatched && live.tick === 1500 && slamHatch(live)) {
      hatched = true;
      commands.push({ tick: live.tick, kind: "hatch" });
    }
    stepArcade(live);
  }
  assert.ok(live.totalFeeds >= 3, "the scripted player landed something");
  assert.ok(commands.length > 10);
  const replayed = replayArcade(seed, commands, live.tick);
  assert.deepEqual(replayed, live);
  assert.deepEqual(replayArcade(seed, commands, live.tick), replayed, "deterministic twice over");
});

test("replay validates the entire trace and rejects impossible or malformed commands", () => {
  const ok = [{ tick: 300, kind: "launch", ingredient: "metal", angle: ARENA.defaultAngle, power: ARENA.defaultPower }];
  assert.ok(replayArcade(1, ok, 400));
  assert.throws(() => replayArcade(1, [{ ...ok[0], angle: ARENA.minAngle - 1 }], 400), /Invalid/);
  assert.throws(() => replayArcade(1, [{ ...ok[0], power: ARENA.maxPower + 1 }], 400), /Invalid/);
  assert.throws(() => replayArcade(1, [{ ...ok[0], angle: -40.5 }], 400), /Invalid/);
  assert.throws(() => replayArcade(1, [{ ...ok[0], ingredient: "soup" }], 400), /Invalid/);
  assert.throws(() => replayArcade(1, [{ tick: 300, kind: "dance" }], 400), /Invalid/);
  assert.throws(() => replayArcade(1, [ok[0], { ...ok[0], tick: 300 }], 400), /Invalid/);
  assert.throws(() => replayArcade(1, [ok[0], { ...ok[0], tick: 310 }], 400), /Rejected/);
  assert.throws(() => replayArcade(1, ok, ARENA.maxTicks + 1), /Invalid/);
  assert.throws(() => replayArcade(-1, ok, 400), /Invalid/);
  assert.throws(() => replayArcade(1, [{ tick: 300, kind: "hatch" }, { tick: 310, kind: "hatch" }], 400), /Rejected/);
});
