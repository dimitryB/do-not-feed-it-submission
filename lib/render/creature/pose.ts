/**
 * Turns game state into a creature performance.
 *
 * The targets — which expression the face is wearing and how hard — come from
 * `lib/game/face.ts`, which the rules share: the mouth is the target, so the
 * channels that shape and move it are the rules' own and are sprung there, in
 * tick time. This class springs every other channel (eyes, brows, teeth, skin)
 * in the renderer's time, and during a shift copies the mouth's channels from
 * the rules rather than animating them, so the opening on screen is exactly
 * the opening a projectile is tested against.
 *
 * Off shift (the title, the results) there is nothing to hit, and the
 * renderer springs every channel itself toward the same targets.
 */
import { inFrenzy, type ArcadeState } from "../../game/arcade";
import {
  DEFAULT_RATE, FIELDS, GEOMETRY, RATES, faceInputOf, faceTargets, neutralPose, targetRow, type FacePose,
} from "../../game/face";

export type CreaturePose = FacePose;
export { BODY_SCALE_PER_SIZE } from "../../game/face";

/** Deterministic per-index noise; the renderer's own, never the game's. */
const hashed = (index: number) => {
  const value = Math.sin(index * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
};

/**
 * How long, in seconds, the renderer eases from its own pose onto the rules'
 * when a shift starts. Nothing can reach the mouth that fast: the quickest
 * shot is in the air for well over half a second.
 */
const HANDOVER = 0.3;

export class CreatureAnimator {
  private readonly pose = neutralPose();
  private readonly velocity = neutralPose();
  private readonly target = neutralPose();
  private readonly row = targetRow();
  private blinkAt = -1;
  private blinkIndex = 0;
  private blinkUntil = 0;
  private started = -1;
  /** When the rules last started driving the mouth, renderer seconds; -1 off shift. */
  private ruledSince = -1;
  /** The shift the rules were driving, and how far into it: a new one starts the handover again. */
  private ruledRun = -1;
  private ruledTick = -1;
  /** When a coin last brushed a lip without going in, renderer seconds. */
  private noticeAt = -10;

  constructor() {
    for (const field of FIELDS) this.velocity[field] = 0;
  }

  /** Advances the performance. `time` is the renderer clock in seconds. */
  step(state: ArcadeState | null, playing: boolean, reduced: boolean, time: number, delta: number,
       allowBlink = true, useRules = true): CreaturePose {
    if (this.started < 0) {
      this.started = time;
      this.blinkAt = time + 1.4 + hashed(1) * 2.6;
    }
    const live = !!state && state.phase === "playing";
    const input = state ? faceInputOf(state, playing && live ? inFrenzy(state) : false) : null;
    faceTargets(this.row, input, playing, reduced, time - this.started);
    const target = this.target;
    for (let i = 0; i < FIELDS.length; i++) target[FIELDS[i]] = this.row[i];
    // Blink. Reduced motion holds the eyes open rather than flashing them.
    if (!reduced && allowBlink) {
      if (time > this.blinkAt) {
        this.blinkIndex++;
        this.blinkUntil = time + 0.13;
        const starved = clamp01((52 - (state?.hunger ?? 78)) / 46);
        const hunger = starved * starved * (3 - 2 * starved);
        this.blinkAt = time + 1.6 + hashed(this.blinkIndex) * 3.4 - hunger * 0.4;
      }
      if (time < this.blinkUntil) target.blink = 1;
    }
    // A near miss: a quick double-take.
    const since = time - this.noticeAt;
    if (!reduced && since >= 0 && since < 0.55) {
      const k = Math.sin(Math.PI * since / 0.55);
      target.browRaise = Math.max(target.browRaise, 0.95 * k);
      target.pupilScale += 0.3 * k;
      target.blink = 0;
    }

    const step = Math.min(0.05, Math.max(0.001, delta));
    for (const field of FIELDS) {
      const [stiffness, damping] = RATES[field] ?? DEFAULT_RATE;
      const settle = reduced ? damping * 1.9 : damping;
      const difference = target[field] - this.pose[field];
      this.velocity[field] += (difference * stiffness - this.velocity[field] * settle) * step;
      this.pose[field] += this.velocity[field] * step;
    }

    // During a shift the mouth is the rules'. Copy it — value and velocity, so
    // the springs carry on from exactly here when the shift ends.
    const ruled = useRules && playing && live && state ? state.creature : null;
    if (ruled && ruled.face) {
      // Eased only at the very start of a shift, when nothing can be in the
      // air yet; picked up mid-shift (after a pause, say) it is exact at once.
      if (state && (state.seed !== this.ruledRun || state.tick < this.ruledTick)) this.ruledSince = -1;
      if (this.ruledSince < 0) this.ruledSince = state && state.tick < 20 ? time : time - HANDOVER;
      this.ruledRun = state ? state.seed : -1;
      this.ruledTick = state ? state.tick : -1;
      // Clamped: the clock can run backwards between two runs (a harness resets it).
      const blend = Math.max(0, Math.min(1, (time - this.ruledSince) / HANDOVER));
      const face = ruled.face;
      for (let i = 0; i < GEOMETRY.length; i++) {
        const field = GEOMETRY[i];
        this.pose[field] = blend >= 1 ? face.pose[i] : this.pose[field] + (face.pose[i] - this.pose[field]) * blend;
        this.velocity[field] = face.velocity[i];
      }
      this.pose.mouthX = ruled.x;
      this.pose.mouthY = ruled.y;
      this.velocity.mouthX = 0;
      this.velocity.mouthY = 0;
    } else {
      this.ruledSince = -1;
      this.ruledTick = -1;
    }
    return this.pose;
  }

  /**
   * A coin just brushed a lip and flew on: the eyes go wide and the brows
   * jump for a moment. Eyes and brows only; nothing that moves the opening.
   */
  notice(time: number) { this.noticeAt = time; }

  /** Development only: the pose as it currently stands. */
  get current(): CreaturePose { return this.pose; }

  /** The pose without spring smoothing, for a still capture that must be exact. */
  snapToTargets() {
    for (const field of FIELDS) { this.pose[field] = this.target[field]; this.velocity[field] = 0; }
  }
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);
