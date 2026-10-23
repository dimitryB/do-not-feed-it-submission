/** Provisional scaffold tuning. Change with the design record, then update replay fixtures. */
export const GAME_VERSION_LABEL = "do-not-feed-it-scaffold-v0";
export const TICKS_PER_SECOND = 60;
export const ROUND_SECONDS = 120;
export const ROUND_TICKS = ROUND_SECONDS * TICKS_PER_SECOND;
export const FEED_COOLDOWN_TICKS = 15;
export const MAX_COMBO = 5;
export const BASE_FEED_SCORE = 100;
export const INGREDIENTS = ["metal", "balloon", "pepper"] as const;
export type Ingredient = (typeof INGREDIENTS)[number];
export const INGREDIENT_LABELS: Record<Ingredient, string> = {
  metal: "Metal", balloon: "Balloon", pepper: "Pepper",
};
export const MUTATION_LABELS: Record<Ingredient, string> = {
  metal: "Magnetic teeth", balloon: "Balloon belly", pepper: "Pressure burp",
};
