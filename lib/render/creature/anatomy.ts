/**
 * Where the creature's features actually sit in the painting.
 *
 * Every number is in the 1200x700 arena space the renderer draws in, measured
 * off `public/art/kitchen.png`. The rig and the pose code both read from here,
 * so a landmark is corrected in one place.
 */

/** Source art is 1536x1024; the rig works at twice arena resolution. */
export const ART_WIDTH = 1536;
export const ART_HEIGHT = 1024;
export const ARENA_WIDTH = 1200;
export const ARENA_HEIGHT = 700;
export const HI = 2;

// The landmarks that decide where the mouth is are the rules' (the mouth is
// the target): one copy, in `lib/game/body.ts`.
export { BELLY, COUNTER_Y, HEAD, MOUTH } from "../../game/body";
export const NOSE = { x: 839, y: 150 };
/** Roughly where the jaw would hinge, behind the mouth corners. */
export const JAW_PIVOT = { x: 840, y: 250 };

export const EYE = {
  // Re-measured off the painting at 4x. The previous figures put the socket a
  // few pixels up and left of the painted eyeball and made it three pixels too
  // wide in every direction, so everything clipped to it — lids above all — sat
  // on the skin around the eye instead of on the eye. The pupil radius was out
  // by half again, which is why a dilated pupil filled the socket edge to edge
  // and read as a dark slot.
  left: { x: 769, y: 154, rx: 23, ry: 19, pupil: { x: 777, y: 156, r: 11 } },
  right: { x: 920, y: 158, rx: 25, ry: 19.5, pupil: { x: 909, y: 159, r: 11 } },
} as const;

export type EyeSide = keyof typeof EYE;
export const EYE_SIDES: readonly EyeSide[] = ["left", "right"];


/**
 * Outer boundary of everything painted as mouth: lips, teeth, tongue, cavity.
 * Traced off the painting; this whole region is rebuilt as skin.
 */
export const MOUTH_OUTLINE: readonly (readonly [number, number])[] = [
  [712, 214], [732, 192], [770, 182], [816, 179], [864, 181], [910, 187],
  [946, 200], [970, 226], [968, 268], [952, 318], [918, 354], [872, 376],
  [828, 380], [788, 370], [750, 346], [726, 306], [714, 258],
];

/** Region rebuilt as skin so the authored mouth is the only mouth on the face. */
export const MOUTH_PATCH = { x: 672, y: 132, width: 340, height: 292 };

/** Clean skin below the mouth, the source for the rebuilt muzzle. */
export const CHIN_SOURCE = { x: 730, y: 384, width: 220, height: 54 };

/**
 * The patch the tongue's texture is cut from.
 *
 * The previous ellipse (833, 313, 53x25) was traced around the *whole* painted
 * tongue, which meant its lower rim crossed three of the painted lower teeth and
 * its top-right caught the dark cavity behind them. Those ivory tips came along
 * inside the sprite and then travelled with it, so a pale nub rode the tongue's
 * right edge no matter what the tooth-drawing code did — the fix had to be the
 * cut, not the draw. This smaller ellipse sits entirely on flesh: no ivory, no
 * cavity, midline groove centred. It is stretched to the drawn tongue's size, so
 * being smaller than the painted tongue costs nothing.
 */
export const TONGUE = { x: 815, y: 308, rx: 40, ry: 16 };

/**
 * The creature's silhouette, traced tightly off the painting at 4x.
 *
 * `BODY_OUTLINE` below is a loose hull and was never meant for cutting. This
 * one is: it is the clip the body scale draws through, so it runs a few pixels
 * outside the painted edge and nowhere inside it. The antennae are thin and are
 * listed separately as centre-lines with a width.
 */
export const SILHOUETTE: readonly (readonly [number, number])[] = [
  [565, 476], [557, 450], [550, 425], [552, 400], [559, 375], [570, 350], [585, 325], [602, 300],
  [615, 275], [628, 250], [645, 225], [660, 200], [688, 183], [705, 175], [722, 160], [735, 150],
  [747, 125], [760, 113], [780, 104], [800, 100], [820, 100], [850, 101], [880, 100], [900, 103],
  [920, 110], [937, 122], [952, 136], [975, 150], [990, 160], [1005, 175], [1022, 200], [1035, 225],
  [1048, 250], [1062, 275], [1075, 300], [1090, 325], [1102, 350], [1110, 375], [1121, 400],
  [1126, 425], [1124, 450], [1118, 476],
];
/** Antenna centre-lines, each drawn as a stroke of `ANTENNA_WIDTH`. */
export const ANTENNAE: readonly (readonly (readonly [number, number])[])[] = [
  [[818, 118], [808, 104], [798, 92], [788, 80], [778, 72], [769, 74], [764, 82], [766, 90]],
  [[855, 114], [858, 100], [862, 88], [866, 80], [868, 76]],
  [[892, 114], [900, 102], [912, 91], [926, 82], [940, 82], [950, 90], [949, 100], [944, 104]],
];
export const ANTENNA_WIDTH = 15;
export const ANTENNA_BULB = { x: 868, y: 76, r: 10 };
/**
 * The top of the serving sill. The painting below this line is drawn over the
 * creature, so a creature that has grown past the counter sinks behind it
 * rather than standing on it.
 */
export const SILL_Y = 466;

/** Soft silhouette used only for colour grading, never for cutting. */
export const BODY_OUTLINE: readonly (readonly [number, number])[] = [
  [545, 486], [551, 424], [566, 366], [588, 310], [612, 268], [640, 232],
  [668, 208], [700, 184], [730, 156], [756, 130], [774, 110], [790, 92],
  [806, 82], [822, 86], [834, 96], [846, 80], [860, 82], [874, 96],
  [888, 78], [904, 78], [918, 90], [928, 108], [946, 120], [968, 138],
  [990, 158], [1010, 182], [1026, 212], [1038, 246], [1048, 288],
  [1058, 336], [1068, 388], [1074, 434], [1078, 486],
];
