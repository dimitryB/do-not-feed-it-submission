import assert from "node:assert/strict";
import test from "node:test";
import { advanceTo, createRun, feed, replay } from "../lib/game/simulation.ts";
import { ROUND_TICKS, TICKS_PER_SECOND, INGREDIENTS } from "../lib/game/config.ts";

test("recorded successful and mistaken inputs replay to exactly the same result", () => {
  const run = createRun(12345);
  const commands = [];
  for (let tick = 0; tick < ROUND_TICKS && run.phase === "playing"; tick += 90) {
    advanceTo(run, tick);
    const ingredient = tick % 450 === 0 ? INGREDIENTS[(INGREDIENTS.indexOf(run.wanted) + 1) % 3] : run.wanted;
    if (feed(run, ingredient)) commands.push({ tick, ingredient });
  }
  advanceTo(run, ROUND_TICKS);
  assert.deepEqual(replay(12345, commands, ROUND_TICKS), run);
});
test("rapid duplicate inputs cannot increase the score or serving counters", () => {
  const run = createRun(7);
  assert.equal(feed(run, run.wanted), true);
  const expected = structuredClone(run);
  assert.equal(feed(run, run.wanted), false);
  assert.deepEqual(run, expected);
});
test("starvation ends an unattended run and terminal runs cannot gain points", () => {
  const run = createRun(3);
  advanceTo(run, ROUND_TICKS);
  assert.equal(run.phase, "lost");
  assert.equal(run.tick, 70 * TICKS_PER_SECOND);
  assert.equal(feed(run, run.wanted), false);
  assert.equal(run.score, 0);
});
test("replay rejects malformed timing and unknown ingredients", () => {
  assert.throws(() => replay(1, [{ tick: 20, ingredient: "metal" }, { tick: 10, ingredient: "metal" }], 30));
  assert.throws(() => replay(1, [{ tick: 0, ingredient: "unlisted" }], 30));
  assert.throws(() => replay(1, [], ROUND_TICKS + 1));
});
