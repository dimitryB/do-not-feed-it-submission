/**
 * The community diet: what everyone, together, has been feeding it this week.
 *
 * A stub. The chain layer will fill this from the registry later; for now it
 * is `null`, and the title screen says nothing. Shares are fractions of all
 * servings over the window and should sum to about 1. Nothing here touches
 * the rules, the trace or the chain.
 */
export interface CommunityDiet {
  /** Fraction of servings that were Bitcoin, Ether and HEMI. */
  btc: number; eth: number; hemi: number;
  /** The window the shares cover, as a label ("this week"). */
  window: string;
}

export const communityDiet: CommunityDiet | null = null;

const NAMES: Record<keyof Omit<CommunityDiet, 'window'>, string> = { btc: 'BTC', eth: 'ETH', hemi: 'HEMI' };

/**
 * The one line under the title legend: "The community fed it 61% BTC this
 * week." Names the largest share; returns null for a null diet or one with
 * no servings in it.
 */
export function communityDietLine(diet: CommunityDiet | null): string | null {
  if (!diet) return null;
  const entries = (['btc', 'eth', 'hemi'] as const).map((k) => [k, Number.isFinite(diet[k]) ? Math.max(0, diet[k]) : 0] as const);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (total <= 0) return null;
  const [top, share] = entries.reduce((best, item) => (item[1] > best[1] ? item : best));
  return `The community fed it ${Math.round((share / total) * 100)}% ${NAMES[top]} ${diet.window}.`;
}
