/**
 * Builds the creature rig out of the existing painting.
 *
 * Nothing here generates new art. Parts are either cut from `kitchen.png`
 * (pupils, tongue, a fang, two bands of eyelid skin) or removed from it and
 * the gap filled in from the surrounding skin (the open mouth, the painted
 * pupils). The filled version is baked back into the working copy of the
 * picture, so the renderer warps one image and draws the authored mouth and
 * eyes on top of it.
 *
 * Built once, lazily, on the first frame after the art decodes.
 */
import {
  ANTENNAE, ANTENNA_BULB, ANTENNA_WIDTH, ARENA_HEIGHT, ARENA_WIDTH, BODY_OUTLINE, CHIN_SOURCE, EYE, EYE_SIDES, HI,
  MOUTH_OUTLINE, MOUTH_PATCH, SILHOUETTE, TONGUE, type EyeSide,
} from "./anatomy";
import { paintBlurred } from "../canvasBlur";

export interface Patch {
  canvas: HTMLCanvasElement;
  /** Placement rectangle in arena space. */
  x: number; y: number; width: number; height: number;
}

export interface CreatureRig {
  /** The painting at twice arena resolution, muzzle and pupils removed. */
  art: HTMLCanvasElement;
  /**
   * The kitchen without the creature, at arena resolution.
   *
   * The creature is drawn as its own clipped layer now, scaled and moved by
   * the rules' mouth, and wherever it moves away from where it was painted the
   * picture underneath has to be a wall and not a second creature. The hole is
   * filled from its surroundings; it is only ever seen in slivers.
   */
  backdrop: HTMLCanvasElement;
  pupil: Record<EyeSide, Patch>;
  lidUpper: Record<EyeSide, Patch>;
  lidLower: Record<EyeSide, Patch>;
  tongue: Patch;
  tooth: Patch;
  /** The same tooth in chrome, cross-faded in when the jaw is magnetised. */
  steelTooth: Patch;
  /** Brow skin, translated down to make a lid that is made of the creature. */
  lidSkin: Record<EyeSide, Patch>;
  /** Soft creature silhouette, low resolution, for colour grading only. */
  bodyMask: HTMLCanvasElement;
  /**
   * Scratch surface for grading, so a tint can be masked to the creature.
   *
   * A third of arena size on purpose. Everything drawn through it is a soft
   * radial falloff, so the resolution buys nothing visible, and there can be
   * four or five passes in a frame — each one a clear, a fill and a mask
   * composite over every pixel of this surface.
   */
  grade: HTMLCanvasElement;
  palette: {
    skinLit: string; skinMid: string; skinShadow: string;
    lipRim: string; lipShade: string; cavity: string; cavityDeep: string;
    tongue: string; toothIvory: string; scleraWarm: string;
  };
}

function canvasOf(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function contextOf(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D context unavailable");
  return context;
}

/** The painted mouth's outline, in the coordinates of a patch canvas. */
function mouthPath(context: CanvasRenderingContext2D, originX: number, originY: number) {
  context.beginPath();
  MOUTH_OUTLINE.forEach(([x, y], index) => {
    const px = (x - originX) * HI;
    const py = (y - originY) * HI;
    if (index) context.lineTo(px, py); else context.moveTo(px, py);
  });
  context.closePath();
}

/**
 * Fills transparent pixels from their surroundings with a pull-push pyramid:
 * repeated halving smears neighbouring colour across the gap, and compositing
 * the coarse levels back underneath fills it without a visible edge.
 */
function pullPushFill(canvas: HTMLCanvasElement, fallback: string) {
  const levels: HTMLCanvasElement[] = [canvas];
  let current = canvas;
  while (current.width > 3 && current.height > 3) {
    const next = canvasOf(Math.max(1, current.width >> 1), Math.max(1, current.height >> 1));
    const context = contextOf(next);
    context.imageSmoothingQuality = "high";
    context.drawImage(current, 0, 0, next.width, next.height);
    levels.push(next);
    current = next;
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let index = levels.length - 1; index > 0; index--) {
      const target = levels[index - 1];
      const context = contextOf(target);
      context.save();
      context.globalCompositeOperation = "destination-over";
      context.imageSmoothingQuality = "high";
      context.drawImage(levels[index], 0, 0, target.width, target.height);
      context.restore();
    }
  }
  const context = contextOf(canvas);
  context.save();
  context.globalCompositeOperation = "destination-over";
  context.fillStyle = fallback;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.restore();
}

function sample(context: CanvasRenderingContext2D, x: number, y: number, radius = 3) {
  const size = radius * 2 + 1;
  const data = context.getImageData(Math.round(x - radius), Math.round(y - radius), size, size).data;
  let r = 0, g = 0, b = 0;
  for (let index = 0; index < data.length; index += 4) { r += data[index]; g += data[index + 1]; b += data[index + 2]; }
  const count = data.length / 4;
  return `rgb(${Math.round(r / count)},${Math.round(g / count)},${Math.round(b / count)})`;
}

/** Cuts a soft-edged ellipse out of the painting. */
function cutEllipse(source: HTMLCanvasElement, x: number, y: number, rx: number, ry: number, feather: number): Patch {
  const patch = canvasOf(rx * 2 * HI, ry * 2 * HI);
  const context = contextOf(patch);
  context.drawImage(source, (x - rx) * HI, (y - ry) * HI, rx * 2 * HI, ry * 2 * HI, 0, 0, patch.width, patch.height);
  const mask = canvasOf(patch.width, patch.height);
  const maskContext = contextOf(mask);
  maskContext.save();
  maskContext.translate(patch.width / 2, patch.height / 2);
  maskContext.scale(1, patch.height / patch.width);
  // The gradient is built after the transform, in the same space it is filled
  // in; building it before would centre the soft disc on a corner.
  const gradient = maskContext.createRadialGradient(0, 0, 0, 0, 0, patch.width / 2);
  gradient.addColorStop(Math.max(0, 1 - feather), "#fff");
  gradient.addColorStop(1, "#fff0");
  maskContext.fillStyle = gradient;
  maskContext.fillRect(-patch.width / 2, -patch.width / 2, patch.width, patch.width);
  maskContext.restore();
  context.globalCompositeOperation = "destination-in";
  context.drawImage(mask, 0, 0);
  context.globalCompositeOperation = "source-over";
  return { canvas: patch, x: x - rx, y: y - ry, width: rx * 2, height: ry * 2 };
}

/**
 * One tooth, built to the painting's own ivory.
 *
 * The painted fangs are small, low-contrast and half in shadow, so a cut of one
 * cannot be scaled up into a whole jaw. This paints a cone in the sampled
 * palette instead and rubs a little of the real tooth over it for grain.
 */
/**
 * The same tooth in chrome.
 *
 * Desaturating the ivory one toward steel was not enough: measured, the tinted
 * teeth came out at rgb(206,218,213) — genuinely cool and genuinely grey — and
 * reviewers still called them bone-white, because what makes a surface read as
 * metal at stream resolution is not its hue but its *contrast*. Polished metal
 * is mostly dark with a few hard bright bands. So this is a separate sprite the
 * renderer cross-fades to, rather than a tint over the ivory one.
 */
function buildSteelTooth(shape: Patch): Patch {
  const patch = canvasOf(shape.canvas.width, shape.canvas.height);
  const context = contextOf(patch);
  context.drawImage(shape.canvas, 0, 0);
  context.globalCompositeOperation = "source-in";
  const w = patch.width;
  const h = patch.height;
  const chrome = context.createLinearGradient(0, 0, w, h * 0.85);
  chrome.addColorStop(0, "#0e1519");
  chrome.addColorStop(0.18, "#5d6f7b");
  chrome.addColorStop(0.3, "#e8f4fa");
  chrome.addColorStop(0.42, "#7b8d99");
  chrome.addColorStop(0.6, "#1b262c");
  chrome.addColorStop(0.78, "#9fb2bd");
  chrome.addColorStop(1, "#38454e");
  context.fillStyle = chrome;
  context.fillRect(0, 0, w, h);
  // A hard specular running down the length, which is the thing that says metal.
  context.globalCompositeOperation = "source-atop";
  const spec = context.createLinearGradient(w * 0.3, 0, w * 0.52, 0);
  spec.addColorStop(0, "rgba(255,255,255,0)");
  spec.addColorStop(0.5, "rgba(255,255,255,0.85)");
  spec.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = spec;
  context.fillRect(0, 0, w, h);
  context.globalCompositeOperation = "source-over";
  return { ...shape, canvas: patch };
}

/**
 * A slab of the creature's own brow skin, for the eyelids.
 *
 * The lids were a painted fill for several iterations, and reviewers kept
 * describing them the same way: a flat pale plate laid on the eyeball. They
 * were right — no gradient reproduces skin that is bumpy, mottled and lit from
 * a specific direction.
 *
 * The first attempt at using real skin failed because it stretched a thin band
 * to whatever height the lid needed, which tears the texture. This takes a tall
 * slab from well above the eye and only ever *translates* it down, so the grain
 * stays the size it was painted at whatever the lid is doing.
 */
function buildLidSkin(art: HTMLCanvasElement, side: EyeSide): Patch {
  const eye = EYE[side];
  const width = eye.rx * 2 + 30;
  const height = eye.ry * 4;
  const x = eye.x - width / 2;
  const y = eye.y - eye.ry - height;
  const patch = canvasOf(width * HI, height * HI);
  const context = contextOf(patch);
  context.drawImage(art, x * HI, y * HI, width * HI, height * HI, 0, 0, patch.width, patch.height);
  return { canvas: patch, x, y, width, height };
}

function buildTooth(art: HTMLCanvasElement): Patch {
  const width = 30;
  const height = 56;
  const patch = canvasOf(width * HI, height * HI);
  const context = contextOf(patch);
  context.scale(HI, HI);

  context.beginPath();
  context.moveTo(1.5, 0);
  context.lineTo(width - 1.5, 0);
  context.bezierCurveTo(width - 2.5, height * 0.42, width * 0.76, height * 0.86, width / 2, height);
  context.bezierCurveTo(width * 0.24, height * 0.86, 2.5, height * 0.42, 1.5, 0);
  context.closePath();
  context.save();
  context.clip();

  const body = context.createLinearGradient(2, 0, width - 2, height * 0.8);
  // Deliberately not white. Ivory this bright in a kitchen lit by two amber
  // lamps reads as a flat graphic laid over the painting; the row has to sit in
  // the same light as the face around it.
  body.addColorStop(0, "#d9cca6");
  body.addColorStop(0.34, "#bfae84");
  body.addColorStop(0.72, "#8b7449");
  body.addColorStop(1, "#5e4c2c");
  context.fillStyle = body;
  context.fillRect(0, 0, width, height);

  // Root end sits in shadow under the lip; the tip catches the amber light.
  const depth = context.createLinearGradient(0, 0, 0, height);
  depth.addColorStop(0, "rgba(18,10,3,0.95)");
  depth.addColorStop(0.14, "rgba(30,20,7,0.55)");
  depth.addColorStop(0.3, "rgba(40,28,10,0.14)");
  depth.addColorStop(0.72, "rgba(255,222,150,0.1)");
  depth.addColorStop(1, "rgba(255,236,186,0.24)");
  context.fillStyle = depth;
  context.fillRect(0, 0, width, height);

  context.globalAlpha = 0.28;
  context.globalCompositeOperation = "overlay";
  context.drawImage(art, 776 * HI, 194 * HI, 20 * HI, 22 * HI, 1, 2, width - 2, height - 4);
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 1;

  const shine = context.createLinearGradient(width * 0.28, 0, width * 0.46, height);
  shine.addColorStop(0, "rgba(252,240,206,0.36)");
  shine.addColorStop(0.55, "rgba(252,240,206,0.07)");
  shine.addColorStop(1, "rgba(255,250,228,0)");
  context.fillStyle = shine;
  context.fillRect(0, 0, width * 0.55, height);
  context.restore();

  // A cold edge down one side reads as a hard surface at any size.
  context.strokeStyle = "rgba(226,240,236,0.55)";
  context.lineWidth = 1.1;
  context.beginPath();
  context.moveTo(width - 2, height * 0.06);
  context.bezierCurveTo(width - 3, height * 0.42, width * 0.76, height * 0.86, width / 2, height - 0.5);
  context.stroke();
  return { canvas: patch, x: 0, y: 0, width, height };
}

/** Fraction of an eyelid band that stays fully opaque before it feathers. */
export const LID_SOLID = 0.84;

/** A band of real skin, feathered on one edge, used as a moving eyelid. */
function cutSkinBand(source: HTMLCanvasElement, rect: { x: number; y: number; width: number; height: number },
                     fadeFrom: "top" | "bottom"): Patch {
  const patch = canvasOf(rect.width * HI, rect.height * HI);
  const context = contextOf(patch);
  context.drawImage(source, rect.x * HI, rect.y * HI, rect.width * HI, rect.height * HI, 0, 0, patch.width, patch.height);
  const fade = context.createLinearGradient(0, 0, 0, patch.height);
  // Opaque for most of the band and feathered only at the very end: a long
  // fade leaves a half-transparent veil over whatever the lid is covering.
  if (fadeFrom === "bottom") {
    fade.addColorStop(0, "#fff");
    fade.addColorStop(LID_SOLID, "#fff");
    fade.addColorStop(1, "#fff0");
  } else {
    fade.addColorStop(0, "#fff0");
    fade.addColorStop(1 - LID_SOLID, "#fff");
    fade.addColorStop(1, "#fff");
  }
  context.globalCompositeOperation = "destination-in";
  context.fillStyle = fade;
  context.fillRect(0, 0, patch.width, patch.height);
  context.globalCompositeOperation = "source-over";
  return { canvas: patch, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * Rebuilds the muzzle as closed skin.
 *
 * The mouth is cut out along its traced outline and replaced with the
 * creature's own chin skin, tiled and flipped so the wrinkles keep running the
 * right way, then relit with the painting's own top-down falloff. Real skin
 * beats an interpolated fill: it brings grain and wrinkles with it.
 */
function buildMouthSkin(art: HTMLCanvasElement, artContext: CanvasRenderingContext2D): Patch {
  const rect = MOUTH_PATCH;
  const patch = canvasOf(rect.width * HI, rect.height * HI);
  const context = contextOf(patch);
  context.drawImage(art, rect.x * HI, rect.y * HI, rect.width * HI, rect.height * HI, 0, 0, patch.width, patch.height);

  context.save();
  context.globalCompositeOperation = "destination-out";
  paintBlurred(context, 9, { x: 0, y: 0, width: patch.width, height: patch.height }, (layer) => {
    layer.lineJoin = "round";
    layer.lineWidth = 5 * HI;
    layer.strokeStyle = "#000";
    layer.fillStyle = "#000";
    mouthPath(layer, rect.x, rect.y);
    layer.fill();
    layer.stroke();
  });
  context.restore();

  // Rebuild with the creature's own chin, in two overlapping flipped bands.
  const fill = canvasOf(patch.width, patch.height);
  const fillContext = contextOf(fill);
  const bandHeight = 132;
  for (let index = 0; index < 3; index++) {
    const top = 150 + index * (bandHeight - 24);
    const strip = canvasOf(CHIN_SOURCE.width * HI, bandHeight * HI);
    const stripContext = contextOf(strip);
    stripContext.save();
    if (index % 2 === 1) {
      stripContext.translate(strip.width, strip.height);
      stripContext.scale(-1, -1);
    }
    const shift = index * 17;
    stripContext.drawImage(art, (CHIN_SOURCE.x + shift) * HI, CHIN_SOURCE.y * HI,
      (CHIN_SOURCE.width - shift) * HI, CHIN_SOURCE.height * HI, 0, 0, strip.width, strip.height);
    stripContext.restore();
    const fade = stripContext.createLinearGradient(0, 0, 0, strip.height);
    fade.addColorStop(0, index === 0 ? "#fff" : "#fff0");
    fade.addColorStop(0.22, "#fff");
    fade.addColorStop(0.8, "#fff");
    fade.addColorStop(1, index === 2 ? "#fff" : "#fff0");
    stripContext.globalCompositeOperation = "destination-in";
    stripContext.fillStyle = fade;
    stripContext.fillRect(0, 0, strip.width, strip.height);
    fillContext.drawImage(strip, (700 - rect.x) * HI, (top - rect.y) * HI, 300 * HI, bandHeight * HI);
  }
  context.save();
  context.globalCompositeOperation = "destination-over";
  context.drawImage(fill, 0, 0);
  context.restore();
  pullPushFill(patch, sample(artContext, 840 * HI, 402 * HI, 6));

  // Relight through a soft-edged mask of the same outline, so the rebuilt skin
  // fades into the painting instead of ending on a hard polygon edge.
  const light = canvasOf(patch.width, patch.height);
  const lightContext = contextOf(light);
  const shade = lightContext.createLinearGradient(0, (168 - rect.y) * HI, 0, (394 - rect.y) * HI);
  shade.addColorStop(0, "rgba(20,12,2,0.66)");
  shade.addColorStop(0.3, "rgba(44,30,6,0.34)");
  shade.addColorStop(0.66, "rgba(96,76,26,0.09)");
  shade.addColorStop(1, "rgba(176,142,58,0.09)");
  lightContext.fillStyle = shade;
  lightContext.fillRect(0, 0, light.width, light.height);
  const sideLight = lightContext.createLinearGradient((706 - rect.x) * HI, 0, (976 - rect.x) * HI, 0);
  sideLight.addColorStop(0, "rgba(12,22,18,0.26)");
  sideLight.addColorStop(0.45, "rgba(12,22,18,0.06)");
  sideLight.addColorStop(1, "rgba(224,164,72,0.14)");
  lightContext.fillStyle = sideLight;
  lightContext.fillRect(0, 0, light.width, light.height);
  lightContext.globalCompositeOperation = "destination-in";
  paintBlurred(lightContext, 30, { x: 0, y: 0, width: light.width, height: light.height }, (layer) => {
    layer.fillStyle = "#fff";
    mouthPath(layer, rect.x, rect.y);
    layer.fill();
  });
  context.drawImage(light, 0, 0);

  // The nose casts a shadow onto the muzzle; without it the rebuilt skin sits
  // too bright right under it.
  const noseShadow = context.createRadialGradient(
    (840 - rect.x) * HI, (184 - rect.y) * HI, 4,
    (840 - rect.x) * HI, (184 - rect.y) * HI, 96 * HI);
  noseShadow.addColorStop(0, "rgba(14,9,2,0.5)");
  noseShadow.addColorStop(0.45, "rgba(14,9,2,0.26)");
  noseShadow.addColorStop(1, "rgba(14,9,2,0)");
  context.save();
  context.translate((840 - rect.x) * HI, (184 - rect.y) * HI);
  context.scale(1, 0.34);
  context.translate(-(840 - rect.x) * HI, -(184 - rect.y) * HI);
  context.fillStyle = noseShadow;
  context.fillRect(0, 0, patch.width, patch.height / 0.34);
  context.restore();

  return { canvas: patch, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** The eye with the painted pupil filled in, so a new pupil can look around. */
function buildScleraPatch(art: HTMLCanvasElement, side: EyeSide): Patch {
  const eye = EYE[side];
  const pad = 9;
  const rect = { x: eye.x - eye.rx - pad, y: eye.y - eye.ry - pad, width: (eye.rx + pad) * 2, height: (eye.ry + pad) * 2 };
  const patch = canvasOf(rect.width * HI, rect.height * HI);
  const context = contextOf(patch);
  context.drawImage(art, rect.x * HI, rect.y * HI, rect.width * HI, rect.height * HI, 0, 0, patch.width, patch.height);
  context.save();
  context.globalCompositeOperation = "destination-out";
  paintBlurred(context, 3, { x: 0, y: 0, width: patch.width, height: patch.height }, (layer) => {
    layer.beginPath();
    layer.arc((eye.pupil.x - rect.x) * HI, (eye.pupil.y - rect.y) * HI, (eye.pupil.r + 2) * HI, 0, Math.PI * 2);
    layer.fillStyle = "#000";
    layer.fill();
  });
  context.restore();
  pullPushFill(patch, "rgb(196,146,26)");
  // Feather the patch to an ellipse before it goes back onto the painting: a
  // rectangular paste shows its own corners once anything else shifts.
  context.save();
  context.globalCompositeOperation = "destination-in";
  paintBlurred(context, 4, { x: 0, y: 0, width: patch.width, height: patch.height }, (layer) => {
    layer.fillStyle = "#fff";
    layer.beginPath();
    layer.ellipse((eye.x - rect.x) * HI, (eye.y - rect.y) * HI, (eye.rx + 4) * HI, (eye.ry + 4) * HI, 0, 0, Math.PI * 2);
    layer.fill();
  });
  context.restore();
  return { canvas: patch, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * Traces the creature's silhouette — body plus the three antennae — as one
 * path, in painting coordinates, on whatever context is given. Used both to
 * cut the hole in the backdrop and, every frame, as the clip the creature is
 * drawn through.
 */
export function silhouettePath(context: CanvasRenderingContext2D, scale = 1, grow = 0,
                               map?: (x: number, y: number) => { x: number; y: number }) {
  const at = (x: number, y: number) => (map ? map(x, y) : { x, y });
  context.beginPath();
  // Every subpath is wound the same way, so the overlaps where an antenna
  // meets the skull are inside under the nonzero rule rather than holes.
  const ring = (points: { x: number; y: number }[]) => {
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      area += a.x * b.y - b.x * a.y;
    }
    const ordered = area < 0 ? [...points].reverse() : points;
    ordered.forEach((p, index) => {
      if (index) context.lineTo(p.x * scale, p.y * scale); else context.moveTo(p.x * scale, p.y * scale);
    });
    context.closePath();
  };
  // The body polygon, pushed outward by `grow` along a crude normal: away from
  // the body's centre. Enough for a clip margin; nothing here is a true offset.
  const cx = 840, cy = 330;
  const body = SILHOUETTE.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    const d = Math.hypot(dx, dy) || 1;
    return at(x + dx / d * grow, y + dy / d * grow);
  });
  body.push(at(SILHOUETTE[SILHOUETTE.length - 1][0] + grow, 560));
  body.push(at(SILHOUETTE[0][0] - grow, 560));
  ring(body);
  // Antennae as thick polylines turned into polygons: left side forward, right
  // side back.
  const half = ANTENNA_WIDTH / 2 + grow;
  for (const line of ANTENNAE) {
    const left: { x: number; y: number }[] = [];
    const right: { x: number; y: number }[] = [];
    for (let i = 0; i < line.length; i++) {
      const [x, y] = line[i];
      const [px, py] = line[Math.max(0, i - 1)];
      const [nx, ny] = line[Math.min(line.length - 1, i + 1)];
      const tx = nx - px, ty = ny - py;
      const t = Math.hypot(tx, ty) || 1;
      const ox = -ty / t * half, oy = tx / t * half;
      left.push(at(x + ox, y + oy));
      right.push(at(x - ox, y - oy));
    }
    ring([...left, ...right.reverse()]);
  }
  const bulb: { x: number; y: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2;
    bulb.push(at(ANTENNA_BULB.x + Math.cos(a) * (ANTENNA_BULB.r + grow), ANTENNA_BULB.y + Math.sin(a) * (ANTENNA_BULB.r + grow)));
  }
  ring(bulb);
}

/** The painting with the creature taken out and the gap filled from around it. */
function buildBackdrop(image: HTMLImageElement): HTMLCanvasElement {
  const canvas = canvasOf(ARENA_WIDTH, ARENA_HEIGHT);
  const context = contextOf(canvas);
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  context.save();
  context.globalCompositeOperation = "destination-out";
  paintBlurred(context, 2, { x: 0, y: 0, width: canvas.width, height: canvas.height }, (layer) => {
    layer.fillStyle = "#000";
    silhouettePath(layer, 1, 8);
    layer.fill();
  });
  context.restore();
  pullPushFill(canvas, "rgb(22,34,32)");
  return canvas;
}

function buildBodyMask(): HTMLCanvasElement {
  const mask = canvasOf(ARENA_WIDTH / 4, ARENA_HEIGHT / 4);
  const context = contextOf(mask);
  context.save();
  context.scale(0.25, 0.25);
  paintBlurred(context, 15, { x: 0, y: 0, width: ARENA_WIDTH, height: ARENA_HEIGHT }, (layer) => {
    layer.fillStyle = "#fff";
    layer.beginPath();
    BODY_OUTLINE.forEach(([x, y], index) => (index ? layer.lineTo(x, y) : layer.moveTo(x, y)));
    layer.lineTo(BODY_OUTLINE[BODY_OUTLINE.length - 1][0], 520);
    layer.lineTo(BODY_OUTLINE[0][0], 520);
    layer.closePath();
    layer.fill();
  });
  context.restore();
  return mask;
}

export function buildRig(image: HTMLImageElement): CreatureRig {
  const art = canvasOf(ARENA_WIDTH * HI, ARENA_HEIGHT * HI);
  const artContext = art.getContext("2d", { willReadFrequently: true });
  if (!artContext) throw new Error("2D context unavailable");
  artContext.imageSmoothingQuality = "high";
  artContext.drawImage(image, 0, 0, art.width, art.height);

  const palette = {
    skinLit: sample(artContext, 900 * HI, 392 * HI, 5),
    skinMid: sample(artContext, 700 * HI, 300 * HI, 5),
    skinShadow: sample(artContext, 640 * HI, 330 * HI, 5),
    lipRim: sample(artContext, 840 * HI, 176 * HI, 3),
    lipShade: sample(artContext, 840 * HI, 386 * HI, 3),
    cavity: "rgb(46,16,14)",
    cavityDeep: "rgb(9,3,3)",
    tongue: sample(artContext, TONGUE.x * HI, TONGUE.y * HI, 4),
    toothIvory: sample(artContext, 786 * HI, 200 * HI, 2),
    scleraWarm: sample(artContext, 760 * HI, 150 * HI, 3),
  };

  // Cut every moving part from the untouched painting first.
  const lidSkin = {} as Record<EyeSide, Patch>;
  const pupil = {} as Record<EyeSide, Patch>;
  const lidUpper = {} as Record<EyeSide, Patch>;
  const lidLower = {} as Record<EyeSide, Patch>;
  for (const side of EYE_SIDES) {
    const eye = EYE[side];
    pupil[side] = cutEllipse(art, eye.pupil.x, eye.pupil.y, eye.pupil.r, eye.pupil.r, 0.18);
    lidSkin[side] = buildLidSkin(art, side);
    lidUpper[side] = cutSkinBand(art,
      { x: eye.x - eye.rx - 11, y: eye.y - eye.ry - 22, width: (eye.rx + 11) * 2, height: 28 }, "bottom");
    lidLower[side] = cutSkinBand(art,
      { x: eye.x - eye.rx - 11, y: eye.y + eye.ry - 6, width: (eye.rx + 11) * 2, height: 24 }, "top");
  }
  const tongue = cutEllipse(art, TONGUE.x, TONGUE.y, TONGUE.rx, TONGUE.ry, 0.32);
  const tooth = buildTooth(art);

  // Then bake the removals into the working copy the warp draws from.
  const mouthSkin = buildMouthSkin(art, artContext);
  const sclera = EYE_SIDES.map((side) => buildScleraPatch(art, side));
  artContext.drawImage(mouthSkin.canvas, mouthSkin.x * HI, mouthSkin.y * HI);
  for (const patch of sclera) artContext.drawImage(patch.canvas, patch.x * HI, patch.y * HI);

  return {
    art, backdrop: buildBackdrop(image), pupil, lidUpper, lidLower, lidSkin, tongue, tooth, steelTooth: buildSteelTooth(tooth),
    bodyMask: buildBodyMask(), grade: canvasOf(ARENA_WIDTH / 5, ARENA_HEIGHT / 5), palette,
  };
}
