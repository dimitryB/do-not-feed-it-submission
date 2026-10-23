import assert from "node:assert/strict";
import test from "node:test";
import { CHORDS, FRENZY_STEP, MELODY, STEP, heartbeat, heartbeatGap, scoreStep, tensionFor } from "../lib/engine/score.ts";

/**
 * The score is presentation, but three things about it matter to the game:
 * it has to say "worse" when the shift is going badly, it must never starve
 * the catch sounds of voices (the engine has 32), and every note must be a
 * note the engine can play.
 */

test("tension follows the shift: an emptying belly or rising irritation, whichever is worse", () => {
  assert.equal(tensionFor(100, 0), 0, "fed and calm");
  assert.equal(tensionFor(60, 40), 0, "nothing to worry about yet");
  assert.equal(tensionFor(10, 0), 1, "nearly empty");
  assert.equal(tensionFor(100, 90), 1, "nearly wrecked");
  assert.ok(tensionFor(35, 0) > 0.4 && tensionFor(35, 0) < 0.6);
  assert.equal(tensionFor(NaN, NaN), 0);
});

test("the heartbeat races as it gets worse, and gets louder", () => {
  let last = Infinity;
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const gap = heartbeatGap(t);
    assert.ok(gap < last, "faster with every step of tension");
    last = gap;
  }
  assert.ok(heartbeatGap(0) >= 1.4 && heartbeatGap(1) <= 0.6);
  assert.ok(heartbeat(1)[0].amp > heartbeat(0)[0].amp);
});

test("it gets darker with tension: the shadow and the whine only come in when it is going badly", () => {
  const notesAt = (t) => Array.from({ length: 32 }, (_, s) => scoreStep(s, t, false)).flat();
  const high = (notes) => notes.filter((n) => n.freq > 1000).length;
  assert.equal(high(notesAt(0)), 0, "no whine when calm");
  assert.ok(high(notesAt(1)) > 0, "a whine when about to lose");
  assert.ok(notesAt(1).length > notesAt(0).length, "more going on when it is worse");
});

test("it carries on a laptop: the heartbeat, the chords and the shadow all have a voice above 100 Hz", () => {
  // Small speakers lose almost everything under 100 Hz (D172). The dread must not live only there.
  for (const t of [0, 0.5, 1]) {
    for (const n of heartbeat(t)) {
      assert.equal(n.type, "triangle", "a triangle has harmonics a small speaker can reproduce");
      assert.ok(n.freq >= 120, `a beat starts where it can be heard, not ${n.freq} Hz`);
      assert.ok(n.endFreq < 50, "and still falls into the sub for the weight");
    }
  }
  for (const chord of CHORDS) assert.ok(chord.filter((f) => f >= 130).length >= 2, `the chord's colour sits up where it is heard: ${chord}`);
  const calm = scoreStep(0, 0, false);
  const line = calm.find((n) => n.type === "triangle" && n.freq === MELODY[0]);
  assert.ok(line, "the line is there");
  assert.ok(calm.some((n) => Math.abs(n.freq - line.freq * 1.0595) < 0.01 && n.amp > 0), "a faint minor-second shadow even when calm");
  assert.ok(scoreStep(0, 1, false).find((n) => Math.abs(n.freq - line.freq * 1.0595) < 0.01).amp > calm.find((n) => Math.abs(n.freq - line.freq * 1.0595) < 0.01).amp, "and thicker when it is going badly");
});

test("every note is playable, and the score never takes more than 14 of the engine's 32 voices", () => {
  for (const f of MELODY) assert.ok(f === 0 || (f > 100 && f < 1000));
  for (const chord of CHORDS) for (const f of chord) assert.ok(f > 40 && f < 400);
  for (const [tension, frenzy] of [[0, false], [0.5, false], [1, false], [0.6, true], [1, true]]) {
    const step = frenzy ? FRENZY_STEP : STEP;
    const spans = [];
    for (let s = 0; s < 96; s += 1) {
      for (const n of scoreStep(s, tension, frenzy)) {
        assert.ok(n.freq > 20 && n.endFreq > 20 && n.dur > 0 && n.amp > 0 && n.amp <= 0.2 && n.attack > 0, JSON.stringify(n));
        spans.push([s * step + n.at, s * step + n.at + n.dur]);
      }
    }
    for (let at = 0; at < 96 * step; at += heartbeatGap(tension)) for (const n of heartbeat(tension)) spans.push([at + n.at, at + n.at + n.dur]);
    let peak = 0;
    for (let x = 0; x < 96 * step; x += 0.02) peak = Math.max(peak, spans.filter(([a, e]) => a <= x && x < e).length);
    assert.ok(peak <= 14, `tension ${tension}${frenzy ? " in a frenzy" : ""}: ${peak} voices at once`);
  }
});
