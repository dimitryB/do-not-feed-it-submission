/**
 * Development-only pose presets for the creature review harness.
 *
 * Each preset builds a synthetic `ArcadeState` — the same shape live play
 * produces — so the renderer is exercised through its real inputs. Nothing
 * here runs in production, and nothing here is used to produce a score or a
 * replay trace. `t` is seconds since the moment that defines the state, so a
 * caller can walk a preset forward to capture a motion strip.
 */
import { ARENA, createArcade, type ArcadeEvent, type ArcadeState, type Ingredient } from "../game/arcade";
import type { DevPose } from "./hook";

export const CREATURE_STATE_IDS = [
  "attract-idle",
  "hungry-mild",
  "hungry-severe",
  "tracking-far",
  "tracking-near",
  "gulp-metal",
  "gulp-balloon",
  "gulp-pepper",
  "miss-floor",
  "miss-vent",
  "irritation-1",
  "irritation-2",
  "irritation-3",
  "warn-metal",
  "warn-balloon",
  "warn-pepper",
  "active-metal",
  "active-balloon",
  "active-pepper",
  "recovery",
  "craving-satisfied",
  "off-menu",
  "end-survived",
  "end-starved",
  "end-enraged",
] as const;

export type CreatureStateId = (typeof CREATURE_STATE_IDS)[number];

const MUTATION_LABELS: Record<Ingredient, string> = {
  metal: "MAGNET MOUTH ×1",
  balloon: "BALLOON BELLY ×1",
  pepper: "FIRE BREATH ×1",
};

let eventId = 1;

function add(state: ArcadeState, type: ArcadeEvent["type"], ageTicks: number, label: string,
             extra?: { x?: number; y?: number; ingredient?: Ingredient; craved?: boolean; name?: string; value?: number }) {
  state.events.push({
    id: eventId++,
    tick: Math.round(state.tick - ageTicks),
    type,
    x: extra?.x ?? ARENA.mouth.x,
    y: extra?.y ?? ARENA.mouth.y,
    label,
    ...(extra?.ingredient ? { ingredient: extra.ingredient } : {}),
    ...(extra?.craved === undefined ? {} : { craved: extra.craved }),
    ...(extra?.name === undefined ? {} : { name: extra.name }),
    ...(extra?.value === undefined ? {} : { value: extra.value }),
  });
}

function shot(state: ArcadeState, ingredient: Ingredient, x: number, y: number, vx: number, vy: number, age: number) {
  state.projectiles.push({
    id: state.nextProjectileId++, ingredient, x, y, vx, vy,
    kind: "food", age, bounces: 0, bank: 0, hitMask: 0, lastSurface: "", lastBank: "", hazardBounces: 0,
    assisted: false, cooked: false, spent: false,
  });
}

function base(tick: number): ArcadeState {
  const state = createArcade(7);
  state.tick = tick;
  state.lastLaunchTick = tick - ARENA.cooldownTicks;
  state.score = 4820;
  state.totalFeeds = 9;
  state.shots = 14;
  return state;
}

/** The moment before a catch or a miss: the snack is still in the air. */
function approach(state: ArcadeState, ingredient: Ingredient, seconds: number) {
  // 13.6 px per tick along the flight, arriving at the mouth at t = 0.
  const away = Math.min(0.9, seconds) * 60 * 11.4;
  shot(state, ingredient, ARENA.mouth.x - away, ARENA.mouth.y - away * 0.16, 11.4, 1.8, 40);
  add(state, "launch", 40, ingredient, { x: 264, y: 494, ingredient });
}

/**
 * Builds one forced presentation frame. `t` is seconds since the defining
 * moment, and may be negative: a strip needs the run-up as well as the beat.
 */
export function buildPose(id: CreatureStateId, t = 0): DevPose {
  const ticks = Math.round(Math.max(0, t) * 60);
  const before = t < 0 ? -t : 0;
  let playing = true;
  let selected: Ingredient = "metal";
  let angle: number = ARENA.defaultAngle;
  const state = base(720 + ticks);

  switch (id) {
    case "attract-idle": {
      playing = false;
      state.tick = ticks;
      state.hunger = 78;
      break;
    }
    case "hungry-mild": {
      state.hunger = 44;
      break;
    }
    case "hungry-severe": {
      state.hunger = 7;
      break;
    }
    case "tracking-far": {
      selected = "balloon";
      angle = -46;
      shot(state, "balloon", 402, 372, 9.4, -3.1, 22);
      add(state, "launch", 22, "balloon", { x: 264, y: 494, ingredient: "balloon" });
      break;
    }
    case "tracking-near": {
      selected = "balloon";
      angle = -46;
      // On the mouth's centreline and close enough to be about to arrive. At
      // its old position the snack sat out on the cheek, which reads as a
      // sprite stuck to the face rather than as food in flight.
      shot(state, "balloon", 774, 291, 9.4, 0.4, 44);
      add(state, "launch", 44, "balloon", { x: 264, y: 494, ingredient: "balloon" });
      break;
    }
    case "gulp-metal":
    case "gulp-balloon":
    case "gulp-pepper": {
      const ingredient = id.slice(5) as Ingredient;
      selected = ingredient;
      state.tick = 720 + ticks;
      state.combo = 3;
      const points = { metal: 260, balloon: 180, pepper: 305 }[ingredient];
      if (before) approach(state, ingredient, before);
      else add(state, "feed", ticks, `NOM +${points}`, { x: 838, y: 286, ingredient, craved: false, value: points });
      break;
    }
    case "craving-satisfied": {
      state.tick = 720 + ticks;
      state.combo = 4;
      state.wanted = "balloon";
      selected = "balloon";
      if (before) approach(state, "balloon", before);
      else add(state, "feed", ticks, "CRAVING +410", { x: 838, y: 282, ingredient: "balloon", craved: true, value: 410 });
      break;
    }
    case "off-menu": {
      state.tick = 720 + ticks;
      state.combo = 1;
      state.wanted = "pepper";
      selected = "metal";
      if (before) approach(state, "metal", before);
      else add(state, "feed", ticks, "NOM +140", { x: 838, y: 282, ingredient: "metal", craved: false, value: 140 });
      break;
    }
    case "miss-floor": {
      selected = "pepper";
      state.misses = 4;
      state.rage = 28;
      if (before) {
        // A miss is on a losing line the whole way, not a catch that failed at
        // the last moment.
        const away = Math.min(0.9, before) * 60 * 11.4;
        shot(state, "pepper", ARENA.mouth.x - away, ARENA.mouth.y + 110 - away * 0.02, 11.4, 5.4, 46);
        add(state, "launch", 46, "pepper", { x: 264, y: 494, ingredient: "pepper" });
      } else add(state, "miss", ticks, "ON THE FLOOR", { x: 690, y: 612, ingredient: "pepper" });
      break;
    }
    case "miss-vent": {
      state.tick = 2600 + ticks;
      state.lastLaunchTick = state.tick - ARENA.cooldownTicks;
      selected = "metal";
      state.misses = 5;
      state.rage = 34;
      add(state, "bounce", ticks, "OFF THE VENT", { x: 620, y: 100, ingredient: "metal", name: "vent", value: 1 });
      break;
    }
    case "irritation-1": {
      state.rage = 30;
      state.misses = 4;
      break;
    }
    case "irritation-2": {
      state.rage = 62;
      state.misses = 9;
      break;
    }
    case "irritation-3": {
      state.rage = 93;
      state.misses = 14;
      break;
    }
    case "warn-metal":
    case "warn-balloon":
    case "warn-pepper": {
      // A mutation no longer has a warning phase — it is permanent and it
      // lands with the third serving — so these states are now "one level in",
      // which is the pose a player sees for most of a shift.
      const ingredient = id.slice(5) as Ingredient;
      selected = ingredient;
      state.servings[ingredient] = 3;
      state.mutations[ingredient] = 1;
      if (ingredient === "balloon") state.creature.lift = 12;
      state.announcement = MUTATION_LABELS[ingredient];
      add(state, "mutation", Math.max(0, ticks - 90), MUTATION_LABELS[ingredient], { ingredient });
      break;
    }
    case "active-metal":
    case "active-balloon": {
      const ingredient = id.slice(7) as Ingredient;
      selected = ingredient;
      state.servings[ingredient] = 9;
      state.mutations[ingredient] = 3;
      if (ingredient === "balloon") state.creature.lift = 36;
      state.announcement = MUTATION_LABELS[ingredient];
      add(state, "mutation", ticks + 30, MUTATION_LABELS[ingredient], { ingredient });
      break;
    }
    case "active-pepper": {
      selected = "pepper";
      state.servings.pepper = 9;
      state.mutations.pepper = 3;
      state.announcement = MUTATION_LABELS.pepper;
      // Mid-breath: the tell is over and the cone is out.
      state.flame = { tellUntil: state.tick - 6, until: state.tick + 40, angle: Math.PI * 0.87, length: 520 };
      state.threat = { kind: "flame", tick: state.tick - 6, x: ARENA.mouth.x, y: ARENA.mouth.y };
      add(state, "flame", 6, "FIRE BREATH", { ingredient: "pepper", name: "breath", value: 50 });
      break;
    }
    case "recovery": {
      selected = "pepper";
      state.servings.pepper = 3;
      state.mutations.metal = 2;
      add(state, "beat", ticks, "SNEEZE", { ingredient: "pepper", name: "sneeze" });
      break;
    }
    case "end-survived": {
      playing = false;
      state.tick = 9000;
      state.phase = "lost";
      state.failureReason = "outgrew-the-kitchen";
      state.hunger = 71;
      state.score = 12440;
      state.creature.size = 2.4;
      state.size = 2.4;
      state.announcement = "It no longer fits through the door. It has been promoted.";
      add(state, "end", ticks, state.announcement);
      break;
    }
    case "end-starved": {
      playing = false;
      state.phase = "lost";
      state.failureReason = "empty-belly";
      state.hunger = 0;
      state.announcement = "Empty belly. It has eaten the employee handbook.";
      add(state, "end", ticks, state.announcement);
      break;
    }
    case "end-enraged": {
      playing = false;
      state.phase = "lost";
      state.failureReason = "kitchen-destroyed";
      state.rage = 100;
      state.hunger = 38;
      state.announcement = "Too many missed shots. The kitchen has been politely destroyed.";
      add(state, "end", ticks, state.announcement);
      break;
    }
  }

  return { state, playing, angle, selected };
}
