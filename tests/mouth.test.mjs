import assert from "node:assert/strict";
import test from "node:test";
import {
  ARENA, FOODS, TUNING, copyCreature, createArcade, launchFood, mouthIsTeeth, probeFlight, stepArcade,
} from "../lib/game/arcade.ts";
import {
  apertureOf, coverage, distanceToMouth, insideMouth, lipsAt, placeAperture, swallows, takesCoin, toArena, toPainting, bodyField,
} from "../lib/game/body.ts";
import { G, GEOMETRY } from "../lib/game/face.ts";

/**
 * The mouth is the target. There is no ring: the rules swallow a coin when
 * most of it is inside the opening that is drawn, and the renderer draws the
 * rules' opening exactly. These tests hold the rules to that.
 */

const quiet = (seed = 1) => {
  const state = createArcade(seed);
  state.beatAt = state.crateAt = state.cravingNextAt = state.junkAt = state.flameAt = 1e9;
  return state;
};

function run(state, ticks, fed = 70) {
  for (let i = 0; i < ticks && state.phase === "playing"; i += 1) { state.hunger = Math.max(state.hunger, fed); stepArcade(state); }
  return state;
}

/** The face's channels by name, as the body module reads them. */
function channels(creature) {
  const out = {};
  for (const field of GEOMETRY) out[field] = creature.face.pose[G[field]];
  return out;
}

test("the opening is two lip curves: inside means between them, and the corners are points", () => {
  const state = run(quiet(), 120);
  const m = state.creature.mouth;
  assert.ok(m.rx - m.lx > 180 && m.bottom - m.top > 100, "a wide, deep opening at rest");
  const middle = lipsAt(m, m.midX);
  assert.ok(middle && middle.upper < m.midY && middle.lower > m.midY);
  assert.ok(insideMouth(m, m.midX, m.midY), "its middle is inside");
  assert.ok(!insideMouth(m, m.midX, middle.upper - 1), "just above the upper lip is not");
  assert.ok(!insideMouth(m, m.midX, middle.lower + 1), "just below the lower lip is not");
  assert.equal(lipsAt(m, m.lx - 1), null, "nothing outside the corners");
  // Near a corner the opening tapers to nothing.
  const near = lipsAt(m, m.lx + 3);
  assert.ok(near && near.lower - near.upper < 15, "a corner is thin");
});

test("a coin counts when most of it is in: deep in the middle yes, on a lip or a corner no", () => {
  const state = run(quiet(), 120);
  const m = state.creature.mouth;
  const { coin, share } = TUNING.mouthFit;
  assert.ok(swallows(m, m.midX, m.midY, coin, share), "the middle swallows");
  assert.equal(coverage(m, m.midX, m.midY, coin), 1, "and all of a coin there is inside");
  const lips = lipsAt(m, m.midX);
  assert.ok(Math.abs(coverage(m, m.midX, lips.upper, coin) - 0.5) < 0.08, "a coin centred on a lip is half in");
  // Half in is in: along a lip, a coin counts when its centre is past it.
  assert.ok(!swallows(m, m.midX, lips.upper - 3, coin, share), "its centre short of the upper lip does not count");
  assert.ok(swallows(m, m.midX, lips.upper + 3, coin, share), "its centre past it does");
  assert.ok(!swallows(m, m.midX, lips.lower + 3, coin, share), "nor short of the lower lip");
  assert.ok(swallows(m, m.midX, lips.lower - 3, coin, share), "and past it, yes");
  assert.ok(swallows(m, m.midX, lips.upper + coin * 0.6, coin, share), "a coin well past the lip does");
  // A corner: the centre can be inside while most of the coin is on the face.
  const x = m.lx + 6;
  const corner = lipsAt(m, x);
  const y = (corner.upper + corner.lower) / 2;
  assert.ok(insideMouth(m, x, y), "the centre is inside the corner");
  assert.ok(coverage(m, x, y, coin) < 0.4, "but most of the coin is on the face");
  assert.ok(!swallows(m, x, y, coin, share), "so a corner does not take a coin");
});

test("the rules' opening is the face's aperture, placed the way the creature is drawn, and survives the round trip", () => {
  const state = run(quiet(3), 200);
  const c = state.creature;
  const pose = channels(c);
  const again = toArena(placeAperture(apertureOf(pose, TUNING.mouthFit), bodyField(pose)),
    c.x, c.y, pose.bodyScaleX, pose.bodyScaleY);
  for (const key of ["lx", "ly", "rx", "ry", "cx", "cu", "cd"]) assert.ok(Math.abs(again[key] - c.mouth[key]) < 1e-3, key);
  // The renderer carries the rules' opening back into the creature's own
  // coordinates to draw it; that must be an exact inverse.
  const painted = toPainting(c.mouth, c.x, c.y, pose.bodyScaleX, pose.bodyScaleY);
  const back = toArena(painted, c.x, c.y, pose.bodyScaleX, pose.bodyScaleY);
  for (const key of ["lx", "ly", "rx", "ry", "cx", "cu", "cd"]) assert.ok(Math.abs(back[key] - c.mouth[key]) < 1e-3, key);
});

test("every catch is a coin that was mostly in, and no coin that was mostly in an open mouth flies on", () => {
  let catches = 0;
  for (const seed of [1, 2, 3]) {
    const state = quiet(seed);
    run(state, 60);
    for (let shot = 0; shot < 60 && state.phase === "playing"; shot += 1) {
      const food = FOODS[shot % 3];
      // Every other shot aimed (the probe's first catch), the rest sprayed.
      let angle = ARENA.minAngle + ((shot * 7) % (ARENA.maxAngle - ARENA.minAngle));
      let power = ARENA.minPower + (shot % 8);
      if (shot % 2 === 0) {
        for (let a = ARENA.minAngle; a <= ARENA.maxAngle; a += 1) {
          if (probeFlight(state, food, a, ARENA.maxPower - (shot % 4), 160).fed) { angle = a + (shot % 3) - 1; power = ARENA.maxPower - (shot % 4); break; }
        }
      }
      launchFood(state, food, angle, power);
      for (let i = 0; i < 40 && state.phase === "playing"; i += 1) {
        state.hunger = Math.max(state.hunger, 70);
        stepArcade(state);
        const c = state.creature;
        const chewing = c.untilOpen > 0;
        for (const e of state.events) {
          if (e.tick !== state.tick || e.type !== "feed" || e.label.startsWith("CRATE")) continue;
          catches += 1;
          assert.ok(swallows(c.mouth, e.x, e.y, TUNING.mouthFit.coin, TUNING.mouthFit.share),
            `a catch at (${e.x}, ${e.y}) was not mostly inside the opening`);
        }
        if (chewing) continue;
        for (const p of state.projectiles) {
          if (p.kind !== "food" || p.spent) continue;
          assert.ok(!swallows(c.mouth, p.x, p.y, TUNING.mouthFit.coin, TUNING.mouthFit.share),
            `a coin at (${p.x}, ${p.y}) was mostly inside an open mouth and kept flying`);
        }
      }
    }
  }
  assert.ok(catches >= 30, `enough catches to mean something (${catches})`);
});

test("a prediction steps the same face as the shift: alone in the air, it lands exactly where the probe says", () => {
  const state = run(quiet(5), 240);
  let compared = 0;
  for (const food of FOODS) {
    for (let angle = ARENA.minAngle; angle <= ARENA.maxAngle; angle += 3) {
      for (const power of [ARENA.minPower, 12, ARENA.maxPower]) {
        const predicted = probeFlight(state, food, angle, power, 200);
        const live = structuredClone(state);
        launchFood(live, food, angle, power);
        let fedAt = -1;
        for (let i = 1; i <= 200 && live.phase === "playing"; i += 1) {
          stepArcade(live);
          if (live.events.some((e) => e.tick === live.tick && e.type === "feed")) { fedAt = i; break; }
          if (!live.projectiles.length) break;
        }
        assert.equal(fedAt > 0, predicted.fed, `${food} ${angle}° ${power}: probe and shift disagree`);
        if (predicted.fed) assert.equal(fedAt, predicted.ticks, `${food} ${angle}° ${power}: caught on a different tick`);
        compared += 1;
      }
    }
  }
  assert.ok(compared > 100);
});

test("a prediction follows the belly as it empties and the flinch at a bounce off it", () => {
  // A balloon belly bounces coins into the mouth, and the face flinches at
  // each bounce; a creature on the edge of hungry changes its face as the
  // belly drains in flight. The probe must see both coming.
  const state = run(quiet(11), 240);
  state.mutations = { metal: 0, balloon: 1, pepper: 0 };
  run(state, 60);
  let compared = 0; let bounced = 0;
  for (const hunger of [70, 41]) {
    state.hunger = hunger;
    for (const food of FOODS) {
      for (let angle = ARENA.minAngle; angle <= ARENA.maxAngle; angle += 4) {
        for (const power of [ARENA.minPower, 12, ARENA.maxPower]) {
          const predicted = probeFlight(state, food, angle, power, 200);
          const live = structuredClone(state);
          launchFood(live, food, angle, power);
          let fedAt = -1; let belly = false;
          for (let i = 1; i <= 200 && live.phase === "playing"; i += 1) {
            stepArcade(live);
            if (live.events.some((e) => e.tick === live.tick && e.type === "bounce" && e.name === "belly")) belly = true;
            if (live.events.some((e) => e.tick === live.tick && e.type === "feed")) { fedAt = i; break; }
            if (!live.projectiles.length) break;
          }
          assert.equal(fedAt > 0, predicted.fed, `${food} ${angle}° ${power} at ${hunger}: probe and shift disagree`);
          if (predicted.fed) assert.equal(fedAt, predicted.ticks, `${food} ${angle}° ${power} at ${hunger}: caught on a different tick`);
          compared += 1; if (belly) bounced += 1;
        }
      }
    }
  }
  assert.ok(compared > 200 && bounced > 10, `enough shots off the belly to mean something (${bounced} of ${compared})`);
});

test("a coin coming away from the opening without going in is knocked off the lip, once", () => {
  const { coin, share, lipOut, lipKick } = TUNING.mouthFit;
  let checked = 0;
  for (const seed of [12, 13]) {
    const state = run(quiet(seed), 200);
    for (const food of FOODS) {
      for (let angle = ARENA.minAngle; angle <= ARENA.maxAngle && checked < 12; angle += 1) {
        for (const power of [10, 13, ARENA.maxPower]) {
          const live = structuredClone(state);
          if (!launchFood(live, food, angle, power)) continue;
          const id = live.projectiles[live.projectiles.length - 1].id;
          let peak = 0; let lips = 0; let fed = false; let since = -1;
          for (let i = 0; i < 160 && live.phase === "playing"; i += 1) {
            live.hunger = 70;
            const before = live.projectiles.find((p) => p.id === id);
            const was = before ? before.cover ?? 0 : 0;
            stepArcade(live);
            const p = live.projectiles.find((q) => q.id === id);
            const events = live.events.filter((e) => e.tick === live.tick);
            if (events.some((e) => e.type === "feed")) { fed = true; break; }
            if (!p) break;
            const now = coverage(live.creature.mouth, p.x, p.y, coin);
            if (events.some((e) => e.type === "lip")) {
              lips += 1; since = 0;
              assert.ok(was >= lipOut && was < share, `knocked off at ${was} of it in`);
              assert.ok(Math.hypot(p.vx, p.vy) >= lipKick - 1e-6, "with at least the kick");
            } else if (since >= 0) {
              since += 1;
              // Off the lip for good within a few ticks, not riding it.
              if (since === 6) assert.ok(now < 0.1, `${food} ${angle}° ${power}: still ${now.toFixed(2)} over the opening six ticks after the lip-out`);
            }
            peak = Math.max(peak, now);
          }
          if (!fed && peak >= lipOut) { assert.equal(lips, 1, `${food} ${angle}° ${power}: one lip-out (${lips})`); checked += 1; }
          if (fed) assert.equal(lips, 0, "a coin that went in was never knocked off a lip on the way");
        }
      }
    }
  }
  assert.ok(checked >= 6, `enough near misses to mean something (${checked})`);
});

test("a prediction never touches the live face", () => {
  const state = run(quiet(6), 200);
  const before = copyCreature(state.creature);
  for (let angle = -60; angle <= -20; angle += 5) probeFlight(state, "balloon", angle, 12, 200);
  assert.deepEqual(state.creature.face, before.face);
  assert.deepEqual(state.creature.mouth, before.mouth);
});

test("a chewing mouth is shut: a coin into the jaws clanks, and only the parting gap takes one as it reopens", () => {
  const state = run(quiet(7), 120);
  // Feed it by placing a coin straight into the middle of the opening.
  const m = state.creature.mouth;
  assert.ok(launchFood(state, "pepper", -30, 13));
  const coin = state.projectiles[0];
  coin.x = m.midX; coin.y = m.midY; coin.vx = 0.1; coin.vy = 0;
  stepArcade(state);
  assert.ok(state.events.some((e) => e.tick === state.tick && e.type === "feed"), "fed");
  assert.ok(state.creature.chewUntil > state.tick, "and chewing");
  run(state, 12);
  const c = state.creature;
  assert.ok(c.mouth.bottom - c.mouth.top < (c.muzzle.bottom - c.muzzle.top) * 0.5, "the jaws are shut");
  // A coin well clear of the shut lips — where the open mouth's floor was —
  // is not touching the teeth, and flies on over the face.
  state.lastLaunchTick = -1000; state.reloadUntil = 0;
  assert.ok(launchFood(state, "pepper", -30, 13));
  const low = state.projectiles[state.projectiles.length - 1];
  low.x = c.mouth.midX; low.y = c.mouth.bottom + TUNING.mouthFit.coin + 20; low.vx = 0.1; low.vy = 0;
  stepArcade(state);
  assert.ok(!state.events.some((e) => e.tick === state.tick && e.type === "clank"), "no clank off bare chin");
  state.projectiles = [];
  // A coin onto the shut lips clanks off the teeth.
  state.lastLaunchTick = -1000; state.reloadUntil = 0;
  assert.ok(launchFood(state, "pepper", -30, 13));
  const second = state.projectiles[state.projectiles.length - 1];
  second.x = state.creature.mouth.midX; second.y = state.creature.mouth.midY; second.vx = 0.1; second.vy = 0;
  stepArcade(state);
  assert.ok(state.events.some((e) => e.tick === state.tick && e.type === "clank"), "clank");

  // As the jaws part, the visible gap takes a coin.
  const reopenAt = state.creature.chewUntil - TUNING.chewReopen + 6;
  while (state.tick < reopenAt) { state.hunger = 70; stepArcade(state); }
  const gap = state.creature.mouth;
  assert.ok(state.creature.chewUntil > state.tick + 1, "still in the chew");
  state.lastLaunchTick = -1000; state.reloadUntil = 0; state.projectiles = [];
  assert.ok(launchFood(state, "pepper", -30, 13));
  const third = state.projectiles[0];
  third.x = gap.midX; third.y = gap.midY; third.vx = 0.1; third.vy = 0;
  stepArcade(state);
  const fed = state.events.some((e) => e.tick === state.tick && e.type === "feed");
  const deep = swallows(state.creature.mouth, third.x, third.y, TUNING.mouthFit.coin, TUNING.mouthFit.share);
  assert.equal(fed, deep, "the parting jaws take a coin exactly when it is mostly in the gap");
});

test("a shut mouth clanks a coin within its radius of the lips from any side, round the corners too", () => {
  const state = run(quiet(14), 120);
  const m0 = state.creature.mouth;
  assert.ok(launchFood(state, "pepper", -30, 13));
  const first = state.projectiles[0];
  first.x = m0.midX; first.y = m0.midY; first.vx = 0.1; first.vy = 0;
  stepArcade(state);
  run(state, 12);
  assert.ok(mouthIsTeeth(state.creature), "the jaws are shut");
  const { coin } = TUNING.mouthFit;
  const m = state.creature.mouth;
  assert.equal(distanceToMouth(m, m.midX, m.midY), 0, "inside is no distance");
  const at = (x, y) => {
    const live = structuredClone(state);
    live.lastLaunchTick = -1000; live.reloadUntil = 0; live.projectiles = [];
    assert.ok(launchFood(live, "pepper", -30, 13));
    const p = live.projectiles[0];
    p.x = x; p.y = y; p.vx = 0.01; p.vy = 0; p.straight = 1e9;
    stepArcade(live);
    return live.events.some((e) => e.tick === live.tick && e.type === "clank");
  };
  // Past the left corner, level with it: a radius away clanks, a radius and a bit does not.
  assert.ok(at(m.lx - coin + 2, m.ly), "just past the corner, within a radius");
  assert.ok(!at(m.lx - coin - 3, m.ly), "a little further out, clear");
  // Above the upper lip, straight up: the same.
  const lips = lipsAt(m, m.midX);
  assert.ok(at(m.midX, lips.upper - coin + 2), "within a radius over the lip");
  assert.ok(!at(m.midX, lips.upper - coin - 3), "clear above it");
});

test("parting jaws are teeth until the gap can take a coin, and an opening after: a coin flying in is swallowed, not clanked", () => {
  const state = run(quiet(9), 120);
  const m = state.creature.mouth;
  assert.ok(launchFood(state, "pepper", -30, 13));
  const coin = state.projectiles[0];
  coin.x = m.midX; coin.y = m.midY; coin.vx = 0.1; coin.vy = 0;
  stepArcade(state);
  assert.ok(state.creature.chewUntil > state.tick, "chewing");
  // Walk the chew: teeth while the gap cannot hold most of a coin, never after.
  let teeth = 0; let parting = null;
  while (state.creature.chewUntil > state.tick + 1) {
    state.hunger = 70; stepArcade(state);
    const c = state.creature;
    const takes = takesCoin(c.mouth, TUNING.mouthFit.coin, TUNING.mouthFit.share);
    assert.equal(mouthIsTeeth(c), c.untilOpen > 0 && !takes);
    if (!takes) teeth += 1;
    if (teeth > 0 && takes && parting === null) parting = structuredClone(state);
  }
  assert.ok(teeth >= 15, `the jaws are teeth for a good part of the chew (${teeth} ticks)`);
  assert.ok(parting, "and part wide enough to take a coin before the chew is over");
  // From the gap's left, level with its middle, flying in: over the corner and
  // the lips it flies on, and once it is mostly in it goes down.
  const gap = parting.creature.mouth;
  parting.lastLaunchTick = -1000; parting.reloadUntil = 0; parting.projectiles = [];
  assert.ok(launchFood(parting, "pepper", -30, 13));
  const flying = parting.projectiles[0];
  flying.x = gap.lx - TUNING.mouthFit.coin - 4; flying.y = gap.midY; flying.vx = 9; flying.vy = 0; flying.straight = 1e9;
  let outcome = null;
  for (let i = 0; i < 40 && !outcome; i += 1) {
    parting.hunger = 70; stepArcade(parting);
    for (const e of parting.events) if (e.tick === parting.tick && (e.type === "feed" || e.type === "clank")) outcome = e.type;
  }
  assert.equal(outcome, "feed");
});

test("an open mouth holds still enough to aim at: a gulp's verdict barely moves it, while it chews it may", () => {
  const state = run(quiet(8), 120);
  const restMid = { x: state.creature.mouth.midX, y: state.creature.mouth.midY };
  const m = state.creature.mouth;
  assert.ok(launchFood(state, "metal", -30, 13));
  const coin = state.projectiles[0];
  coin.x = m.midX; coin.y = m.midY; coin.vx = 0.1; coin.vy = 0;
  stepArcade(state);
  // Through the chew and the verdict that follows it (an unwanted coin: a shrug).
  let worstOpen = 0;
  for (let i = 0; i < 100; i += 1) {
    state.hunger = 70; stepArcade(state);
    const c = state.creature;
    if (c.untilOpen < 0 && i > 50) {
      worstOpen = Math.max(worstOpen, Math.hypot(c.mouth.midX - restMid.x, c.mouth.midY - restMid.y));
    }
  }
  assert.ok(worstOpen < 12, `the reopened mouth wandered ${worstOpen.toFixed(1)} px`);
});
