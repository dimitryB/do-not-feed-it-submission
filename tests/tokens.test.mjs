import assert from "node:assert/strict";
import test from "node:test";
import { MARK_TILT, TOKENS } from "../lib/render/tokens.ts";
import { CRAVING_LINES, ENDING_JOKES, TOKEN_TRAITS } from "../lib/render/lore.ts";
import { communityDietLine } from "../lib/community/diet.ts";

/**
 * The token pass is presentation only: the rules keep their keys and labels
 * and the screen draws coins. These pin the token table and the stub the
 * chain layer will fill, so neither drifts quietly. The words are pinned in
 * `lore.test.mjs`.
 */

test("every ingredient has a token, a trait, a craving line and a sane mark fraction", () => {
  for (const key of ["metal", "balloon", "pepper"]) {
    const spec = TOKENS[key];
    assert.ok(spec.sources.length >= 1, `${key}: a source`);
    assert.ok(spec.markFraction > 0.5 && spec.markFraction <= 1, `${key}: the mark fills the plate without leaving it`);
    assert.ok(TOKEN_TRAITS[key].length > 0);
    assert.match(CRAVING_LINES[key], /^IT WANTS (BTC|ETH|HEMI)\.$/);
  }
  assert.equal(TOKENS.metal.id, "BTC");
  assert.equal(TOKENS.balloon.id, "ETH");
  assert.equal(TOKENS.pepper.id, "HEMI");
  assert.equal(ENDING_JOKES.length, 4, "one joke per ending");
  assert.ok(Math.abs(MARK_TILT - Math.PI / 12) < 1e-9, "a mark turns by at most 15 degrees");
});

test("the community diet line names the largest share, and says nothing for no data", () => {
  assert.equal(communityDietLine(null), null);
  assert.equal(communityDietLine({ btc: 0, eth: 0, hemi: 0, window: "this week" }), null);
  assert.equal(communityDietLine({ btc: 0.61, eth: 0.25, hemi: 0.14, window: "this week" }), "The community fed it 61% BTC this week.");
  assert.equal(communityDietLine({ btc: 10, eth: 20, hemi: 70, window: "today" }), "The community fed it 70% HEMI today.");
  assert.equal(communityDietLine({ btc: 1, eth: 3, hemi: 0, window: "this week" }), "The community fed it 75% ETH this week.");
});
