import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as D from "../lib/game/detmath.ts";
import { GOLDEN, goldenDigests, inputs } from "./support/detmath-goldens.mjs";

// lib/game/detmath.ts: the rules' elementary functions, built from exactly
// specified operations so every engine returns the same bits (docs/CHAIN.md §3).

const words = new Float64Array(1);
const bits = new BigInt64Array(words.buffer);
const ulps = (a, b) => {
  if (Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b))) return 0n;
  words[0] = a; const x = bits[0]; words[0] = b; const d = x - bits[0];
  return d < 0n ? -d : d;
};
const worst = (xs, f, g) => xs.reduce((max, x) => { const u = ulps(f(x), g(x)); return u > max ? u : max; }, 0n);

test("every function reproduces its recorded bits exactly", () => {
  assert.deepEqual(goldenDigests(D), GOLDEN);
});

test("within one unit in the last place of the engine's own Math (two for hypot)", () => {
  const wide = inputs(21, 50_000, -2000, 2000);
  assert.ok(worst(wide, D.sin, Math.sin) <= 1n, "sin");
  assert.ok(worst(wide, D.cos, Math.cos) <= 1n, "cos");
  assert.ok(worst(inputs(22, 50_000, -700, 700), D.exp, Math.exp) <= 1n, "exp");
  assert.ok(worst(inputs(23, 50_000, 0, 1e4), D.log, Math.log) <= 1n, "log");
  assert.ok(worst(inputs(24, 50_000, -1e3, 1e3), D.atan, Math.atan) <= 1n, "atan");
  const ys = inputs(25, 50_000, -1300, 1300);
  assert.ok(worst(inputs(26, 50_000, -1300, 1300), (x) => D.atan2(ys[0] + x, x), (x) => Math.atan2(ys[0] + x, x)) <= 1n, "atan2");
  assert.ok(worst(ys, (x) => D.hypot(x, 0.75 * x + 3), (x) => Math.hypot(x, 0.75 * x + 3)) <= 2n, "hypot");
});

test("powers: whole exponents are left-to-right products, fractional ones are close to the engine's", () => {
  for (const x of inputs(27, 2_000, -1, 1)) {
    assert.equal(D.pow(x, 2), x * x);
    assert.equal(D.pow(x, 5), x * x * x * x * x);
    assert.equal(D.pow(x, 0), 1);
  }
  for (const x of inputs(28, 20_000, 1e-4, 1)) {
    for (const y of [0.4, 0.7]) assert.ok(Math.abs(D.pow(x, y) / x ** y - 1) < 4e-15, `pow(${x}, ${y})`);
  }
  assert.equal(D.pow(0, 0.7), 0);
  assert.ok(Number.isNaN(D.pow(-0.5, 0.7)));
});

// fdlibm's medium-size reduction is exact up to 2^20·π/2 (its 0x413921fb); the
// rules' largest argument is about 1,150 (1.6 × the twelve-minute cap in seconds).
const SIN_DOMAIN = 2 ** 20 * (Math.PI / 2) * 0.9999;

test("sin and cos stay within one unit in the last place across their whole domain, and are NaN past it", () => {
  const xs = inputs(29, 50_000, -SIN_DOMAIN, SIN_DOMAIN);
  assert.ok(worst(xs, D.sin, Math.sin) <= 1n, "sin");
  assert.ok(worst(xs, D.cos, Math.cos) <= 1n, "cos");
  for (const x of [SIN_DOMAIN * 1.01, -2e6, 1e300, Infinity, -Infinity, NaN]) {
    assert.ok(Number.isNaN(D.sin(x)) && Number.isNaN(D.cos(x)), `${x}`);
  }
});

test("special values follow Math", () => {
  const special = [0, -0, 1, -1, Infinity, -Infinity, NaN, 1e-310, -1e-310, 1e300, -1e300];
  for (const x of special) {
    // Exact where the answer is exact (zeros, infinities, NaN); a sub-ULP implementation elsewhere
    // (fdlibm's exp(1) is one unit above Math.E, which V8 returns).
    const exact = x === 0 || !Number.isFinite(x);
    for (const name of ["exp", "log", "atan", "sin", "cos"]) {
      if ((name === "sin" || name === "cos") && Math.abs(x) > SIN_DOMAIN) continue; // deterministic there, not accurate
      const u = ulps(D[name](x), Math[name](x));
      assert.ok(exact ? u === 0n : u <= 1n, `${name}(${x}): ${u} ulp`);
    }
    for (const y of special) assert.equal(ulps(D.atan2(y, x), Math.atan2(y, x)), 0n, `atan2(${y}, ${x})`);
  }
});

test("the rules call none of the engine's approximated functions", () => {
  // ESLint enforces this too (eslint.config.mjs); this keeps `npm test` honest on its own.
  const banned = /Math\.(sin|cos|tan|asin|acos|atan2?|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|cbrt|hypot|pow)\b/;
  for (const file of ["arcade.ts", "body.ts", "face.ts"]) {
    const code = readFileSync(new URL(`../lib/game/${file}`, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(code, banned, file);
    assert.doesNotMatch(code, /\*\*/, `${file} uses the ** operator`);
  }
});
