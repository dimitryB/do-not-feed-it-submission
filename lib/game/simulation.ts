import { BASE_FEED_SCORE, FEED_COOLDOWN_TICKS, INGREDIENTS, MAX_COMBO, ROUND_TICKS, TICKS_PER_SECOND, type Ingredient } from "./config.ts";

export interface FeedCommand { tick: number; ingredient: Ingredient }
export interface RunState {
  tick: number;
  rngState: number;
  phase: "playing" | "survived" | "lost";
  wanted: Ingredient;
  hunger: number;
  rage: number;
  score: number;
  combo: number;
  totalFeeds: number;
  correctFeeds: number;
  mutationEvents: number;
  servings: Record<Ingredient, number>;
  lastFeedTick: number;
  mutation: Ingredient | null;
  mutationUntilTick: number;
  announcement: string;
}

// Deterministic integer PRNG for the scaffold kernel. Not cryptographic randomness.
function nextRandom(state: number) {
  let value = state | 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

export function createRun(seed: number): RunState {
  const rngState = nextRandom((seed >>> 0) || 1);
  return {
    tick: 0, rngState, phase: "playing", wanted: INGREDIENTS[rngState % 3],
    hunger: 70, rage: 0, score: 0, combo: 0, totalFeeds: 0, correctFeeds: 0,
    mutationEvents: 0, servings: { metal: 0, balloon: 0, pepper: 0 },
    lastFeedTick: -FEED_COOLDOWN_TICKS, mutation: null, mutationUntilTick: 0,
    announcement: "Match the craving. Feed with Space or the button.",
  };
}

/** Mutates an owned run. Presentation and network code must never be called here. */
export function advanceTo(state: RunState, targetTick: number) {
  if (!Number.isSafeInteger(targetTick) || targetTick < state.tick || targetTick > ROUND_TICKS) {
    throw new Error("Invalid simulation tick");
  }
  while (state.tick < targetTick && state.phase === "playing") {
    state.tick += 1;
    if (state.tick % TICKS_PER_SECOND === 0) state.hunger = Math.max(0, state.hunger - 1);
    if (state.mutation && state.tick >= state.mutationUntilTick) state.mutation = null;
    if (state.hunger === 0 || state.rage >= 100) {
      state.phase = "lost";
      state.announcement = state.hunger === 0 ? "It ate the shift supervisor." : "It has a complaint about the menu.";
    } else if (state.tick === ROUND_TICKS) {
      state.phase = "survived";
      state.announcement = "Shift complete. It would like to speak to dinner.";
    }
  }
}

export function feed(state: RunState, ingredient: Ingredient): boolean {
  if (!INGREDIENTS.includes(ingredient)) throw new Error("Unknown ingredient");
  if (state.phase !== "playing" || state.tick - state.lastFeedTick < FEED_COOLDOWN_TICKS) return false;
  state.lastFeedTick = state.tick;
  state.totalFeeds += 1;
  if (ingredient !== state.wanted) {
    state.combo = 0;
    state.rage = Math.min(100, state.rage + 18);
    state.announcement = "Wrong snack. That look is directed at you.";
    if (state.rage === 100) state.phase = "lost";
    return true;
  }
  state.correctFeeds += 1;
  state.servings[ingredient] += 1;
  state.combo = Math.min(MAX_COMBO, state.combo + 1);
  state.score += BASE_FEED_SCORE * state.combo;
  state.hunger = Math.min(100, state.hunger + 12);
  state.rage = Math.max(0, state.rage - 4);
  state.announcement = "Good snack. Questionable judgement.";
  if (state.servings[ingredient] % 3 === 0) {
    state.mutation = ingredient;
    state.mutationUntilTick = state.tick + 8 * TICKS_PER_SECOND;
    state.mutationEvents += 1;
    state.announcement = "Mutation detected. The kitchen will remember this.";
  }
  state.rngState = nextRandom(state.rngState);
  state.wanted = INGREDIENTS[state.rngState % 3];
  return true;
}

/** Local replay of the scaffold rules only; not a production score verifier. */
export function replay(seed: number, commands: readonly FeedCommand[], endTick: number): RunState {
  if (commands.length > ROUND_TICKS) throw new Error("Too many commands");
  if (!Number.isSafeInteger(endTick) || endTick < 0 || endTick > ROUND_TICKS) throw new Error("Invalid end tick");
  const state = createRun(seed);
  let previousTick = -1;
  for (const command of commands) {
    if (!Number.isSafeInteger(command.tick) || command.tick < previousTick || command.tick > endTick) throw new Error("Invalid command order");
    previousTick = command.tick;
    advanceTo(state, command.tick);
    feed(state, command.ingredient);
  }
  advanceTo(state, endTick);
  return state;
}
