/**
 * The caption slot's width in scene pixels. A line wider than this at its
 * nominal size (text plus 16 px, or plus 56 for a boxed card) is drawn at the
 * largest size that fits, so a long label never runs off the slot.
 */
export const CAPTION_SLOT_WIDTH = 600;

/** Horizontal padding the renderer adds around a caption's text: a boxed card has its box. */
export const captionPadding = (card: boolean) => (card ? 56 : 16);

/**
 * The size a caption is drawn at: its own, or the largest that fits the slot
 * when `width` — the text measured at `size` — would overflow it.
 */
export function fitCaptionSize(size: number, width: number, card: boolean): number {
  const room = CAPTION_SLOT_WIDTH - captionPadding(card);
  return width <= room ? size : Math.floor((size * room) / width);
}
