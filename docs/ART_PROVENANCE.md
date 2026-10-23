# Do Not Feed It original artwork

Generated 2026-09-09 using the built-in OpenAI image_gen tool, without reference images. Two separate original generations, run in parallel. No third-party source assets, logos, real-person likenesses, or fonts were supplied.

## Files
- kitchen-creature.png — 1536 × 1024. Inspected: cinematic dark teal/amber industrial feeding kitchen, original moss-green alien, clear left space. The actual mouth center is approximately x70%, y39% with opening about 20% width × 20% height; gameplay target should align to the actual art rather than the requested coordinates.
- ingredient-sheet.png — 2172 × 724. Inspected: tin, mint pouch, coral chili, each occupying one equal third, clean separated silhouettes. Dark background appears slightly textured rather than guaranteed uniform #101b1c; use as a dark-backed sheet or extract with appropriate tools if transparency is needed.

## Exact prompts

### Kitchen
Use case: stylized-concept. Asset type: original cinematic environment art for browser arcade game Do Not Feed It. Create a wide landscape image, 1536x1024. Dark cinematic industrial subterranean feeding kitchen. Painterly high-end stylized 3D game concept art with tactile craftsmanship. Teal-black machinery, aged enamel metal, warm amber practical lighting, subtle drifting steam. Side-on gameplay composition: left 45 percent of frame is clear dark negative space for flying food, restrained wall texture only. On the right at 70 percent width a huge irresistibly expressive plump moss-green ORIGINAL alien creature behind a serving hatch. Wide open black mouth centered x70% y47%, mouth opening approximately 14% image width and 18% image height, ivory irregular teeth, soulful yellow eyes, amusing expectant expression. Its entire upper body visible, strong silhouette. Warm orange light on right and cool teal on left. Foreground workbench across lower 15 percent. Exceptionally polished distinctive premium game atmosphere, a lovable hungry monster with beautifully modeled wet nose and subtly leathery skin. No text, HUD, logos, numbers, humans, watermarks or unnecessary visual clutter. This is artwork only, not a UI screenshot.

### Ingredients
Use case: stylized-concept. Asset type: game food item sprite sheet for Do Not Feed It. Wide 3:1 horizontal image, three separated items each centered in its equal third with generous separation and margins. All on perfectly flat solid dark #101b1c background, no gradients or environmental shadows outside items. Left third: battered silver tin can with a small blank lime label, slightly tilted. Middle third: mint/cyan inflated food pouch with a knot at top, tactile wrinkled flexible packaging. Right third: glossy coral red chili pepper with green stem, gently curved. Beautiful tactile stylized 3D hand-painted game inventory art, dramatic soft lighting, consistent original art direction with a dark industrial kitchen and a moss-green monster. Objects large, detailed, immediately recognizable readable silhouettes, each entirely inside its third. No words, logos, labels containing writing, other items, text, borders or watermark.
# Launcher artwork

Generated 2026-09-09 using built-in OpenAI image_gen. One original generation, no reference images.

Inspected: right-facing horizontal dark teal and brushed metal food cannon, copper bolts, pale lime stripe. No base, text or logos. Asset has a slight three-quarter view of the muzzle rather than strictly orthographic side-on. Actual silhouette occupies approximately x8–93%, y32–64%; backdrop is dark with subtle texture rather than guaranteed exact flat hex.

## Exact prompt
Use case: stylized-concept. Asset type: original game cannon barrel sprite for Do Not Feed It. Create one square 1024x1024 image. Side-view rotatable food-launching cannon barrel pointing EXACTLY RIGHT horizontally. View perfectly side-on as a 2D sprite, no perspective foreshortening. Isolated on perfectly flat solid dark #101b1c background. Polished hand-painted 3D stylized industrial kitchen equipment matching a dark teal and amber subterranean feeding kitchen. Dark desaturated teal enamel body, brushed metal barrel and muzzle, pale lime short safety stripe, copper bolts, subtle amber reflected light, rough worn tactile materials. Compact stout barrel silhouette. Barrel centered and fills image width from 15% to 85%, and height from 35% to 65%; muzzle at the right and breech at left. No pedestal or base. No text, logo, UI, hands, character, wheels, platform, environmental shadow, watermark or extra objects. Keep backdrop uniform and clean for sprite integration.

# Creature rig (September 9, 2026)

**No new image was generated.** The creature rig is built at runtime from the
existing `public/art/kitchen.png` by `lib/render/creature/rig.ts`, so there is
no new asset to license, no new prompt, and no risk of the art direction
drifting away from the painting.

What the rig does to that one file, once, on the first frame after it decodes:

- **Cuts** the two pupils and the tongue out of the painting with soft-edged
  masks. These are moved and scaled at draw time; the pixels are the painting's
  own. (Eyelids were originally cut the same way, from two bands of skin above
  and below each eye. A crop of real skin holds together only at the coverage it
  was cut at: at any other it stretches into a leaf-shaped sliver lying across
  the eyeball. The lids are now painted shapes in the skin colour sampled from
  the painting at (700, 300) and (640, 330), shaded with a rolled margin and a
  crease, and tinted arithmetically to follow whatever the skin is currently
  doing. No pixels are cut for them.)
- **Removes and rebuilds** the painted open mouth. Its outline was traced by
  hand off the picture (`MOUTH_OUTLINE` in `lib/render/creature/anatomy.ts`)
  and everything inside it — lips, teeth, tongue, cavity — is cut away and
  replaced with the creature's own chin skin (`CHIN_SOURCE`), tiled and flipped
  so the wrinkles keep running the right way, then relit through a soft-edged
  mask with the painting's own top-down falloff and a cast shadow under the
  nose. This is what lets the mouth close.
- **Removes and fills** each painted pupil the same way, so a new pupil can look
  around inside the sclera.
- **Paints one tooth** to the ivory sampled from the painting at (786, 200) in
  arena coordinates, with a little of the real tooth rubbed over it for grain.
  The painted fangs are small, low-contrast and half in shadow, so a cut of one
  cannot be scaled up into a whole jaw; every tooth in both rows is this sprite.

Everything else the creature does — head, jaw, belly, swallow, cheeks, antennae
— is a smooth displacement field applied to that same picture
(`lib/render/creature/warp.ts`). The creature is never cut out of the
background, so there is no silhouette edge that can tear.

The colours that are authored rather than sampled are the mouth cavity
(`rgb(46,16,14)` and `rgb(9,3,3)`), the tooth gradient, and the flush, pallor
and rage tints in `drawSkin` — all chosen against the painting's own palette,
and all applied through a soft silhouette mask derived from the same file so
they never end on a hard edge across the body.

Generator: none. Source file: `public/art/kitchen.png`, already recorded above.

# Token marks (October 12, 2026)

The three snacks became the three tokens. The marks are third-party brand
assets, used as delivered; nothing about them was generated here.

| file | what | source | licence / terms |
| --- | --- | --- | --- |
| `public/art/tokens/btc.svg` | the Bitcoin mark: orange coin, white ₿, 64 × 64 | Bitcoin logo, Wikimedia Commons (`Bitcoin.svg`) | public domain |
| `public/art/tokens/eth.svg` | the Ethereum mark: grey Ξ diamond, 256 × 417 | the ethereum.org mark, via Wikimedia Commons | ethereum.org brand assets, usable as the unmodified mark |
| `public/art/tokens/hemi.svg` / `hemi.png` | the HEMI token mark | Hemi brand kit | used as-is per the kit; Hemi asked that the logo not be modified in look and feel |

The HEMI mark landed on October 23, 2026: `public/art/tokens/hemi.svg` is
`hemi-logo-orange.svg` from the Hemi brand kit, byte for byte (one path, fill
`#FF4600`, 1000 × 1004). `lib/render/tokens.ts` loads it before `hemi.png`;
the stand-in (an orange disc with a white H in the display font) is drawn
only if the file fails to decode, and is not the brand mark.

## How the marks are used — the brand rule

All three marks are drawn **unmodified**: no recolouring, tinting, skewing,
horizontal "coin flip" squash, outline, drop shadow on the mark, or cropping.
What the game adds is *behind* or *around* the mark, never on it:

- **The plate.** Each coin is a disc in the game's palette drawn behind the
  mark (`drawPlate`). Bitcoin's own mark is a coin already, so its plate is a
  dark rim at 92 % coverage; Ether's grey Ξ sits at 64 % on a pale plate
  (grey on dark enamel vanished at 960 px); HEMI's sits at 72 % on dark
  enamel with an orange rim. The mark is scaled uniformly to that fraction of
  the plate's diameter on its longer axis and centred.
- **Motion.** A coin in flight is tilted toward its heading by at most ±15°
  (`MARK_TILT`), so it reads as thrown and is never upside down; the plate is
  a disc, so the tilt is the mark turning and nothing else. The spin is a
  glint that runs round the rim, outside the mark. A coin on the floor lies
  at 15°, face up, never squashed. The whole coin scales uniformly with the
  camera.
- **Effects.** The tail, the glow, the selection ring, the cooked ("turbo'd")
  ring, flame trails and the magnet arcs are all drawn around the coin.
- **The DOM.** Chips, legend, control deck and the title strip use the same
  SVG files as `<img>` elements inside a round plate (`.item-art`), at natural
  aspect with `object-fit: contain`; no blend mode, no filter.
- **Cost.** The marks are decoded once and rasterised with their plate into
  three offscreen bitmaps (56, 112 and 224 device px); every draw picks the
  smallest bitmap at or above the size it needs. Nothing is rasterised per
  frame.

`public/art/ingredients.png` (the tin, pouch and pepper sheet above) is no
longer drawn anywhere and is not part of the published game; it is kept in
the development repository as the record of the earlier art.

# The flying car (October 21, 2026)

**No image was generated.** The car that crosses the back room
(`lib/render/flyingCar.ts`, drawn by `drawFlyingCar` in `lib/render/scene.ts`)
is canvas paths written for this game: a generic rounded sedan with a tail fin,
two wheels, a headlight, a tail light and two jet flames, in the painting's
teal and lamplight. It copies no real car, vehicle design or film prop, and it
carries no mark, plate or lettering (D122). It is drawn on `kitchen.png`'s
back room and clipped to it, so the painting's lamps and chain stay in front.

# The social card and the icon (October 23, 2026)

`public/og.jpg` (1200 × 630) is the link preview for Discord, X and the rest:
`public/art/kitchen.png` scaled and cropped so the creature sits right of
centre, darkened on the left, with the title in the game's two lines (DO NOT /
FEED IT., the accent on IT.), the title screen's lede and a footer line. The
title face is Anton (SIL Open Font License 1.1) standing in for the game's
Impact, which is a system font; only the rendered image ships. Generated by
`scripts/social-card.py` in the development repository. `app/layout.tsx`
declares it (Open Graph and Twitter `summary_large_image`) and resolves it
against `DNFI_SITE_URL`, set at build time.

`public/favicon.svg` and `public/apple-touch-icon.png` (180 × 180) are the
masthead's mark — a "!" tipped 12° inside a ring, accent `#dded92` on ink
`#0b1213` — drawn by hand for this project.
