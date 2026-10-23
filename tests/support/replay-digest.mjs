/**
 * A replay that digests the whole rules state every `every` ticks and at the
 * end, so two engines can be compared to the tick range where they part.
 * Shared by scripts/engine-check.mjs (Node side) and the page it builds.
 * `JSON.stringify` of a double is exactly specified (shortest round trip),
 * and object keys keep insertion order, so the text is the same everywhere
 * the state is.
 */
export function fnv64(text) {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** The numbers a filing signs (docs/CHAIN.md §4), as one string. */
export function signedOf(state) {
  return [state.tick, state.phase, state.failureReason, state.score, state.totalFeeds, state.servings.metal,
    state.servings.balloon, state.servings.pepper, state.bestCombo, state.frenzies, Math.round(state.size * 100), state.ending].join("|");
}

export function digestReplay(rules, trace, every = 600) {
  const state = rules.createArcade(trace.seed, trace.inherited ?? null);
  const checkpoints = [];
  let next = every;
  const advance = (until) => {
    while (state.tick < until && state.phase === "playing") {
      rules.stepArcade(state);
      if (state.tick === next) { checkpoints.push(fnv64(JSON.stringify(state))); next += every; }
    }
  };
  for (const c of trace.commands) {
    advance(c.tick);
    const ok = state.tick === c.tick
      && (c.kind === "hatch" ? rules.slamHatch(state) : rules.launchFood(state, c.ingredient, c.angle, c.power));
    if (!ok) return { checkpoints, final: `rejected at tick ${c.tick}`, signed: "" };
  }
  advance(trace.endTick);
  return { checkpoints, final: fnv64(JSON.stringify(state)), signed: signedOf(state) };
}
