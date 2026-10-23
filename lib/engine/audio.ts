/**
 * Original DNFI procedural score, kitchen atmosphere and creature cues.
 * Lazy Web Audio lifecycle and mixer pattern reused from the author's Proof of Patience.
 * Presentation only: this engine never consumes the gameplay RNG.
 * The notes are in ./score.ts; this file plays them.
 */
import { FRENZY_STEP, STEP, heartbeat, heartbeatGap, scoreStep, type Note } from "./score";
export interface AudioMixState {
  master: number; music: boolean; musicLevel: number;
  sfx: boolean; sfxLevel: number; ambience: boolean; ambienceLevel: number;
}
export type SfxId =
  | "feed" | "mistake" | "mutation" | "ui-click" | "launch" | "gust" | "end"
  | "chew" | "clank" | "bank" | "bounce" | "frenzy-start" | "frenzy-end" | "utensil" | "cooked"
  | "flame-tell" | "flame" | "fire" | "jam" | "grow" | "tantrum" | "craving"
  // The coins: a clink on launch and on a catch, pitched by token.
  | "clink-btc" | "clink-eth" | "clink-hemi"
  // Blocks on the chain: lowered in, broken open, hooked on at the end, and a coin that glances off.
  | "block-in" | "block-hit" | "block-gone" | "wrong-token";
export interface MixerAudioEngine {
  unlock(): void;
  play(id: SfxId): void;
  setPlaying(value: boolean): void;
  /** A frenzy: the ambience ducks and the score lifts until it is over. */
  setFrenzy(value: boolean): void;
  /** How worried the score is, 0 calm to 1 about to lose: the heartbeat quickens and the line darkens. */
  setTension(value: number): void;
  setMuted(value: boolean): void;
  setMasterLevel(value: number): void;
  setMusicEnabled(value: boolean): void;
  setMusicLevel(value: number): void;
  setSfxEnabled(value: boolean): void;
  setSfxLevel(value: number): void;
  setAmbienceEnabled(value: boolean): void;
  setAmbienceLevel(value: number): void;
  dispose(): void;
}

type Bus = "music" | "sfx" | "ambience";
type Voice = { source: AudioScheduledSourceNode; envelope: GainNode; bus: Bus };
const MAX_VOICES = 32;

export function createAudioEngine(): MixerAudioEngine {
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let buses: Record<Bus, GainNode> | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let musicTimer: ReturnType<typeof setInterval> | null = null;
  let muted = false;
  let playing = false;
  let frenzy = false;
  let tension = 0;
  let backgroundStarted = false;
  let disposed = false;
  const voices = new Set<Voice>();
  const mix: AudioMixState = { master: .5, music: true, musicLevel: 1, sfx: true, sfxLevel: 1, ambience: true, ambienceLevel: 1 };
  const level = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

  function sync() {
    if (!context || !buses) return;
    const time = context.currentTime;
    master?.gain.setTargetAtTime(muted ? 0 : mix.master * .5, time, .025);
    buses.sfx.gain.setTargetAtTime(mix.sfx ? mix.sfxLevel : 0, time, .025);
    // The frenzy duck: ambience drops to a third, the score comes up. The
    // mixer's own levels still scale everything, so the player's mix holds.
    buses.music.gain.setTargetAtTime(playing && mix.music ? mix.musicLevel * (frenzy ? .5 : .38) : 0, time, .12);
    buses.ambience.gain.setTargetAtTime(playing && mix.ambience ? mix.ambienceLevel * (frenzy ? .1 : .28) : 0, time, .12);
  }

  function register(source: AudioScheduledSourceNode, envelope: GainNode, bus: Bus, nodes: AudioNode[], time: number, duration?: number) {
    const voice = { source, envelope, bus };
    voices.add(voice);
    source.onended = () => {
      voices.delete(voice);
      source.disconnect();
      envelope.disconnect();
      for (const node of nodes) node.disconnect();
    };
    source.start(time);
    if (duration !== undefined) source.stop(time + duration + .04);
  }

  function tone(bus: Bus, frequency: number, endFrequency: number, time: number, duration: number, amplitude: number, type: OscillatorType = "sine", attack = .012) {
    if (!context || !buses || voices.size >= MAX_VOICES) return;
    const source = context.createOscillator();
    const envelope = context.createGain();
    source.type = type;
    source.frequency.setValueAtTime(frequency, time);
    source.frequency.exponentialRampToValueAtTime(endFrequency, time + duration);
    envelope.gain.setValueAtTime(.0001, time);
    envelope.gain.exponentialRampToValueAtTime(amplitude, time + Math.min(attack, duration * .4));
    envelope.gain.exponentialRampToValueAtTime(.0001, time + duration);
    source.connect(envelope);
    envelope.connect(buses[bus]);
    register(source, envelope, bus, [], time, duration);
  }

  function noise(bus: Bus, time: number, duration: number | undefined, frequency: number, amplitude: number) {
    if (!context || !buses || !noiseBuffer || voices.size >= MAX_VOICES) return;
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const envelope = context.createGain();
    source.buffer = noiseBuffer;
    source.loop = true;
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(frequency, time);
    filter.Q.value = .7;
    envelope.gain.setValueAtTime(.0001, time);
    envelope.gain.exponentialRampToValueAtTime(amplitude, time + (duration ? Math.min(.05, duration * .2) : 1));
    if (duration) {
      filter.frequency.exponentialRampToValueAtTime(frequency * .35, time + duration);
      envelope.gain.exponentialRampToValueAtTime(.0001, time + duration);
    }
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(buses[bus]);
    register(source, envelope, bus, [filter], time, duration);
  }

  function stopBackground() {
    if (musicTimer !== null) clearInterval(musicTimer);
    musicTimer = null;
    backgroundStarted = false;
    if (!context) return;
    const time = context.currentTime;
    for (const voice of voices) {
      if (voice.bus === "sfx") continue;
      voice.envelope.gain.cancelScheduledValues(time);
      voice.envelope.gain.setTargetAtTime(.0001, time, .025);
      try { voice.source.stop(time + .15); } catch { /* Already ended. */ }
    }
  }

  function startBackground() {
    if (!context || !buses || !playing || backgroundStarted || disposed) return;
    backgroundStarted = true;
    const time = context.currentTime;
    // Low ventilation and a gently beating electrical hum, below the score.
    noise("ambience", time, undefined, 210, .14);
    for (const frequency of [55, 55.35, 110]) {
      if (voices.size >= MAX_VOICES) break;
      const source = context.createOscillator();
      const envelope = context.createGain();
      source.frequency.value = frequency;
      envelope.gain.setValueAtTime(0, time);
      envelope.gain.linearRampToValueAtTime(frequency === 110 ? .015 : .04, time + 1.2);
      source.connect(envelope);
      envelope.connect(buses.ambience);
      register(source, envelope, "ambience", [], time);
    }
    // The score (./score.ts): a creeping D-Phrygian line over a dread
    // progression, and a heartbeat that quickens with the tension. A short
    // lookahead avoids timer jitter.
    let step = 0;
    let nextNote = time + .1;
    let nextBeat = time + .4;
    const play = (notes: Note[], at: number) => {
      for (const n of notes) tone("music", n.freq, n.endFreq, at + n.at, n.dur, n.amp, n.type, n.attack);
    };
    const schedule = () => {
      if (!context || !playing || context.state !== "running") return;
      const now = context.currentTime;
      if (nextNote < now) nextNote = now + .04;
      if (nextBeat < now) nextBeat = now + .04;
      while (nextNote < now + .28) {
        if (mix.music && !muted) play(scoreStep(step, tension, frenzy), nextNote);
        step += 1;
        nextNote += frenzy ? FRENZY_STEP : STEP;
      }
      while (nextBeat < now + .28) {
        if (mix.music && !muted) play(heartbeat(tension), nextBeat);
        nextBeat += heartbeatGap(tension);
      }
    };
    schedule();
    musicTimer = setInterval(schedule, 120);
  }

  const api: MixerAudioEngine = {
    unlock() {
      if (disposed || typeof window === "undefined" || typeof window.AudioContext === "undefined") return;
      if (!context) {
        context = new AudioContext();
        master = context.createGain();
        buses = { music: context.createGain(), sfx: context.createGain(), ambience: context.createGain() };
        master.gain.value = 0;
        for (const bus of Object.values(buses)) { bus.gain.value = 0; bus.connect(master); }
        master.connect(context.destination);
        noiseBuffer = context.createBuffer(1, context.sampleRate * 3, context.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        let seed = 38147;
        for (let i = 0; i < data.length; i++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
          data[i] = seed / 2147483648;
        }
        sync();
      }
      void context.resume().then(() => startBackground()).catch(() => {});
    },
    setPlaying(value) {
      if (disposed || playing === value) return;
      playing = value;
      if (!playing) frenzy = false;
      if (playing) startBackground(); else stopBackground();
      sync();
    },
    setFrenzy(value) {
      if (disposed || frenzy === value) return;
      frenzy = value;
      sync();
    },
    setTension(value) {
      tension = level(value);
    },
    play(id) {
      if (!context || !buses || context.state !== "running" || muted || !mix.sfx || disposed) return;
      const time = context.currentTime;
      switch (id) {
        case "clink-btc":
        case "clink-eth":
        case "clink-hemi": {
          // A coin on tin: two inharmonic partials with a fast decay and a
          // tick of noise. Bitcoin is the heavy coin, Ether a tone above,
          // HEMI the bright one.
          const base = id === "clink-btc" ? 1480 : id === "clink-eth" ? 1760 : 2217;
          tone("sfx", base, base * .985, time, .16, .11, "triangle", .003);
          tone("sfx", base * 2.76, base * 2.7, time, .09, .05, "sine", .002);
          noise("sfx", time, .03, 5200, .07);
          break;
        }
        case "launch":
          noise("sfx", time, .2, 1500, .2);
          tone("sfx", 160, 65, time, .17, .18, "triangle");
          break;
        case "feed":
          tone("sfx", 170, 78, time, .2, .33, "sine");
          tone("sfx", 330, 190, time + .055, .2, .13, "triangle");
          tone("sfx", 587.33, 660, time + .11, .3, .12);
          noise("sfx", time, .09, 850, .08);
          break;
        case "mistake":
          noise("sfx", time, .16, 1100, .18);
          tone("sfx", 155, 62, time, .38, .22, "triangle");
          tone("sfx", 120, 57, time + .08, .32, .1);
          break;
        case "mutation":
          for (const [i, frequency] of [146.83, 220, 293.66, 440].entries()) {
            tone("sfx", frequency * .7, frequency, time + i * .075, .55, .13, "triangle", .025);
          }
          noise("sfx", time, .6, 2200, .1);
          break;
        case "gust":
          noise("sfx", time, .7, 1400, .23);
          tone("sfx", 95, 48, time, .55, .12);
          break;
        case "end":
          for (const [i, frequency] of [440, 349.23, 293.66, 146.83].entries()) {
            tone("sfx", frequency, frequency, time + i * .17, .8, .14, "sine", .04);
          }
          break;
        case "ui-click":
          tone("sfx", 740, 480, time, .065, .1);
          break;
        case "chew":
          // A wet chomp: a low thud and two quick clicks.
          tone("sfx", 140, 60, time, .12, .22, "triangle");
          noise("sfx", time + .02, .05, 1800, .09);
          noise("sfx", time + .14, .05, 1400, .07);
          break;
        case "clank":
          // Teeth on tin: bright, inharmonic, short.
          for (const f of [2093, 2794, 3729]) tone("sfx", f, f * .97, time, .14, .07, "square", .004);
          tone("sfx", 420, 180, time, .18, .16, "triangle");
          noise("sfx", time, .08, 3200, .14);
          break;
        case "bounce":
          // Off a pan: a ring that decays.
          tone("sfx", 880, 860, time, .3, .12, "triangle", .004);
          tone("sfx", 1320, 1300, time, .22, .05, "sine", .004);
          noise("sfx", time, .05, 2600, .08);
          break;
        case "bank":
          // The bank pays: a rising two-note bell.
          tone("sfx", 659.25, 659.25, time, .22, .14, "triangle", .01);
          tone("sfx", 987.77, 987.77, time + .09, .3, .14, "triangle", .01);
          tone("sfx", 1318.5, 1318.5, time + .18, .4, .1, "sine", .01);
          break;
        case "frenzy-start":
          // A rising sweep and a hit.
          tone("sfx", 110, 880, time, .5, .22, "sawtooth", .02);
          for (const [i, f] of [293.66, 440, 587.33, 880].entries()) tone("sfx", f, f, time + .3 + i * .06, .5, .16, "triangle", .01);
          noise("sfx", time + .3, .5, 1800, .18);
          break;
        case "frenzy-end":
          tone("sfx", 660, 110, time, .6, .14, "sawtooth", .02);
          noise("sfx", time, .3, 900, .1);
          break;
        case "utensil":
          // A fork in the teeth: a clank and a cash-register ding.
          noise("sfx", time, .08, 3400, .14);
          tone("sfx", 1760, 1760, time + .04, .35, .16, "triangle", .005);
          tone("sfx", 2637, 2637, time + .12, .4, .1, "sine", .005);
          break;
        case "cooked":
          noise("sfx", time, .22, 2400, .14);
          tone("sfx", 520, 980, time, .2, .08, "sine");
          break;
        case "flame-tell":
          // The inhale.
          noise("sfx", time, .55, 600, .14);
          tone("sfx", 90, 160, time, .55, .08, "sine", .2);
          break;
        case "flame":
          // The breath: a roar of low noise with a crackle on top.
          noise("sfx", time, .8, 380, .3);
          noise("sfx", time + .05, .6, 2200, .1);
          tone("sfx", 70, 50, time, .7, .14, "sawtooth", .05);
          break;
        case "fire":
          noise("sfx", time, 1.2, 520, .18);
          noise("sfx", time + .2, .9, 3000, .06);
          break;
        case "jam":
          // Something in the works: a grinding clunk.
          tone("sfx", 180, 70, time, .25, .22, "square", .005);
          noise("sfx", time, .3, 700, .16);
          tone("sfx", 95, 60, time + .12, .3, .12, "triangle");
          break;
        case "grow":
          // Bigger: a swell downward, a thump.
          tone("sfx", 220, 110, time, .45, .2, "triangle", .08);
          tone("sfx", 55, 40, time + .1, .5, .22, "sine", .02);
          noise("sfx", time + .1, .25, 300, .12);
          break;
        case "tantrum":
          for (let i = 0; i < 4; i++) tone("sfx", 160 - i * 20, 90, time + i * .11, .14, .2, "square", .005);
          noise("sfx", time, .5, 500, .14);
          break;
        case "craving":
          tone("sfx", 523.25, 523.25, time, .18, .1, "sine", .01);
          tone("sfx", 783.99, 783.99, time + .14, .28, .1, "sine", .01);
          break;
        case "block-in":
          // A hatch in the ceiling and a chain paying out: a clunk and a rattle.
          tone("sfx", 140, 90, time, .18, .14, "square", .004);
          for (let i = 0; i < 5; i++) noise("sfx", time + .08 + i * .06, .04, 3600, .05);
          break;
        case "block-hit":
          // The block cracks and the coins come out: a crack, then a run of dings.
          noise("sfx", time, .12, 900, .26);
          tone("sfx", 120, 55, time, .25, .24, "triangle", .004);
          for (const [i, f] of [1318.5, 1567.98, 1975.53, 2637].entries()) tone("sfx", f, f, time + .07 + i * .07, .32, .11, "triangle", .004);
          break;
        case "block-gone":
          // It hooks onto the chain: two links meeting.
          tone("sfx", 1046.5, 1000, time, .12, .07, "square", .003);
          tone("sfx", 784, 760, time + .09, .2, .06, "triangle", .003);
          break;
        case "wrong-token":
          // A coin on a block it does not open: a dull knock.
          tone("sfx", 260, 180, time, .12, .14, "square", .003);
          noise("sfx", time, .05, 1200, .08);
          break;
      }
    },
    setMuted(value) { muted = value; sync(); },
    setMasterLevel(value) { mix.master = level(value); sync(); },
    setMusicEnabled(value) { mix.music = value; sync(); },
    setMusicLevel(value) { mix.musicLevel = level(value); sync(); },
    setSfxEnabled(value) { mix.sfx = value; sync(); },
    setSfxLevel(value) { mix.sfxLevel = level(value); sync(); },
    setAmbienceEnabled(value) { mix.ambience = value; sync(); },
    setAmbienceLevel(value) { mix.ambienceLevel = level(value); sync(); },
    dispose() {
      disposed = true;
      playing = false;
      stopBackground();
      for (const voice of voices) { try { voice.source.stop(); } catch { /* Already ended. */ } }
      voices.clear();
      void context?.close().catch(() => {});
      context = null;
      master = null;
      buses = null;
      noiseBuffer = null;
    },
  };
  return api;
}
