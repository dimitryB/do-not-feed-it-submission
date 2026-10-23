import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { replayArcade } from "../lib/game/arcade.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "loop-traces.json");

/**
 * Frozen bot traces.
 *
 * Regenerated with `node --experimental-strip-types scripts/loop-bots.mjs
 * --fixtures tests/fixtures/loop-traces.json` whenever a rule changes, and
 * committed with that change. The point is not that these numbers are correct
 * — it is that a trace recorded from real play reproduces its final state
 * exactly, and that a rule change is never silent.
 */
const fixtures = JSON.parse(readFileSync(FIXTURES, "utf8"));

test("frozen bot traces replay to a byte-identical final state", () => {
  assert.ok(fixtures.traces.length >= 3, "expected at least three frozen traces");
  for (const trace of fixtures.traces) {
    const once = replayArcade(trace.seed, trace.commands, trace.endTick, trace.inherited ?? null);
    const twice = replayArcade(trace.seed, trace.commands, trace.endTick, trace.inherited ?? null);
    assert.deepEqual(twice, once, `${trace.bot}: replay is not deterministic`);
    assert.equal(once.tick, trace.endTick, `${trace.bot}: replay stopped at a different tick`);
  }
});

test("frozen bot traces still produce the result they were recorded with", () => {
  for (const trace of fixtures.traces) {
    const final = replayArcade(trace.seed, trace.commands, trace.endTick, trace.inherited ?? null);
    assert.deepEqual({
      score: final.score,
      totalFeeds: final.totalFeeds,
      phase: final.phase,
      failureReason: final.failureReason,
    }, trace.expect, `${trace.bot}: the rules changed without the fixtures being regenerated`);
  }
});
