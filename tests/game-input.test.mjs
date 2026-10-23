import assert from "node:assert/strict";
import test from "node:test";
import { applyGameCommand } from "../app/components/gameInput.ts";
import { createArcade, replayArcade, stepArcade } from "../lib/game/arcade.ts";

const shot = (tick) => ({ tick, kind: "launch", ingredient: "pepper", angle: -30, power: 13 });

test("launching and pressing the hatch between frames leaves a replayable shift", () => {
  const state = createArcade(1);
  const commands = [];
  assert.equal(applyGameCommand(state, commands, shot(0)), true);
  assert.equal(applyGameCommand(state, commands, { tick: 0, kind: "hatch" }), false);
  assert.equal(state.hatchClosedUntil, 0, "a rejected input must not change the live rules");
  stepArcade(state);
  assert.equal(applyGameCommand(state, commands, { tick: 1, kind: "hatch" }), true);
  for (let i = 0; i < 120; i++) stepArcade(state);
  assert.deepEqual(replayArcade(1, commands, state.tick), state);
});

test("rejected and stale inputs do not enter the trace or mutate the run", () => {
  const state = createArcade(2);
  const commands = [];
  assert.equal(applyGameCommand(state, commands, shot(0)), true);
  stepArcade(state);
  const before = structuredClone(state);
  assert.equal(applyGameCommand(state, commands, shot(1)), false, "launch cooldown still applies");
  assert.equal(applyGameCommand(state, commands, { tick: 0, kind: "hatch" }), false);
  assert.deepEqual(state, before);
  assert.equal(commands.length, 1);
});
