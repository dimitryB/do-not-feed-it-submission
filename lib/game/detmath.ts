/**
 * Deterministic elementary functions for the rules.
 *
 * ECMAScript leaves `Math.sin`, `cos`, `atan2`, `exp`, `log`, `hypot`, `pow`
 * and the `**` operator "implementation-approximated": each engine ships its
 * own implementation (or defers to the platform's maths library), and they
 * can differ in the last bit. The verifier replays a shift in workerd (V8)
 * and the client refuses to sign numbers that differ from the shift it
 * showed, so a last-bit disagreement that survived the rules' quantisation
 * would leave an honest Safari or Firefox player unable to file
 * (docs/CHAIN.md §3).
 *
 * Everything here is built from operations ECMAScript specifies exactly —
 * `+ − × ÷`, `Math.sqrt`, `Math.floor`, `Math.trunc`, `Math.abs`, integer
 * bit operations and reads and writes of a double's bits through typed
 * arrays — so every conforming engine returns the same bits on every
 * platform. The algorithms are Sun's fdlibm 5.3 (`k_sin.c`, `k_cos.c`,
 * `e_rem_pio2.c`, `e_exp.c`, `e_log.c`, `s_atan.c`, `e_atan2.c` with
 * FreeBSD's quadrant fix; freely distributable, notice in
 * THIRD_PARTY_NOTICES.md). Against Node 22's V8 (linux-arm64): `log`
 * matches bit for bit, `exp`, `atan2`, `sin` and `cos` in 99.5–99.95 % of
 * inputs and are otherwise one unit in the last place away, each side as
 * often the closer to the true value. Argument reduction for `sin`/`cos`
 * always takes fdlibm's medium-size path: accurate to 2^20·π/2 (about
 * 1.65 million; the rules' largest argument is about 1,150, 1.6 × the
 * twelve-minute cap in seconds). Beyond it they return NaN rather than
 * reduce badly: an out-of-range argument is a rules bug, and a reduction
 * that overflowed would make a NaN whose sign bit is the hardware's (x86
 * and ARM differ; IEEE 754 leaves it open).
 *
 * `lib/game/` must not call the engine's versions; ESLint enforces it.
 *
 * The fdlibm routines below are translated from code carrying this notice:
 *
 * ====================================================
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *
 * Developed at SunSoft, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 * ====================================================
 */

const words = new Float64Array(1);
const halves = new Uint32Array(words.buffer);
// Every engine on every shipping platform is little-endian; checked anyway.
const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const HI = LITTLE ? 1 : 0;
const LO = LITTLE ? 0 : 1;

/** The high 32 bits of a double, as a signed int (fdlibm's `__HI`). */
function hiWord(x: number): number { words[0] = x; return halves[HI] | 0; }
/** The low 32 bits of a double, unsigned (fdlibm's `__LO`). */
function loWord(x: number): number { words[0] = x; return halves[LO]; }
/** `x` with its high word replaced. */
function withHi(x: number, hi: number): number { words[0] = x; halves[HI] = hi >>> 0; return words[0]; }
/** A double from its two words. */
function fromWords(hi: number, lo: number): number { halves[HI] = hi >>> 0; halves[LO] = lo >>> 0; return words[0]; }

// ------------------------------------------------------------- sin and cos

const S1 = -1.66666666666666324348e-01;
const S2 = 8.33333333332248946124e-03;
const S3 = -1.98412698298579493134e-04;
const S4 = 2.75573137070700676789e-06;
const S5 = -2.50507602534068634195e-08;
const S6 = 1.58969099521155010221e-10;

/** sin on [-π/4, π/4]; `y` is the tail of `x`, `iy` 0 when there is none (k_sin.c). */
function kernelSin(x: number, y: number, iy: number): number {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix < 0x3e400000) return x; // |x| < 2^-27
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - ((z * (0.5 * y - v * r) - y) - v * S1);
}

const C1 = 4.16666666666666019037e-02;
const C2 = -1.38888888888741095749e-03;
const C3 = 2.48015872894767294178e-05;
const C4 = -2.75573143513906633035e-07;
const C5 = 2.08757232129817482790e-09;
const C6 = -1.13596475577881948265e-11;

/** cos on [-π/4, π/4] (k_cos.c). */
function kernelCos(x: number, y: number): number {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix < 0x3e400000) return 1; // |x| < 2^-27
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3fd33333) return 1 - (0.5 * z - (z * r - x * y)); // |x| < 0.3
  const qx = ix > 0x3fe90000 ? 0.28125 : fromWords(ix - 0x00200000, 0); // x/4
  const hz = 0.5 * z - qx;
  const a = 1 - qx;
  return a - (hz - (z * r - x * y));
}

const INV_PIO2 = 6.36619772367581382433e-01;
const PIO2_1 = 1.57079632673412561417e+00;
const PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.07710050630396597660e-11;
const PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.02226624871116645580e-21;
const PIO2_3T = 8.47842766036889956997e-32;

/** The reduced argument's head and tail, written by `remPio2`. */
const reduced = new Float64Array(2);

/** x = n·π/2 + (reduced[0] + reduced[1]); returns n (e_rem_pio2.c, medium path). */
function remPio2(x: number): number {
  const hx = hiWord(x);
  const ix = hx & 0x7fffffff;
  if (ix <= 0x3fe921fb) { reduced[0] = x; reduced[1] = 0; return 0; } // |x| <= π/4
  if (ix < 0x4002d97c) { // |x| < 3π/4: n = ±1
    if (hx > 0) {
      let z = x - PIO2_1;
      if (ix !== 0x3ff921fb) { reduced[0] = z - PIO2_1T; reduced[1] = (z - reduced[0]) - PIO2_1T; }
      else { z -= PIO2_2; reduced[0] = z - PIO2_2T; reduced[1] = (z - reduced[0]) - PIO2_2T; }
      return 1;
    }
    let z = x + PIO2_1;
    if (ix !== 0x3ff921fb) { reduced[0] = z + PIO2_1T; reduced[1] = (z - reduced[0]) + PIO2_1T; }
    else { z += PIO2_2; reduced[0] = z + PIO2_2T; reduced[1] = (z - reduced[0]) + PIO2_2T; }
    return -1;
  }
  const t0 = Math.abs(x);
  const n = Math.floor(t0 * INV_PIO2 + 0.5);
  const fn = n;
  let r = t0 - fn * PIO2_1;
  let w = fn * PIO2_1T; // good to 85 bits
  const j = ix >> 20;
  reduced[0] = r - w;
  let i = j - ((hiWord(reduced[0]) >> 20) & 0x7ff);
  if (i > 16) { // a second iteration, good to 118 bits
    let t = r;
    w = fn * PIO2_2;
    r = t - w;
    w = fn * PIO2_2T - ((t - r) - w);
    reduced[0] = r - w;
    i = j - ((hiWord(reduced[0]) >> 20) & 0x7ff);
    if (i > 49) { // a third, good to 151 bits
      t = r;
      w = fn * PIO2_3;
      r = t - w;
      w = fn * PIO2_3T - ((t - r) - w);
      reduced[0] = r - w;
    }
  }
  reduced[1] = (r - reduced[0]) - w;
  if (hx < 0) { reduced[0] = -reduced[0]; reduced[1] = -reduced[1]; return -n; }
  return n;
}

export function sin(x: number): number {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelSin(x, 0, 0);
  if (ix > 0x413921fb) return NaN; // past 2^20·π/2, ±∞ and NaN
  const n = remPio2(x);
  switch (n & 3) {
    case 0: return kernelSin(reduced[0], reduced[1], 1);
    case 1: return kernelCos(reduced[0], reduced[1]);
    case 2: return -kernelSin(reduced[0], reduced[1], 1);
    default: return -kernelCos(reduced[0], reduced[1]);
  }
}

export function cos(x: number): number {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelCos(x, 0);
  if (ix > 0x413921fb) return NaN; // past 2^20·π/2, ±∞ and NaN
  const n = remPio2(x);
  switch (n & 3) {
    case 0: return kernelCos(reduced[0], reduced[1]);
    case 1: return -kernelSin(reduced[0], reduced[1], 1);
    case 2: return -kernelCos(reduced[0], reduced[1]);
    default: return kernelSin(reduced[0], reduced[1], 1);
  }
}

// --------------------------------------------------------------------- exp

const O_THRESHOLD = 7.09782712893383973096e+02;
const U_THRESHOLD = -7.45133219101941108420e+02;
const LN2_HI = 6.93147180369123816490e-01;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700e+00;
const TWO_M1000 = 9.33263618503218878990e-302;
const P1 = 1.66666666666666019037e-01;
const P2 = -2.77777777770155933842e-03;
const P3 = 6.61375632143793436117e-05;
const P4 = -1.65339022054652515390e-06;
const P5 = 4.13813679705723846039e-08;

/** e^x (e_exp.c). */
export function exp(x: number): number {
  const word = hiWord(x);
  const xsb = (word >>> 31) & 1;
  const hx = word & 0x7fffffff;
  if (hx >= 0x40862e42) { // |x| >= 709.78
    if (hx >= 0x7ff00000) {
      if (((hx & 0xfffff) | loWord(x)) !== 0) return NaN;
      return xsb === 0 ? x : 0;
    }
    if (x > O_THRESHOLD) return Infinity;
    if (x < U_THRESHOLD) return 0;
  }
  let hi = 0;
  let lo = 0;
  let k = 0;
  if (hx > 0x3fd62e42) { // |x| > 0.5·ln2
    if (hx < 0x3ff0a2b2) { // and |x| < 1.5·ln2
      hi = xsb === 0 ? x - LN2_HI : x + LN2_HI;
      lo = xsb === 0 ? LN2_LO : -LN2_LO;
      k = 1 - xsb - xsb;
    } else {
      k = Math.trunc(INV_LN2 * x + (xsb === 0 ? 0.5 : -0.5));
      const t = k;
      hi = x - t * LN2_HI; // exact here
      lo = t * LN2_LO;
    }
    x = hi - lo;
  } else if (hx < 0x3e300000) { // |x| < 2^-28
    return 1 + x;
  }
  const t = x * x;
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2) - x);
  const y = 1 - ((lo - (x * c) / (2 - c)) - hi);
  if (k >= -1021) return withHi(y, (hiWord(y) + (k << 20)) | 0);
  return withHi(y, (hiWord(y) + ((k + 1000) << 20)) | 0) * TWO_M1000;
}

// --------------------------------------------------------------------- log

const TWO54 = 1.80143985094819840000e+16;
const LG1 = 6.666666666666735130e-01;
const LG2 = 3.999999999940941908e-01;
const LG3 = 2.857142874366239149e-01;
const LG4 = 2.222219843214978396e-01;
const LG5 = 1.818357216161805012e-01;
const LG6 = 1.531383769920937332e-01;
const LG7 = 1.479819860511658591e-01;

/** The natural logarithm (e_log.c). */
export function log(x: number): number {
  let hx = hiWord(x);
  const lx = loWord(x);
  let k = 0;
  if (hx < 0x00100000) { // x < 2^-1022
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54;
    x *= TWO54; // subnormal: scale up
    hx = hiWord(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i0 = (hx + 0x95f64) & 0x100000;
  x = withHi(x, hx | (i0 ^ 0x3ff00000)); // normalise x or x/2
  k += i0 >> 20;
  const f = x - 1;
  if ((0x000fffff & (2 + hx)) < 3) { // |f| < 2^-20
    if (f === 0) return k === 0 ? 0 : k * LN2_HI + k * LN2_LO;
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    return k === 0 ? f - R : k * LN2_HI - ((R - k * LN2_LO) - f);
  }
  const s = f / (2 + f);
  const dk = k;
  const z = s * s;
  let i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  i |= j;
  const R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    return k === 0 ? f - (hfsq - s * (hfsq + R)) : dk * LN2_HI - ((hfsq - (s * (hfsq + R) + dk * LN2_LO)) - f);
  }
  return k === 0 ? f - s * (f - R) : dk * LN2_HI - ((s * (f - R) - dk * LN2_LO) - f);
}

// ------------------------------------------------------------ atan, atan2

const ATAN_HI = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [
  3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01,
  -1.11111104054623557880e-01, 9.09088713343650656196e-02, -7.69187620504482999495e-02,
  6.66107313738753120669e-02, -5.83357013379057348645e-02, 4.97687799461593236017e-02,
  -3.65315727442169155270e-02, 1.62858201153657823623e-02,
];

/** The arctangent (s_atan.c). */
export function atan(x: number): number {
  const hx = hiWord(x);
  const ix = hx & 0x7fffffff;
  let id: number;
  if (ix >= 0x44100000) { // |x| >= 2^66
    if (x !== x) return NaN;
    return hx > 0 ? ATAN_HI[3] + ATAN_LO[3] : -ATAN_HI[3] - ATAN_LO[3];
  }
  if (ix < 0x3fdc0000) { // |x| < 0.4375
    if (ix < 0x3e200000) return x; // |x| < 2^-29
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3ff30000) { // |x| < 1.1875
      if (ix < 0x3fe60000) { id = 0; x = (2 * x - 1) / (2 + x); } // 7/16 <= |x| < 11/16
      else { id = 1; x = (x - 1) / (x + 1); } // 11/16 <= |x| < 19/16
    } else if (ix < 0x40038000) { id = 2; x = (x - 1.5) / (1 + 1.5 * x); } // |x| < 2.4375
    else { id = 3; x = -1 / x; }
  }
  const z = x * x;
  const w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  const r = ATAN_HI[id] - ((x * (s1 + s2) - ATAN_LO[id]) - x);
  return hx < 0 ? -r : r;
}

const PI_O_4 = 7.8539816339744827900e-01;
const PI_O_2 = 1.5707963267948965580e+00;
const PI = 3.1415926535897931160e+00;
const PI_LO = 1.2246467991473531772e-16;

/** The angle of (x, y) (e_atan2.c). */
export function atan2(y: number, x: number): number {
  if (x !== x || y !== y) return NaN;
  const hx = hiWord(x);
  const ix = hx & 0x7fffffff;
  const lx = loWord(x);
  const hy = hiWord(y);
  const iy = hy & 0x7fffffff;
  const ly = loWord(y);
  if (((hx - 0x3ff00000) | lx) === 0) return atan(y); // x = 1
  const m = ((hy >>> 31) & 1) | ((hx >>> 30) & 2); // 2·sign(x) + sign(y)
  if ((iy | ly) === 0) { // y = ±0
    if (m === 0 || m === 1) return y;
    return m === 2 ? PI : -PI;
  }
  if ((ix | lx) === 0) return hy < 0 ? -PI_O_2 : PI_O_2; // x = ±0
  if (ix === 0x7ff00000) { // x = ±∞
    if (iy === 0x7ff00000) return [PI_O_4, -PI_O_4, 3 * PI_O_4, -3 * PI_O_4][m];
    return [0, -0, PI, -PI][m];
  }
  if (iy === 0x7ff00000) return hy < 0 ? -PI_O_2 : PI_O_2; // y = ±∞
  const k = (iy - ix) >> 20;
  let z: number;
  let quadrant = m;
  if (k > 60) { z = PI_O_2 + 0.5 * PI_LO; quadrant &= 1; } // |y/x| > 2^60 (FreeBSD's fix: ±π/2 whatever x's sign)
  else if (hx < 0 && k < -60) z = 0; // |y|/x < -2^60
  else z = atan(Math.abs(y / x));
  switch (quadrant) {
    case 0: return z;
    case 1: return -z;
    case 2: return PI - (z - PI_LO);
    default: return (z - PI_LO) - PI;
  }
}

// ------------------------------------------------------- hypot and powers

/** √(x² + y²). `Math.sqrt` is exactly rounded in every engine; the rules' values never overflow. */
export function hypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/**
 * x^y for the rules' exponents. A whole y from 0 to 16 is repeated
 * multiplication, left to right; anything else is e^(y·ln x) for x > 0, 0 for
 * x = 0 and a positive y, and NaN otherwise.
 */
export function pow(x: number, y: number): number {
  if (y === Math.floor(y) && y >= 0 && y <= 16) {
    let r = 1;
    for (let i = 0; i < y; i++) r *= x;
    return r;
  }
  if (x > 0) return exp(y * log(x));
  if (x === 0 && y > 0) return 0;
  return NaN;
}
