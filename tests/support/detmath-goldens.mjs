/**
 * Exact-bit digests of lib/game/detmath.ts over a fixed set of inputs, for
 * tests/detmath.test.mjs and the cross-engine page (scripts/engine-check.mjs).
 * The inputs come from integer arithmetic and exact power-of-two scaling, so
 * every engine generates the same doubles; a digest that differs means that
 * engine computed a different bit somewhere.
 */
export const GOLDEN_COUNT = 20_000;

/**
 * FNV-1a over every result's eight bytes, as 64 bits (two 32-bit lanes). A
 * NaN counts as one value: IEEE 754 leaves its sign and payload to the
 * hardware (x86 and ARM make different ones), and nothing in the rules can
 * see them — `JSON.stringify` writes every NaN as null.
 */
export function bitsDigest(values) {
  const words = new Float64Array(1);
  const halves = new Uint32Array(words.buffer);
  const little = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  let a = 0x811c9dc5, b = 0xcbf29ce4;
  const mix = (word) => {
    for (let shift = 0; shift < 32; shift += 8) {
      const byte = (word >>> shift) & 0xff;
      a = Math.imul(a ^ byte, 0x01000193) >>> 0;
      b = Math.imul(b ^ byte, 0x5bd1e995) >>> 0;
      b = (b ^ (b >>> 13)) >>> 0;
    }
  };
  for (const v of values) {
    if (Number.isNaN(v)) { halves[little ? 1 : 0] = 0x7ff80000; halves[little ? 0 : 1] = 0; } else words[0] = v;
    mix(halves[little ? 1 : 0]); mix(halves[little ? 0 : 1]);
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** `count` doubles in [lo, hi): a 32-bit counter hash scaled by 2^-32 (exact), then one multiply and one add. */
export function inputs(seed, count, lo, hi) {
  const out = new Array(count);
  let s = seed >>> 0;
  for (let i = 0; i < count; i++) {
    s = (s + 0x9e3779b9) >>> 0;
    let z = Math.imul(s ^ (s >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    out[i] = lo + (hi - lo) * (((z ^ (z >>> 16)) >>> 0) / 4294967296);
  }
  return out;
}

const SPECIAL = [0, -0, 1, -1, 0.5, -0.5, 2, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI, 3 * Math.PI / 4, 1e-300, -1e-300, 5e-324, 1e300, -1e300, 709.7, -745, 823549.6, Infinity, -Infinity, NaN];

/** The cases: what each function is run over (the rules' ranges, a wide range, and the special values). */
export function goldenCases(D) {
  const pair = (seed, lo, hi) => { const xs = inputs(seed, GOLDEN_COUNT, lo, hi), ys = inputs(seed ^ 0x55555555, GOLDEN_COUNT, lo, hi); return xs.map((x, i) => [ys[i], x]); };
  return {
    sin: () => [...inputs(1, GOLDEN_COUNT, -2000, 2000), ...SPECIAL].map(D.sin),
    cos: () => [...inputs(2, GOLDEN_COUNT, -2000, 2000), ...SPECIAL].map(D.cos),
    exp: () => [...inputs(3, GOLDEN_COUNT, -60, 60), ...inputs(4, 2000, -746, 710), ...SPECIAL].map(D.exp),
    log: () => [...inputs(5, GOLDEN_COUNT, 0, 4), ...inputs(6, 2000, 0, 1e6), ...SPECIAL].map(D.log),
    atan: () => [...inputs(7, GOLDEN_COUNT, -40, 40), ...SPECIAL].map(D.atan),
    atan2: () => [...pair(8, -1300, 1300), ...SPECIAL.flatMap((y) => SPECIAL.map((x) => [y, x]))].map(([y, x]) => D.atan2(y, x)),
    hypot: () => pair(9, -1300, 1300).map(([y, x]) => D.hypot(x, y)),
    pow: () => [
      ...inputs(10, GOLDEN_COUNT, 0, 1).map((x) => D.pow(x, 0.7)),
      ...inputs(11, GOLDEN_COUNT, 0, 1).map((x) => D.pow(x, 0.4)),
      ...inputs(12, GOLDEN_COUNT, -1, 1).map((x) => D.pow(x, 5)),
      ...inputs(13, GOLDEN_COUNT, -3, 3).map((x) => D.pow(x, 2)),
    ],
  };
}

export function goldenDigests(D) {
  const out = {};
  for (const [name, run] of Object.entries(goldenCases(D))) out[name] = bitsDigest(run());
  return out;
}

/** Recorded from the port, October 22, 2026; Node 22 on linux-arm64 and linux-x64 agree. Any engine must reproduce these exactly. */
export const GOLDEN = Object.freeze({
  sin: "f1ef11be67f7dfbb", cos: "b0a632441019412d", exp: "b85955f47f5fb173", log: "0a5ccad86ba6613d",
  atan: "233bac5d2cacca7a", atan2: "11297fffc35a74b6", hypot: "910b3d61fe7b92c1", pow: "931d2a3b1a9d8e91",
});
