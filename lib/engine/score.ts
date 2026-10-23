/**
 * The score: an original, procedural, worried little piece. Pure data and
 * arithmetic — no Web Audio here — so the engine plays it, the tests check it
 * and a preview script can render it to a file with the same notes.
 *
 * D Phrygian with a tritone: a melody that creeps by half steps (D–E♭–D,
 * then G♯ under A), over slow low chords on a dread progression — i, ♭VI,
 * ♭II (the Neapolitan), V with a flat fifth — and a heartbeat under all of
 * it. Tension (0 calm, 1 about to lose) speeds the heartbeat, deepens the
 * minor-second shadow on the melody, sags its pitch and brings in a thin,
 * beating whine on top. A frenzy still lifts it: double time and a fifth on
 * every note.
 *
 * Voiced for a laptop: small speakers lose everything under about
 * 100 Hz, so every layer that has to carry the dread keeps a voice above it.
 * The heartbeat is a triangle that starts near 150 Hz and falls into the sub;
 * each chord has its colour tones (the third, the flat fifth) up around
 * 140–240 Hz over a low root; the shadow is faintly there from the start.
 */

export interface Note {
  /** Seconds after the step (or the beat) starts. */
  at: number;
  freq: number;
  /** The pitch it glides to by the end (exponential, like the engine's ramp). */
  endFreq: number;
  dur: number;
  amp: number;
  type: 'sine' | 'triangle';
  attack: number;
}

/** Seconds per melody step, calm and in a frenzy. */
export const STEP = 0.72;
export const FRENZY_STEP = 0.36;

const D4 = 293.66, EB4 = 311.13, F4 = 349.23, GS3 = 207.65, A3 = 220.0, BB3 = 233.08;
/** Thirty-two steps, 0 a rest. Two phrases: the creep, and the creep that gets further. */
export const MELODY: readonly number[] = [
  D4, 0, EB4, 0, D4, 0, 0, GS3, A3, 0, BB3, 0, A3, 0, 0, 0,
  D4, 0, EB4, 0, F4, 0, EB4, 0, D4, 0, 0, GS3, 0, A3, 0, 0,
];
/**
 * One chord every eight steps: Dm, B♭, E♭ (♭II), A with a flat fifth. A low
 * root for the weight, and the two colour tones an octave or two up so a
 * small speaker still hears the chord change — and the tritone.
 */
export const CHORDS: readonly (readonly number[])[] = [
  [73.42, 174.61, 220.0],
  [58.27, 146.83, 174.61],
  [77.78, 196.0, 233.08],
  [55.0, 138.59, 155.56],
];

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** How worried the music should be, from the shift: an emptying belly or rising irritation, whichever is worse. */
export function tensionFor(hunger: number, rage: number): number {
  return clamp01(Math.max((60 - hunger) / 50, (rage - 40) / 50));
}

/** The notes for melody step `step` at a given tension; the engine schedules them from the step's start. */
export function scoreStep(step: number, tension: number, frenzy: boolean): Note[] {
  const t = clamp01(tension);
  const notes: Note[] = [];
  // Notes and chords last about as long as the step they belong to, so a frenzy
  // (double time) does not pile up voices and starve the catch sounds.
  const span = 8 * (frenzy ? FRENZY_STEP : STEP);
  const freq = MELODY[((step % MELODY.length) + MELODY.length) % MELODY.length];
  if (freq) {
    // The line sags a little as it sounds, more when things are bad.
    const sag = 1 - lerp(0.009, 0.03, t);
    notes.push({ at: 0, freq, endFreq: freq * sag, dur: frenzy ? 0.7 : 1.5, amp: 0.085, type: 'triangle', attack: 0.06 });
    if (!frenzy) notes.push({ at: 0, freq: freq / 2, endFreq: (freq / 2) * sag, dur: 1.2, amp: 0.035, type: 'sine', attack: 0.08 });
    // A minor-second shadow above the line: a faint sourness from the start,
    // and it thickens as it goes badly.
    notes.push({ at: 0.03, freq: freq * 1.0595, endFreq: freq * 1.0595 * sag, dur: frenzy ? 0.6 : 1.1, amp: lerp(0.006, 0.035, t), type: 'sine', attack: 0.15 });
    if (frenzy) notes.push({ at: FRENZY_STEP / 2, freq: freq * 1.5, endFreq: freq * 1.5, dur: 0.34, amp: 0.06, type: 'triangle', attack: 0.02 });
  }
  if (step % 8 === 0) {
    const [root, third, fifth] = CHORDS[Math.floor(step / 8) % CHORDS.length];
    const attack = frenzy ? 0.3 : 0.9;
    notes.push({ at: 0, freq: root, endFreq: root * 0.997, dur: span * 0.97, amp: 0.05, type: 'sine', attack });
    notes.push({ at: 0, freq: third, endFreq: third * 0.997, dur: span * 0.97, amp: 0.04, type: 'sine', attack });
    notes.push({ at: 0, freq: fifth, endFreq: fifth * 0.997, dur: span * 0.97, amp: 0.028, type: 'triangle', attack });
    // The whine: two high tones a few hertz apart, so they beat. Only when worried.
    if (t > 0.2) {
      const amp = 0.012 * (t - 0.2) / 0.8;
      notes.push({ at: 0, freq: 1174.66, endFreq: 1174.66, dur: span * 0.97, amp, type: 'sine', attack: span * 0.38 });
      notes.push({ at: 0, freq: 1180.2, endFreq: 1180.2, dur: span * 0.97, amp, type: 'sine', attack: span * 0.38 });
    }
  }
  return notes;
}

/** Seconds between heartbeats: a slow pulse when calm, racing near the end. */
export function heartbeatGap(tension: number): number {
  return lerp(1.6, 0.52, clamp01(tension));
}

/**
 * One heartbeat, lub then dub, louder the more worried it is. Each beat is a
 * triangle that starts where a small speaker can hear it and falls into the
 * sub, so the thump reads on a laptop and the weight still lands on headphones.
 */
export function heartbeat(tension: number): Note[] {
  const amp = lerp(0.06, 0.13, clamp01(tension));
  return [
    { at: 0, freq: 150, endFreq: 38, dur: 0.24, amp, type: 'triangle', attack: 0.006 },
    { at: 0.2, freq: 125, endFreq: 34, dur: 0.2, amp: amp * 0.7, type: 'triangle', attack: 0.006 },
  ];
}
