/**
 * Draws the creature for a pose.
 *
 * Order: warped picture, then the muzzle rebuilt as skin, then the authored
 * mouth, then the eyes, then skin colour. Every part is placed through the
 * same displacement field, so nothing slides off the face when the body moves.
 */
import { DEV_HOOKS, rigParts } from "../../dev/hook";
import { ARENA_HEIGHT, ARENA_WIDTH, EYE, EYE_SIDES, HI, SILL_Y } from "./anatomy";
import { TUNING } from "../../game/arcade";
import { REST_MOUTH, apertureOf, bodyField, placeAperture, toArena, toPainting, type Aperture, type MouthShape } from "../../game/body";
import type { CreaturePose } from "./pose";
import { silhouettePath, type CreatureRig } from "./rig";
import { buildField, drawWarped, localTransform, placePoint, WARP_REGION, type WarpField } from "./warp";

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

const RGB = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/;

/**
 * A sampled skin colour, moved to wherever the creature's skin currently is.
 *
 * Skin grading is a composite over the painting, and the eyelids are painted
 * after it so that the wet eye underneath keeps its colour. That left the lids
 * the one part of a starving creature's face still in full health — two olive
 * discs on a drained grey head. They are the same skin, so they take the same
 * colour, arithmetically rather than by compositing.
 */
function skinTone(base: string, pose: CreaturePose) {
  const parts = RGB.exec(base);
  if (!parts) return base;
  let r = Number(parts[1]);
  let g = Number(parts[2]);
  let b = Number(parts[3]);
  if (pose.pallor > 0.02) {
    const grey = r * 0.36 + g * 0.52 + b * 0.12;
    const t = pose.pallor * 0.85;
    r = mix(r, grey * 0.9 + 16, t);
    g = mix(g, grey * 0.98 + 24, t);
    b = mix(b, grey * 0.86 + 40, t);
  }
  if (pose.flush > 0.02) {
    r = mix(r, 234, pose.flush * 0.62);
    g = mix(g, 98, pose.flush * 0.5);
    b = mix(b, 44, pose.flush * 0.5);
  }
  if (pose.rageFlush > 0.02) {
    r = mix(r, 182, pose.rageFlush * 0.62);
    g = mix(g, 44, pose.rageFlush * 0.55);
    b = mix(b, 48, pose.rageFlush * 0.55);
  }
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

/**
 * The mouth the rig last drew, in arena coordinates: its four control points.
 * Development only, read by the mouth capture harness to check the drawn
 * opening against the one the rules test projectiles against.
 */
export const lastMouth = { x: 0, y: 0, rx: 0, ry: 0, shape: null as MouthShape | null, ruled: false };

function aperturePath(context: CanvasRenderingContext2D, shape: Aperture, grow = 0) {
  context.beginPath();
  context.moveTo(shape.leftX - grow, shape.leftY);
  context.quadraticCurveTo(shape.centerX, shape.upperControl - grow * 1.9, shape.rightX + grow, shape.rightY);
  context.quadraticCurveTo(shape.centerX, shape.lowerControl + grow * 1.9, shape.leftX - grow, shape.leftY);
  context.closePath();
}

/** Point and tangent angle on one of the two lip curves. */
function onCurve(shape: Aperture, t: number, upper: boolean) {
  const x0 = upper ? shape.leftX : shape.rightX;
  const y0 = upper ? shape.leftY : shape.rightY;
  const x1 = upper ? shape.rightX : shape.leftX;
  const y1 = upper ? shape.rightY : shape.leftY;
  const cy = upper ? shape.upperControl : shape.lowerControl;
  const inverse = 1 - t;
  const x = inverse * inverse * x0 + 2 * inverse * t * shape.centerX + t * t * x1;
  const y = inverse * inverse * y0 + 2 * inverse * t * cy + t * t * y1;
  const tx = 2 * (inverse * (shape.centerX - x0) + t * (x1 - shape.centerX));
  const ty = 2 * (inverse * (cy - y0) + t * (y1 - cy));
  return { x, y, angle: Math.atan2(ty, tx) };
}

/** Tooth placement along each lip: position along the curve, relative size. */
const UPPER_TEETH: readonly (readonly [number, number])[] = [
  [0.055, 0.5], [0.13, 0.62], [0.205, 0.98], [0.285, 0.58], [0.365, 0.7], [0.45, 0.6],
  [0.535, 0.66], [0.62, 0.56], [0.7, 1], [0.785, 0.62], [0.87, 0.52], [0.945, 0.44],
];
const LOWER_TEETH: readonly (readonly [number, number])[] = [
  [0.06, 0.46], [0.135, 0.98], [0.215, 0.62], [0.295, 0.86], [0.375, 0.56], [0.455, 0.68],
  [0.54, 0.58], [0.62, 0.9], [0.7, 0.6], [0.78, 0.96], [0.86, 0.58], [0.94, 0.44],
];

function drawTeeth(context: CanvasRenderingContext2D, rig: CreatureRig, pose: CreaturePose,
                   shape: Aperture, time: number, upper: boolean, reduced: boolean,
                   tongue: { x: number; y: number; rx: number; ry: number } | null = null) {
  const visible = Math.max(Math.min(1, pose.jawOpen * 2.3), pose.teethBare);
  if (visible <= 0.02) return;
  const row = upper ? UPPER_TEETH : LOWER_TEETH;
  const gap = Math.max(0, shape.lowerApex - shape.upperApex);
  const align = pose.teethAlign;
  const span = shape.rightX - shape.leftX;
  // Roots sit behind the lip, so a tooth is drawn longer than it reads.
  const root = 9;
  const reach = (upper ? 27 : 30) * (0.5 + 0.5 * visible) * (1 + pose.teethLong * 1.1) + pose.teethBare * 5;
  context.save();
  for (let index = 0; index < row.length; index++) {
    const [stop, scale] = row[index];
    const t = mix(stop, 0.055 + index * (0.89 / (row.length - 1)), align * 0.78);
    const spot = onCurve(shape, t, upper);
    const size = mix(scale, 0.9, align * 0.72);
    // Hard cap at the far lip: a fang that overshoots is drawn hanging outside
    // the mouth, over the lip, which is the single most obvious tell that the
    // teeth are pasted on rather than in there.
    const height = Math.min(reach * size + root, gap * 0.52 + root);
    if (height < root + 2) continue;
    // A lower tooth standing in the middle of the mouth stands in the tongue.
    // The tongue covers its shaft and leaves the tip poking through the flesh,
    // which reads as a tooth growing out of the tongue however the two are
    // layered. The jaw keeps its fangs at the corners, where the tongue is not.
    const width = span * 0.052 * (0.72 + 0.4 * size) * (1 - align * 0.1);
    // No tooth may end inside the tongue.
    //
    // Not "no lower tooth in the middle of the mouth", which is what this was
    // first: the one that survived that test was an UPPER tooth rooted near the
    // corner, where the lip dips, pointing down far enough to land on the
    // tongue's edge. So the test is the real one — where does this tooth's tip
    // actually finish — and it is the same test for both rows.
    if (tongue) {
      const lean0 = mix((upper ? spot.angle : spot.angle - Math.PI) * 0.42, 0, align);
      const reachY = (upper ? 1 : -1) * (height - root) * Math.cos(lean0);
      const reachX = (upper ? 1 : -1) * (height - root) * Math.sin(-lean0);
      const tipX = spot.x + reachX;
      const tipY = spot.y + reachY;
      const nx = (tipX - tongue.x) / (tongue.rx + width * 0.6);
      const ny = (tipY - tongue.y) / (tongue.ry + width * 0.6);
      if (nx * nx + ny * ny < 1) continue;
    }
    const quiver = reduced ? 0 : Math.sin(time * 24 + index * 1.9) * pose.teethQuiver * 2.2;
    const lean = mix((upper ? spot.angle : spot.angle - Math.PI) * 0.42, 0, align);
    context.save();
    context.translate(spot.x + quiver, spot.y);
    context.rotate(lean);
    context.scale(1, upper ? 1 : -1);
    context.translate(0, -root);
    context.save();
    context.shadowColor = "rgba(6,2,2,0.75)";
    context.shadowBlur = 5;
    context.shadowOffsetY = 2.5;
    // One sprite or the other wherever the cross-fade would be invisible, so a
    // full set of metal teeth is not twenty-four extra draws a frame.
    if (align > 0.82) {
      context.drawImage(rig.steelTooth.canvas, -width / 2, 0, width, height);
    } else {
      context.drawImage(rig.tooth.canvas, -width / 2, 0, width, height);
      if (align > 0.05) {
        context.globalAlpha = Math.min(1, align * 1.2);
        context.drawImage(rig.steelTooth.canvas, -width / 2, 0, width, height);
        context.globalAlpha = 1;
      }
    }
    context.restore();
    // The cold rim light stays: it is what separates one steel tooth from the
    // next where the chrome gradient happens to match.
    if (align > 0.15) {
      context.strokeStyle = `rgba(226,248,255,${0.6 * align})`;
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(-width * 0.26, height * 0.1);
      context.lineTo(0, height - 1);
      context.stroke();
    }
    context.restore();
  }
  context.restore();
}

/** The fleshy rim around the aperture, which is what makes it read as a mouth. */
function drawLips(context: CanvasRenderingContext2D, pose: CreaturePose, shape: Aperture) {
  // A thin mouth gets a thin lip: a fat roll around a nearly shut mouth draws
  // a second arc below it that reads as a seam.
  const gapNow = shape.lowerApex - shape.upperApex;
  const thickness = (7 + pose.lipPress * 3) * Math.min(1, 0.45 + gapNow / 70);
  context.save();
  context.lineJoin = "round";

  // A wide, very soft skin-toned halo first. The aperture is a vector path with
  // a crisp anti-aliased edge and the head it sits in is a painting with none,
  // and that mismatch is what makes an open mouth read as clip art pasted onto
  // a photograph however well the inside of it is drawn. Blurring the join is
  // most of the fix.
  context.save();
  context.filter = "blur(6px)";
  context.strokeStyle = "rgba(96,84,34,0.5)";
  context.lineWidth = thickness * 2.1;
  aperturePath(context, shape, thickness * 1.15);
  context.stroke();
  context.restore();

  // Outer roll of the lip: shaded from above, catching the amber lamp below.
  const roll = context.createLinearGradient(0, shape.upperApex - thickness, 0, shape.lowerApex + thickness);
  roll.addColorStop(0, "rgba(76,56,18,0.34)");
  roll.addColorStop(0.3, "rgba(48,34,8,0.36)");
  roll.addColorStop(0.62, "rgba(88,68,24,0.22)");
  roll.addColorStop(1, "rgba(186,148,64,0.3)");
  context.strokeStyle = roll;
  context.lineWidth = thickness;
  // Sat outward, so the lip frames the opening instead of eating into it.
  aperturePath(context, shape, thickness * 0.52);
  context.stroke();

  // The seam itself, blurred by a pixel so it is a crease rather than an inked
  // outline. It sits just inside the opening, its outer edge on the lips'
  // line: the dark that reads as "mouth" ends where the rules' opening ends.
  context.save();
  context.filter = "blur(1.1px)";
  context.strokeStyle = "rgba(18,8,2,0.62)";
  const seam = Math.max(2, thickness * 0.45);
  context.lineWidth = seam;
  aperturePath(context, shape, -seam / 2);
  context.stroke();
  context.restore();

  // Wet highlight, only on the middle of the lower lip. Following the whole
  // aperture drew a second arc across the chin that read as a ghost mouth.
  const span = shape.rightX - shape.leftX;
  context.save();
  context.beginPath();
  context.rect(shape.leftX + span * 0.2, shape.lowerApex - 6, span * 0.6, 30);
  context.clip();
  // Soft, and close to the lip's edge: a bright line further out read as a
  // second edge to the opening.
  context.strokeStyle = "rgba(240,216,150,0.16)";
  context.lineWidth = 2.4;
  aperturePath(context, shape, thickness * 0.35);
  context.stroke();
  context.restore();
  context.restore();
}

/**
 * Something drawn inside the opening, over the tongue and under the upper
 * teeth: a caught coin on its way down. Called with the context clipped to the
 * opening and set back to arena coordinates.
 */
export type InMouth = (context: CanvasRenderingContext2D) => void;

function drawMouth(context: CanvasRenderingContext2D, rig: CreatureRig, pose: CreaturePose,
                   shape: Aperture, time: number, reduced: boolean, inMouth: (() => void) | null = null) {
  const gap = shape.lowerApex - shape.upperApex;
  const open = clamp01((gap - 12) / 96);

  if (gap > 6) {
    context.save();
    aperturePath(context, shape);
    context.clip();

    const midY = shape.upperApex + gap * 0.45;
    const throatY = shape.upperApex + gap * 0.34;

    const flesh = context.createRadialGradient(shape.centerX, throatY, 4, shape.centerX, midY, Math.max(70, gap * 1.6));
    flesh.addColorStop(0, "rgb(6,2,2)");
    flesh.addColorStop(0.42, `rgb(${Math.round(8 + 22 * open)},${Math.round(3 + 7 * open)},${Math.round(3 + 6 * open)})`);
    flesh.addColorStop(1, `rgb(${Math.round(16 + 58 * open)},${Math.round(6 + 20 * open)},${Math.round(6 + 18 * open)})`);
    context.fillStyle = flesh;
    context.fillRect(shape.leftX - 24, shape.upperApex - 24, shape.rightX - shape.leftX + 48, gap + 48);

    // Palate: a lighter arc under the top lip, so the roof of the mouth reads.
    const palate = context.createLinearGradient(0, shape.upperApex, 0, shape.upperApex + gap * 0.5);
    palate.addColorStop(0, `rgba(128,64,58,${0.5 * open})`);
    palate.addColorStop(1, "rgba(60,20,20,0)");
    context.fillStyle = palate;
    context.fillRect(shape.leftX - 24, shape.upperApex - 6, shape.rightX - shape.leftX + 48, gap * 0.55);

    // The swallow, while the lump is still inside the mouth.
    if (pose.throat > 0.02 && pose.throatTravel < 0.34) {
      context.fillStyle = `rgba(138,82,66,${0.55 * pose.throat})`;
      context.beginPath();
      context.ellipse(shape.centerX + 3, throatY + gap * (0.08 + pose.throatTravel * 1.4),
        30 * pose.throat, 20 * pose.throat, 0, 0, Math.PI * 2);
      context.fill();
    }

    // Lower teeth, then the tongue, then the upper teeth.
    //
    // The tongue used to go on first with every tooth in front of it, which is
    // right at the corners of the jaw and wrong everywhere else: the lower teeth
    // in the middle of the arc landed on the tongue's body and read as teeth
    // growing out of it. A tongue sits on top of the lower jaw and in front of
    // the teeth rooted in it; only the upper row hangs in front of everything.
    // So the order is the anatomy's, and the corners still show their fangs
    // because the tongue is narrower than the mouth.
    const tongueWidth = Math.max(46, (shape.rightX - shape.leftX) * 0.46);
    const tongueHeight = Math.max(16, Math.min(40, gap * 0.36));
    const tongueShape = {
      x: shape.centerX - 2, y: shape.lowerApex - tongueHeight * 0.68,
      rx: tongueWidth * 0.5, ry: tongueHeight,
    };
    drawTeeth(context, rig, pose, shape, time, false, reduced, tongueShape);

    // Nearly shut, the tongue goes: a shut mouth is teeth on dark, and pink
    // in the slit read as a mouth still open.
    const tongueShown = clamp01((gap - 26) / 34);
    context.save();
    context.globalAlpha = tongueShown;
    context.translate(shape.centerX - 2, shape.lowerApex - tongueHeight * 0.68);
    context.rotate(pose.tongueOut * 0.05);
    // The tongue patch is cut with a feathered edge, so anything behind it
    // shows through its rim. An opaque floor under it in the mouth's own colour
    // is what stops a tooth ghosting through the side of the tongue.
    context.fillStyle = "rgba(58,18,18,1)";
    context.beginPath();
    context.ellipse(0, 0, tongueWidth * 0.54, tongueHeight * 0.96, 0, 0, Math.PI * 2);
    context.fill();
    context.drawImage(rig.tongue.canvas, -tongueWidth / 2, -tongueHeight, tongueWidth, tongueHeight * 2);
    context.restore();

    // What it just caught goes down here: over the tongue, behind the upper teeth.
    if (inMouth) inMouth();

    drawTeeth(context, rig, pose, shape, time, true, reduced, tongueShape);

    // Gum ridges, drawn over the tooth roots so the row is seated in flesh
    // instead of ending on the straight edge where the clip cuts it.
    context.save();
    context.lineCap = "round";
    context.strokeStyle = `rgba(96,42,40,${0.7 + 0.2 * open})`;
    context.lineWidth = 11;
    context.filter = "blur(2px)";
    aperturePath(context, shape, -3);
    context.stroke();
    context.strokeStyle = "rgba(150,74,68,0.32)";
    context.lineWidth = 4;
    aperturePath(context, shape, -6.5);
    context.stroke();
    context.restore();

    // The lip has thickness, so the rim falls away into shadow.
    context.save();
    context.strokeStyle = "rgba(12,4,1,0.8)";
    context.lineWidth = 15;
    context.filter = "blur(5px)";
    aperturePath(context, shape);
    context.stroke();
    context.restore();
    context.restore();
  } else if (pose.teethBare > 0.05) {
    // Mouth shut but the teeth are out: they overhang the lip.
    drawTeeth(context, rig, pose, shape, time, true, reduced);
  }

  drawLips(context, pose, shape);

  // Tongue lolling past the lip, for hunger and for heat.
  //
  // Only while the mouth is shut or nearly so. An open mouth already has a
  // tongue on its floor, and drawing this second sprite over it gave the
  // creature two overlapping tongues with a seam between them — which is what
  // "the tongue is split in half" was.
  if (pose.tongueOut > 0.04 && pose.jawOpen < 0.4) {
    const width = Math.max(52, (shape.rightX - shape.leftX) * 0.34);
    const height = 24 + pose.tongueOut * 30;
    context.save();
    context.translate(shape.centerX - 10, shape.lowerApex - 8);
    context.rotate(0.14 + pose.tongueOut * 0.12);
    // Drawn back in as the jaws part, so the mouth never shows two tongues
    // and nothing hangs over the lower lip once it can take a coin.
    context.globalAlpha = Math.min(1, pose.tongueOut * 2.4) * clamp01((0.3 - pose.jawOpen) / 0.1);
    context.drawImage(rig.tongue.canvas, -width / 2, -height * 0.28, width, height);
    context.fillStyle = "rgba(22,7,4,0.4)";
    context.beginPath();
    context.ellipse(0, -height * 0.2, width * 0.46, height * 0.12, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  // Drool hangs off the outside of the lower lip. Drawn at a fixed offset from
  // the aperture it landed *inside* a wide-open mouth, on the tongue, where a
  // thin line with a bead on the end reads as a stray pin sprite left in the
  // build — three reviewers flagged it as debug art.
  if (pose.drool > 0.05) {
    const swing = reduced ? 0 : Math.sin(time * 1.6) * 3;
    const length = pose.drool * 26 + swing;
    const anchor = onCurve(shape, 0.72, false);
    context.save();
    context.globalAlpha = Math.min(0.8, pose.drool);
    // A tapered thread rather than a stroke of even width, so it reads as a
    // liquid strand rather than as a drawn line.
    context.fillStyle = "rgba(228,236,200,0.72)";
    context.beginPath();
    context.moveTo(anchor.x - 2.2, anchor.y - 2);
    context.quadraticCurveTo(anchor.x + 0.6, anchor.y + length * 0.55,
                             anchor.x + 0.4, anchor.y + length);
    context.quadraticCurveTo(anchor.x - 0.8, anchor.y + length * 0.55,
                             anchor.x + 2.2, anchor.y - 2);
    context.closePath();
    context.fill();
    context.beginPath();
    context.ellipse(anchor.x + 0.4, anchor.y + length, 2.6, 3.2, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }
}

/**
 * Eyes.
 *
 * The lid is a band of the creature's own skin, drawn inside a clip of the eye
 * so it can never end on a straight cut edge, and angled about the outer
 * corner: dropping the inner end reads as anger, lifting it as worry. A wet
 * highlight goes on last, because at stream resolution the catchlight is what
 * makes the eye look alive.
 */
function drawEyes(context: CanvasRenderingContext2D, rig: CreatureRig, pose: CreaturePose, field: WarpField) {
  const lidLit = skinTone(rig.palette.skinMid, pose);
  const lidShade = skinTone(rig.palette.skinShadow, pose);
  for (const side of EYE_SIDES) {
    const eye = EYE[side];
    // Positive x is outward for the right eye and inward for the left one.
    const outward = side === "left" ? -1 : 1;
    const inward = -outward;
    const local = localTransform(field, eye.x, eye.y);
    // A heavy upper lid and a raised lower one can between them cover the whole
    // eye, and an eye covered by opaque skin does not read as a squint — it
    // reads as a hole where an eye should be. So the pair is given a budget:
    // whatever the expression asks for, a slit is always left, and the pupil
    // slides into it the way a real eye follows its own lids.
    const upperWant = clamp01(side === "left" ? pose.lidLeft : pose.lidRight);
    const lowerWant = clamp01(pose.lowerLid);
    const covered = upperWant + lowerWant * 0.55;
    const squeeze = covered > 0.72 ? 0.72 / covered : 1;
    const upper = upperWant * squeeze;
    const lowerLid = lowerWant * squeeze;
    // A blink is the one thing allowed to shut it completely.
    const lid = clamp01(Math.max(upper, pose.blink));
    const slit = (upper - lowerLid * 0.55) * eye.ry * 0.85;
    // One brow lifting on its own is the whole of "unimpressed", so it gets a
    // channel of its own rather than being an average of the other two.
    const brow = (pose.browAngry * 17 - pose.browSad * 14) * (side === "left" ? 1 : -1)
      - (side === "left" ? pose.browAsym * 15 : 0);

    context.save();
    context.translate(eye.x + local.dx, eye.y + local.dy);
    context.rotate(pose.headTilt * Math.PI / 180 * 0.6);
    context.scale(local.scaleX, local.scaleY);
    context.translate(-eye.x, -eye.y);

    // Pupil, wherever it is looking.
    const spot = eye.pupil;
    // Travel is bounded by the socket, so a hard look never clips the pupil in
    // half against the edge of the eye.
    // The pupil is allowed to ride slightly under the edge of the socket, the
    // way a real eye does at the end of its travel: keeping it wholly inside
    // left only ten pixels of movement, which is not an eyeline anyone can read
    // at stream resolution.
    // Travel is a fraction of the socket rather than a fixed inset, so the two
    // eyes sweep together even though the right socket is wider than the left.
    const reachX = eye.rx * 0.62;
    const reachY = eye.ry * 0.42;
    // Both pupils rest at the centre of their own socket and travel the same
    // fraction of it. Keeping a share of the painting's inward bias left the two
    // eyes converged by about seven pixels and travelling different distances,
    // so a hard look left came out as one eye left and the other barely moved —
    // which at stream resolution reads as no eyeline at all rather than as a
    // direction.
    const restX = eye.x;
    const restY = eye.y;
    // Aim and lid-follow are clamped together, not separately. A heavy lid slides
    // the pupil down and a downcast gaze slides it down again, and the two of
    // them together pushed it clean off the bottom of the socket — which is why
    // a starving creature's eyes went blank white at the moment they are held on
    // screen the longest.
    const holdX = Math.max(-1, Math.min(1, pose.pupilX)) * reachX;
    const holdY = Math.max(-reachY, Math.min(reachY,
      Math.max(-1, Math.min(1, pose.pupilY)) * reachY + slit * 0.6));
    const pupilX = restX + holdX;
    const pupilY = restY + holdY;
    context.save();
    context.beginPath();
    context.ellipse(eye.x, eye.y, eye.rx - 1, eye.ry - 1, 0, 0, Math.PI * 2);
    context.clip();
    context.save();
    context.translate(pupilX, pupilY);
    // Compressed, and capped well inside the eye. At full scale the pupil is
    // taller than the eye, so the clip cut its top and bottom off and what was
    // left read as a dark horizontal slot rather than an eye looking at
    // something. Dilation still reads; it just cannot swallow the sclera.
    const dilate = Math.min(1.02, 0.8 + (pose.pupilScale - 1) * 0.55);
    context.scale(dilate, dilate);
    context.drawImage(rig.pupil[side].canvas, -spot.r, -spot.r, spot.r * 2, spot.r * 2);
    context.restore();
    // Socket shadow: the brow above the eye keeps its top in shade.
    const socket = context.createLinearGradient(0, eye.y - eye.ry - 3, 0, eye.y + eye.ry);
    socket.addColorStop(0, "rgba(30,22,4,0.5)");
    socket.addColorStop(0.5, "rgba(30,22,4,0.04)");
    socket.addColorStop(1, "rgba(30,22,4,0.2)");
    context.fillStyle = socket;
    context.fillRect(eye.x - eye.rx - 3, eye.y - eye.ry - 4, eye.rx * 2 + 6, eye.ry * 2 + 8);
    context.restore();

    // Lids, clipped to the eye so their edges follow its outline.
    context.save();
    context.beginPath();
    // Slightly inside the socket. The painted brow ridge overlaps the top of
    // the eyeball, so a lid that fills the clip to its edge paints a flat cap
    // over the brow — which is what turned a heavy lid into a khaki half-disc
    // sitting on the creature's face.
    context.ellipse(eye.x, eye.y, eye.rx - 0.8, eye.ry - 1.4, 0, 0, Math.PI * 2);
    context.clip();
    // Brows pivot at the outer corner, so anger drops the inner end and worry
    // lifts it — the same way a real brow moves.
    const pivotX = eye.x + outward * (eye.rx + 12);
    const pivotY = eye.y - eye.ry;
    context.translate(pivotX, pivotY);
    context.rotate(brow * Math.PI / 180);
    context.translate(-pivotX, -pivotY);
    // Lids are painted, not cut. A crop of real skin stretched over a moving lid
    // holds together only at the coverage it was cut at: at anything else it
    // becomes a leaf-shaped sliver lying on the eyeball, which is what put a
    // claw across the creature's eye in every half-lidded state. A shaded fill
    // in the skin colour sampled from just above and below the eye keeps its
    // shape at any coverage and matches the painting either side of it.
    const left = eye.x - eye.rx - 6;
    const right = eye.x + eye.rx + 6;
    const lidEdge = eye.y - eye.ry - 1 + lid * (eye.ry * 2 + 4) - pose.browRaise * 3.5;
    const paintLid = (edge: number, from: number, bulge: number, lit: string, shade: string) => {
      // The curve is taken out of the middle of the lid, not added to it. A
      // quadratic that sags `bulge` below the edge covers that much more of the
      // eye at its centre, so deepening the curve to stop it reading as a
      // straight cut also quietly shut both eyes on the half-lidded states.
      const lip = edge - bulge / 2;
      context.beginPath();
      context.moveTo(left, from);
      context.lineTo(right, from);
      context.lineTo(right, lip);
      context.quadraticCurveTo(eye.x, lip + bulge, left, lip);
      context.closePath();
      // Real skin, translated. The slab is cut from the brow well above the eye
      // and moved down to meet the lid edge — never scaled — so the grain and
      // the lighting are the painting's own at whatever coverage the lid is at.
      const slab = rig.lidSkin[side];
      context.save();
      context.clip();
      context.drawImage(slab.canvas, slab.x, lip + bulge - slab.height, slab.width, slab.height);
      // Then shaded and tinted to wherever the surrounding skin currently is,
      // since colour grading has already been composited under this.
      const skin = context.createLinearGradient(0, lip - slab.height * 0.5, 0, lip + bulge);
      skin.addColorStop(0, shade);
      skin.addColorStop(0.6, lit);
      skin.addColorStop(1, shade);
      context.globalCompositeOperation = "color";
      context.globalAlpha = 0.55;
      context.fillStyle = skin;
      context.fill();
      context.globalCompositeOperation = "multiply";
      context.globalAlpha = 0.28;
      context.fillStyle = shade;
      context.fill();
      context.restore();
      // The rolled margin of the lid catches the lamp, and the lash line under
      // it is a crease rather than an outline. Without these the lid is a flat
      // shape laid on the eye instead of a piece of the same head.
      context.save();
      context.filter = "blur(1.4px)";
      context.strokeStyle = "rgba(214,196,132,0.3)";
      context.lineWidth = 3;
      context.beginPath();
      context.moveTo(left, lip - Math.sign(bulge) * 3.2);
      context.quadraticCurveTo(eye.x, lip + bulge - Math.sign(bulge) * 3.2, right, lip - Math.sign(bulge) * 3.2);
      context.stroke();
      context.filter = "blur(0.8px)";
      context.strokeStyle = "rgba(24,18,4,0.55)";
      context.lineWidth = 2.2;
      context.beginPath();
      context.moveTo(left, lip);
      context.quadraticCurveTo(eye.x, lip + bulge, right, lip);
      context.stroke();
      context.restore();
    };

    // `from` reaches well clear of the eye: a lid whose far edge sits just
    // outside it swings into view as soon as the brow rotates, and a straight
    // horizontal line across the top of an eyeball reads as a torn sprite.
    paintLid(lidEdge, eye.y - eye.ry - 70, 14, lidLit, lidShade);
    if (lid > 0.06) {
      context.save();
      context.globalAlpha = Math.min(0.5, lid * 0.7);
      const cast = context.createLinearGradient(0, lidEdge, 0, lidEdge + 16);
      cast.addColorStop(0, "rgba(18,12,2,0.75)");
      cast.addColorStop(1, "rgba(18,12,2,0)");
      context.fillStyle = cast;
      context.fillRect(left, lidEdge, right - left, 18);
      context.restore();
    }

    if (lowerLid > 0.03) {
      const rise = lowerLid * eye.ry * 0.62;
      paintLid(eye.y + eye.ry - rise, eye.y + eye.ry + 70, -11, lidLit, lidShade);
    }
    context.restore();

    // Brow ridge: a soft shadow above the eye that angles with the mood.
    if (pose.browAngry > 0.04 || pose.browSad > 0.04) {
      context.save();
      context.translate(pivotX, pivotY);
      context.rotate(brow * Math.PI / 180);
      context.translate(-pivotX, -pivotY);
      // Blurred hard: a crisp lens of solid colour above the eye reads as a
      // leaf stuck to the face. As a soft shadow it reads as a lowered brow.
      context.filter = "blur(5px)";
      context.globalAlpha = Math.min(0.5, pose.browAngry * 0.5 + pose.browSad * 0.28);
      context.fillStyle = "rgba(28,22,6,0.85)";
      context.beginPath();
      context.moveTo(eye.x - eye.rx - 7, eye.y - eye.ry - 3);
      context.quadraticCurveTo(eye.x, eye.y - eye.ry - 13, eye.x + eye.rx + 7, eye.y - eye.ry - 3);
      context.quadraticCurveTo(eye.x, eye.y - eye.ry - 6, eye.x - eye.rx - 7, eye.y - eye.ry - 3);
      context.fill();
      context.restore();
    }

    // Catchlight, clipped to the eye. Unclipped it can land on the skin beside a
    // pupil that has travelled to the edge of its socket, and a bright specular
    // dot on the cheek reads as dirt on the lens.
    if (lid < 0.7) {
      context.save();
      context.beginPath();
      context.ellipse(eye.x, eye.y, eye.rx - 1, eye.ry - 1, 0, 0, Math.PI * 2);
      context.clip();
      context.globalAlpha = 0.85 * (1 - lid / 0.7);
      context.fillStyle = "rgba(255,252,236,0.95)";
      context.beginPath();
      context.ellipse(pupilX - inward * 4.5, pupilY - 5.5, 2.4, 1.9, -0.4, 0, Math.PI * 2);
      context.fill();
      context.globalAlpha *= 0.5;
      context.beginPath();
      context.ellipse(pupilX + inward * 5, pupilY + 4.5, 1.5, 1.1, 0.3, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
    context.restore();
  }
}

/**
 * Paints a tint through the creature's own soft silhouette.
 *
 * Grading the whole frame made the kitchen change colour, which on a stream
 * reads as a white-balance fault rather than a mood.
 */
/**
 * Body colour grades, collected and then flushed one blend mode at a time.
 *
 * Each grade used to composite itself: paint a gradient into a third-scale
 * scratch, mask it to the body, and blend the whole 1200x700 result onto the
 * canvas. That last step is a full-frame blended composite at 1920x1080 and it
 * is the single most expensive thing the renderer does — and a mid-shift
 * creature runs seven of them, which measured at 4.5 ms of a 4 ms budget for
 * this function alone while a bare one cost 0.01 ms.
 *
 * Two changes, no new pixels: grades sharing a blend mode are painted into one
 * scratch and blended once, and the blend covers the rectangle the body grades
 * actually paint into rather than the whole frame.
 */
interface BodyGrade { paint: (scratch: CanvasRenderingContext2D) => void }
/** The rectangle every body grade paints into, in arena coordinates. */
const GRADE_REGION = { x: 500, y: 40, width: 700, height: 440 };
/**
 * Every body grade is composited once, with `source-over`.
 *
 * They used to carry a blend mode each — overlay, saturation, multiply,
 * screen — and a mid-shift creature ran four of them. Measured on the worst
 * state, each blended composite of the body region costs 0.8-1.7 ms whatever
 * the mode: the cost is the blended full-resolution composite itself, not the
 * mode's arithmetic, and `source-over` is the one path that is not blended.
 *
 * What is lost is luminance preservation — a wash rather than a grade — and at
 * these alphas, at the 960 px resolution this game is judged at, that is not a
 * difference anyone can see. What is gained is the entire mutation render
 * regression: four composites become one, and the one is the cheap kind.
 */
const GRADE_MODE: GlobalCompositeOperation = "source-over";
/** The most summed cool-wash cover the body takes before the washes are scaled back together. */
const WASH_CAP = 0.5;

function flushGrades(context: CanvasRenderingContext2D, rig: CreatureRig, grades: BodyGrade[]) {
  if (!grades.length) return;
  const scratch = rig.grade;
  const inner = scratch.getContext("2d");
  if (!inner) return;
  const sx = scratch.width / 1200;
  const sy = scratch.height / 700;
  const gradeStart = DEV_HOOKS ? performance.now() : 0;
  inner.setTransform(1, 0, 0, 1, 0, 0);
  inner.globalCompositeOperation = "source-over";
  inner.clearRect(0, 0, scratch.width, scratch.height);
  inner.save();
  inner.scale(sx, sy);
  for (const grade of grades) grade.paint(inner);
  inner.restore();
  inner.globalCompositeOperation = "destination-in";
  inner.drawImage(rig.bodyMask, 0, 0, scratch.width, scratch.height);
  inner.globalCompositeOperation = "source-over";
  // Only the rectangle the grades paint into, not the whole frame.
  const rx = Math.floor(GRADE_REGION.x * sx);
  const ry = Math.floor(GRADE_REGION.y * sy);
  const rw = Math.ceil(GRADE_REGION.width * sx);
  const rh = Math.ceil(GRADE_REGION.height * sy);
  context.save();
  context.globalCompositeOperation = GRADE_MODE;
  context.drawImage(scratch, rx, ry, rw, rh,
    GRADE_REGION.x, GRADE_REGION.y, GRADE_REGION.width, GRADE_REGION.height);
  context.restore();
  if (DEV_HOOKS) rigParts.overlay += performance.now() - gradeStart;
}

function drawSkin(context: CanvasRenderingContext2D, rig: CreatureRig, pose: CreaturePose,
                  time: number, reduced: boolean) {
  const grades: BodyGrade[] = [];
  // Irritation flush: heat rising through the muzzle and cheeks.
  if (pose.flush > 0.03) {
    grades.push({ paint: (inner) => {
      // Heat sits in the face and cheeks and falls away down the body, so it
      // reads as a blush rather than as a light change.
      // The outermost stop has to be fully transparent. A gradient that ends on
      // a low but non-zero alpha keeps that alpha all the way out to the edge of
      // the fill, and the edge of the fill is a rectangle: that is where the
      // hard elliptical boundary across the shoulder came from.
      // Radius chosen so the falloff completes inside the body. When it ran all
      // the way to the silhouette, the tint ended where the creature ended, and
      // an abrupt orange-to-background transition along the jaw reads as a
      // compositing seam rather than as a blush.
      const heat = inner.createRadialGradient(846, 236, 24, 846, 244, 248);
      heat.addColorStop(0, `rgba(255,92,28,${1.05 * pose.flush})`);
      heat.addColorStop(0.4, `rgba(236,66,18,${0.6 * pose.flush})`);
      heat.addColorStop(0.72, `rgba(214,52,14,${0.2 * pose.flush})`);
      heat.addColorStop(1, "rgba(210,50,14,0)");
      inner.fillStyle = heat;
      inner.fillRect(500, 40, 700, 500);
    } });
  }

  // Irritation is a darker, blood-under-the-skin flush. Sharing pepper's orange
  // made four states look like one lighting change.
  if (pose.rageFlush > 0.03) {
    grades.push({ paint: (inner) => {
      const anger = inner.createRadialGradient(846, 250, 24, 846, 262, 340);
      anger.addColorStop(0, `rgba(196,26,34,${0.95 * pose.rageFlush})`);
      anger.addColorStop(0.42, `rgba(150,14,34,${0.55 * pose.rageFlush})`);
      anger.addColorStop(0.74, `rgba(126,10,30,${0.18 * pose.rageFlush})`);
      anger.addColorStop(1, "rgba(112,10,30,0)");
      inner.fillStyle = anger;
      inner.fillRect(500, 40, 700, 500);
    } });
    // The cheeks themselves: two soft hot spots, not lines. Stroke marks on a
    // painted face read as pen on a photograph.
    grades.push({ paint: (inner) => {
      for (const [cx, cy] of [[748, 236], [938, 242]] as const) {
        const cheek = inner.createRadialGradient(cx, cy, 2, cx, cy, 58);
        cheek.addColorStop(0, `rgba(222,48,48,${0.55 * pose.rageFlush})`);
        cheek.addColorStop(0.5, `rgba(196,30,40,${0.24 * pose.rageFlush})`);
        cheek.addColorStop(1, "rgba(180,20,36,0)");
        inner.fillStyle = cheek;
        inner.beginPath();
        inner.ellipse(cx, cy, 58, 48, 0, 0, Math.PI * 2);
        inner.fill();
      }
    } });
  }

  // The three cool washes below — metal's steel, the balloon's taut rim and
  // hunger's pallor — each read on their own and compounded into a white
  // creature late in a shift, when all three are on at once. They share one
  // budget: past `WASH_CAP` of summed cover they are scaled back together, so
  // a creature carrying every mutation is still the same green monster with a
  // flush, only colder.
  const washLoad = 0.5 * pose.magnetism + 0.4 * pose.taut + 0.85 * pose.pallor;
  const washScale = washLoad > WASH_CAP ? WASH_CAP / washLoad : 1;
  const magnetism = pose.magnetism * washScale;
  const taut = pose.taut * washScale;
  const pallor = pose.pallor * washScale;

  // Metal: a cold wash creeping up the jaw, and only ever here. Before this the
  // mutation had no colour identity at all — the fangs were ivory, so it read as
  // "bigger teeth" rather than as metal — while warm tones meant pepper AND
  // anger, so three of the four vocabulary units in the set were one colour.
  if (magnetism > 0.04) {
    grades.push({ paint: (inner) => {
      const steel = inner.createRadialGradient(846, 300, 20, 846, 258, 300);
      steel.addColorStop(0, `rgba(176,206,222,${0.34 * magnetism})`);
      steel.addColorStop(0.45, `rgba(138,172,196,${0.2 * magnetism})`);
      steel.addColorStop(1, "rgba(120,156,184,0)");
      inner.fillStyle = steel;
      inner.fillRect(500, 40, 700, 500);
    } });
    grades.push({ paint: (inner) => {
      inner.fillStyle = `rgba(150,170,185,${0.16 * magnetism})`;
      inner.fillRect(500, 40, 700, 500);
    } });
  }

  // Balloon: a taut cool rim along the top of the swell, which is what a
  // stretched, over-full surface does to the light above it.
  if (taut > 0.05) {
    grades.push({ paint: (inner) => {
      const rim = inner.createRadialGradient(846, 268, 30, 846, 300, 320);
      rim.addColorStop(0, `rgba(186,244,232,${0.4 * taut})`);
      rim.addColorStop(0.5, `rgba(150,222,214,${0.16 * taut})`);
      rim.addColorStop(1, "rgba(140,214,206,0)");
      inner.fillStyle = rim;
      inner.fillRect(500, 40, 700, 500);
    } });
  }

  // Hunger pallor: colour drains and the light goes cold.
  if (pallor > 0.03) {
    grades.push({ paint: (inner) => {
      inner.fillStyle = `rgba(150,168,150,${0.3 * pallor})`;
      inner.fillRect(500, 40, 700, 500);
    } });
    grades.push({ paint: (inner) => {
      const cold = inner.createRadialGradient(846, 300, 30, 846, 300, 420);
      cold.addColorStop(0, `rgba(150,186,198,${0.5 * pallor})`);
      cold.addColorStop(0.7, `rgba(150,186,198,${0.25 * pallor})`);
      cold.addColorStop(1, "rgba(150,186,198,0)");
      inner.fillStyle = cold;
      inner.fillRect(500, 40, 700, 500);
    } });
  }

  flushGrades(context, rig, grades);

  // Pressure on the cheeks: a blotch of blood under the skin with a hot core.
  // Soft, because stroke marks on a painted face read as pen on a photograph.
  if (pose.cheekMarks > 0.05) {
    context.save();
    for (const [cx, cy, direction] of [[726, 256, -1], [964, 266, 1]] as const) {
      const blotch = context.createRadialGradient(cx, cy, 3, cx, cy, 54);
      blotch.addColorStop(0, `rgba(214,44,18,${0.62 * pose.cheekMarks})`);
      blotch.addColorStop(0.55, `rgba(190,38,16,${0.3 * pose.cheekMarks})`);
      blotch.addColorStop(1, "rgba(190,38,16,0)");
      context.fillStyle = blotch;
      context.beginPath();
      context.ellipse(cx, cy, 54, 46, 0, 0, Math.PI * 2);
      context.fill();
      // A hotter core, so the mark reads as pressure and not as a general blush.
      const core = context.createRadialGradient(cx + direction * 8, cy - 4, 1, cx + direction * 8, cy - 4, 22);
      core.addColorStop(0, `rgba(236,70,40,${0.5 * pose.cheekMarks})`);
      core.addColorStop(1, "rgba(236,70,40,0)");
      context.fillStyle = core;
      context.beginPath();
      context.ellipse(cx + direction * 8, cy - 4, 22, 18, 0, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }

  // Sweat.
  if (pose.sweat > 0.08) {
    context.save();
    context.globalAlpha = Math.min(0.85, pose.sweat);
    // Moved inboard and onto the brow. The outermost bead used to sit past the
    // edge of the head, where at stream resolution it reads as a dead pixel on
    // the broadcast rather than as sweat.
    for (const [x, y] of [[772, 120], [918, 118], [742, 150]] as const) {
      const drift = reduced ? 0 : (Math.sin(time * 1.3 + x) * 0.5 + 0.5) * 8;
      context.fillStyle = "rgba(226,238,208,0.75)";
      context.beginPath();
      context.ellipse(x, y + drift, 2.6, 4, 0, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "rgba(255,255,255,0.8)";
      context.beginPath();
      context.arc(x - 0.8, y + drift - 1.2, 0.9, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }

  // Tears. A burn that makes the eyes water reads at any resolution — as long
  // as each one is on the cheek it is running down and not beside it.
  if (pose.tears > 0.08) {
    context.save();
    context.globalAlpha = Math.min(0.9, pose.tears);
    for (const side of EYE_SIDES) {
      const eye = EYE[side];
      const outward = side === "left" ? -1 : 1;
      // Started under the lid rather than clear of it: a streak that begins in
      // bare skin a few pixels below the eye reads as a detached white lozenge,
      // not as something the eye is producing.
      const x = eye.x + outward * (eye.rx - 7);
      const top = eye.y + eye.ry - 11;
      const run = 10 + pose.tears * 30;
      const streak = context.createLinearGradient(x, top, x + outward * 5, top + run);
      streak.addColorStop(0, "rgba(226,244,250,0.75)");
      streak.addColorStop(1, "rgba(226,244,250,0.05)");
      context.strokeStyle = streak;
      context.lineWidth = 2.6;
      context.lineCap = "round";
      context.beginPath();
      context.moveTo(x, top);
      context.quadraticCurveTo(x + outward * 4, top + run * 0.6, x + outward * 6, top + run);
      context.stroke();
      context.fillStyle = "rgba(238,250,255,0.85)";
      context.beginPath();
      context.ellipse(x + outward * 6, top + run, 2.6, 3.4, 0, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }

}

/** The swallowed lump, as a shaded bulge travelling down the throat. */
function drawThroat(context: CanvasRenderingContext2D, pose: CreaturePose) {
  if (pose.throat <= 0.03) return;
  const y = 322 + pose.throatTravel * 132;
  const width = 44 * pose.throat;
  const height = 30 * pose.throat;
  context.save();
  context.globalCompositeOperation = "multiply";
  const under = context.createRadialGradient(842, y + height * 0.6, 2, 842, y + height * 0.6, width);
  under.addColorStop(0, `rgba(96,72,30,${0.42 * pose.throat})`);
  under.addColorStop(0.6, `rgba(120,96,44,${0.2 * pose.throat})`);
  under.addColorStop(1, "rgba(140,116,60,0)");
  context.fillStyle = under;
  context.beginPath();
  context.ellipse(842, y + height * 0.6, width * 1.1, height * 0.7, 0, 0, Math.PI * 2);
  context.fill();
  context.globalCompositeOperation = "overlay";
  const lit = context.createRadialGradient(834, y - height * 0.4, 2, 842, y, width);
  lit.addColorStop(0, `rgba(255,240,190,${0.65 * pose.throat})`);
  lit.addColorStop(0.6, `rgba(220,190,120,${0.2 * pose.throat})`);
  lit.addColorStop(1, "rgba(220,190,120,0)");
  context.fillStyle = lit;
  context.beginPath();
  context.ellipse(842, y, width, height, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

/** Hot air leaving the mouth, anchored to the mouth it comes out of. */
/**
 * The pepper gust.
 *
 * This was a drifting plume for four iterations and every reviewer read it the
 * same way: a grey smudge stuck to the cheek, "lens dirt", "a thumb smudge".
 * The problem is structural rather than a matter of tuning — a soft light mass
 * over a photoreal painting has no edge to tell the eye it is volume, and the
 * moment it leaves the mouth it has nothing to belong to.
 *
 * So the gust is drawn as the mouth running hot instead: the cavity glows from
 * the throat outward, the lips catch the light coming out of them, and a short
 * hard-edged blast sits *in* the opening rather than beside it. It cannot
 * detach, because it is bounded by the aperture.
 */
function drawExhale(context: CanvasRenderingContext2D, pose: CreaturePose, shape: Aperture,
                    time: number, reduced: boolean) {
  if (pose.exhale <= 0.05) return;
  const gap = Math.max(6, shape.lowerApex - shape.upperApex);
  const midY = (shape.upperApex + shape.lowerApex) / 2;
  const pulse = reduced ? 0.8 : 0.72 + 0.28 * Math.sin(time * 9);

  context.save();
  aperturePath(context, shape);
  context.clip();
  context.globalCompositeOperation = "screen";
  context.globalAlpha = pose.exhale * 0.72;
  const core = context.createRadialGradient(shape.centerX, midY, 2,
                                            shape.centerX, midY, gap * 1.05 * pulse);
  core.addColorStop(0, "rgba(255,232,180,0.85)");
  core.addColorStop(0.3, "rgba(255,158,58,0.58)");
  core.addColorStop(0.75, "rgba(226,88,26,0.3)");
  core.addColorStop(1, "rgba(200,60,18,0)");
  context.fillStyle = core;
  context.fillRect(shape.leftX - 40, shape.upperApex - 40,
                   shape.rightX - shape.leftX + 80, gap + 80);
  context.restore();

  // Light spilling out of the mouth onto the lip and the skin just beyond it.
  context.save();
  context.globalCompositeOperation = "screen";
  context.globalAlpha = pose.exhale * 0.55 * pulse;
  context.filter = "blur(9px)";
  const spill = context.createRadialGradient(shape.centerX, midY, gap * 0.3,
                                             shape.centerX, midY, gap * 2.1);
  spill.addColorStop(0, "rgba(255,176,88,0.55)");
  spill.addColorStop(1, "rgba(255,140,50,0)");
  context.fillStyle = spill;
  context.beginPath();
  context.ellipse(shape.centerX, midY, gap * 2.1, gap * 1.5, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

/**
 * Electric crackle over magnetised teeth: short forked arcs that jump between
 * neighbouring fangs, drawn in the mouth's own coordinates. Deterministic in
 * `time`, so a capture of the same clock is the same picture.
 */
function drawCrackle(context: CanvasRenderingContext2D, pose: CreaturePose, shape: Aperture,
                     time: number, reduced: boolean) {
  if (pose.crackle <= 0.05) return;
  const span = shape.rightX - shape.leftX;
  const arcs = reduced ? 2 : 3 + Math.round(pose.crackle * 3);
  context.save();
  context.globalCompositeOperation = "screen";
  context.lineCap = "round";
  for (let i = 0; i < arcs; i++) {
    // Each arc lives for a third of a second at a seeded place, then jumps.
    const slot = Math.floor(time * 3 + i * 0.37);
    const seed = Math.sin(slot * 91.7 + i * 13.1) * 43758.5453;
    const u = seed - Math.floor(seed);
    const upper = (slot + i) % 2 === 0;
    const t0 = 0.08 + u * 0.78;
    const a = onCurve(shape, t0, upper);
    const b = onCurve(shape, Math.min(0.95, t0 + 0.09 + u * 0.05), upper);
    const flicker = reduced ? 0.7 : 0.45 + 0.55 * Math.abs(Math.sin(time * 31 + i * 2.3));
    const dir = upper ? 1 : -1;
    context.globalAlpha = pose.crackle * flicker;
    context.strokeStyle = "rgba(190,236,255,0.95)";
    context.lineWidth = 1.6 + flicker;
    context.beginPath();
    context.moveTo(a.x, a.y + dir * 6);
    const midX = (a.x + b.x) / 2 + (u - 0.5) * span * 0.04;
    // Kept to the teeth's own band, so an arc never crosses the opening
    // between the coin and the throat.
    const midY = (a.y + b.y) / 2 + dir * (9 + u * 5);
    context.lineTo(midX, midY);
    context.lineTo(b.x, b.y + dir * 6);
    context.stroke();
    context.strokeStyle = "rgba(120,200,255,0.5)";
    context.lineWidth = 4;
    context.stroke();
  }
  context.restore();
}

/** The resting mouth in painting coordinates: the point the body is scaled about. */
export { REST_MOUTH };

export function drawCreature(context: CanvasRenderingContext2D, rig: CreatureRig, pose: CreaturePose,
                             time: number, reduced: boolean, ruledMouth: MouthShape | null = null,
                             inMouth: InMouth | null = null) {
  const mark = DEV_HOOKS ? () => performance.now() : () => 0;
  const t0 = mark();
  const field = buildField(pose, time, reduced);
  const t1 = mark();

  // The creature is a clipped layer on the kitchen: the painting, warped, drawn
  // through its own silhouette, scaled about its resting mouth and moved so
  // the drawn mouth lands exactly on the rules' collision ellipse. The clip is
  // the traced silhouette pushed through the same field as the paint, so the
  // edge follows a tilted head and a swollen belly.
  const scaleX = pose.bodyScaleX || 1;
  const scaleY = pose.bodyScaleY || 1;
  context.save();
  context.translate(pose.mouthX, pose.mouthY);
  context.scale(scaleX, scaleY);
  context.translate(-REST_MOUTH.x, -REST_MOUTH.y);
  silhouettePath(context, 1, 4, (x, y) => placePoint(field, x, y));
  context.clip();
  // The undisplaced painting first, then the warp over it: the warp skips any
  // cell that has not moved, on the understanding that the base layer already
  // shows it, and the base layer is now a kitchen with no creature in it.
  context.drawImage(rig.art, WARP_REGION.x * HI, WARP_REGION.y * HI, WARP_REGION.width * HI, WARP_REGION.height * HI,
    WARP_REGION.x, WARP_REGION.y, WARP_REGION.width, WARP_REGION.height);
  // One warp pass: the working copy already has the muzzle rebuilt as skin.
  drawWarped(context, rig.art, field, WARP_REGION);
  const t2 = mark();

  drawSkin(context, rig, pose, time, reduced);
  const t3 = mark();

  // The opening. During a shift it is the rules' — the exact lens a projectile
  // is tested against, carried back into the creature's own coordinates — so
  // what the player aims at is what decides a catch. Off shift it is built
  // the same way from this pose. Either way it is placed once and reused: the
  // exhale, the crackle and the teeth all sit in the mouth that was drawn.
  const shape = ruledMouth
    ? toPainting(ruledMouth, pose.mouthX, pose.mouthY, scaleX, scaleY)
    : placeAperture(apertureOf(pose, TUNING.mouthFit), bodyField(pose));
  if (DEV_HOOKS) {
    const drawn = toArena(shape, pose.mouthX, pose.mouthY, scaleX, scaleY);
    lastMouth.shape = drawn;
    lastMouth.ruled = !!ruledMouth;
    lastMouth.x = drawn.midX; lastMouth.y = drawn.midY; lastMouth.rx = drawn.halfW; lastMouth.ry = drawn.halfH;
  }
  // The body's transform undone, so what goes in the mouth is drawn in arena space.
  const inside = inMouth ? () => {
    context.save();
    context.translate(REST_MOUTH.x, REST_MOUTH.y);
    context.scale(1 / scaleX, 1 / scaleY);
    context.translate(-pose.mouthX, -pose.mouthY);
    inMouth(context);
    context.restore();
  } : null;
  drawMouth(context, rig, pose, shape, time, reduced, inside);
  drawCrackle(context, pose, shape, time, reduced);

  // Skin colour goes on before the eyes: a hungry creature loses colour in the
  // face, but its eyes are wet and stay bright, which is what carries the read.
  const t4 = mark();
  drawThroat(context, pose);
  drawEyes(context, rig, pose, field);
  drawExhale(context, pose, shape, time, reduced);
  context.restore();

  // The sill and everything below it go back on top: a creature that has
  // grown past the counter sinks behind it instead of standing on it.
  context.drawImage(rig.art, 0, SILL_Y * HI, ARENA_WIDTH * HI, (ARENA_HEIGHT - SILL_Y) * HI,
    0, SILL_Y, ARENA_WIDTH, ARENA_HEIGHT - SILL_Y);
  if (DEV_HOOKS) {
    const parts = rigParts;
    parts.field += t1 - t0;
    parts.warp += t2 - t1;
    parts.skin += t3 - t2;
    parts.mouth += t4 - t3;
    parts.face += mark() - t4;
  }
}
