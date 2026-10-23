/**
 * The body warp.
 *
 * The creature is never cut out of the painting. Instead a smooth displacement
 * field, built from the pose, is applied to a patch of the picture around it
 * and decays to nothing before it reaches the counter or the frame — so there
 * is no cut edge anywhere, and the kitchen geometry stays put.
 */
import { HI } from "./anatomy";
import { bodyField } from "../../game/body";
import type { CreaturePose } from "./pose";
import { DEV_HOOKS, frameCells } from "../../dev/hook";

/**
 * The rectangle of the picture the field is allowed to touch.
 *
 * Widened upward and to the left so a grown creature can actually rise and lean
 * over the counter. The region only bounds where cells are *drawn*; the kernels
 * that displace them are unchanged, and both die to zero well inside the new
 * edges, so nothing new is stretched. The cell count is unchanged too, which is
 * what the draw costs — a larger region at the same count means slightly
 * coarser cells, not more of them.
 */
export const WARP_REGION = { x: 470, y: 6, width: 674, height: 508 };
// Denser than it needs to be for the displacement itself: each cell is drawn
// under one affine transform, and a coarse grid makes that approximation
// visible as tile edges wherever the field compresses hard.
// Put back to 38x30 after a critic found hard-edged rectangular tearing on an
// inflated belly at 34x27: the draw is priced per cell, so a wider region at the
// same count was free, but a *smaller* count is not free where the field's
// gradient is steep, and the balloon's swell is the steepest thing in it.
// Previously reduced from 38x30 when the region was widened so the creature
// could loom.
// The draw cost is per cell, so a wider region at the same count is free and a
// smaller count is a saving; what a coarser grid costs is fidelity where the
// field's gradient is steep, which is the balloon inflation and the jaw. Both
// were checked at full size for tile edges and streaking after this change.
//
// 29x23 was tried and rejected: an inflated, lifted belly tore into hard
// rectangular seams down the right flank and streaked where the body meets the
// counter — the same failure a critic caught at 34x27 earlier, and the reason
// the grid went back up then. 32x25 is clean on that pose and is where this
// stops. The remaining cost is the floor of this architecture.
//
// 32x25 after the warp was measured properly for the first time: about 590 of
// the grid's cells are redrawn every frame in every state, each one a
// transformed drawImage costing around five microseconds, and roughly a fifth of
// them take a save/clip/restore path on top of that. The grid is the floor cost
// of the whole renderer — 3.4 ms of a 4 ms budget — and it is paid whether or
// not anything has mutated.
const CELLS_X = 32;
const CELLS_Y = 25;
/**
 * Sub-pixel displacement a cell may have and still be left as the base drew it.
 *
 * 0.34 px drew about 600 of the grid's 980 cells in every state, and each drawn
 * cell is a transformed `drawImage`. Three quarters of a pixel is still below
 * what a resample can show and below one device pixel at the 960 px resolution
 * the game is judged at, and a skipped cell is not a hole — it is the base layer
 * the rig already drew, offset by less than a pixel from where the warp wanted
 * it. Checked for tile edges on an inflated belly and a wide-open jaw, which are
 * the two steepest gradients in the field.
 */
const SKIP = 0.75;
/** How far the chin travels between a wide-open and a closed mouth. The rules own it now. */
export { JAW_TRAVEL } from "../../game/body";

const bump = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) => {
  const nx = (x - cx) / rx;
  const ny = (y - cy) / ry;
  const d = nx * nx + ny * ny;
  if (d >= 1) return 0;
  const t = 1 - d;
  return t * t;
};

export interface WarpField {
  (x: number, y: number, out: { x: number; y: number }): void;
}

/**
 * The full body warp: the rules' part — head, body, chin, swallow, cheeks,
 * the part that can move the mouth — plus the renderer's own, the shake and
 * the antennae. The rules' part is `bodyField` in `lib/game/body.ts`, shared so
 * the skin around the mouth and the mouth itself are moved by one function.
 */
export function buildField(pose: CreaturePose, time: number, reduced: boolean): WarpField {
  const tremor = reduced ? 0 : pose.shake * 1.7;
  const tremorX = tremor * Math.sin(time * 47.3);
  const tremorY = tremor * Math.sin(time * 39.1 + 1.7);
  const body = bodyField(pose, tremorX, tremorY);
  const antennae = Math.abs(pose.antennaDroop) > 0.01 || Math.abs(pose.antennaTwist) > 0.01 || pose.antennaShake > 0.01;

  return (x, y, out) => {
    body(x, y, out);
    if (!antennae) return;
    // Antennae: droop outward and down when the belly is empty. Measured off
    // the painting: the antennae occupy roughly y 100-155. The kernel's
    // travel is small and spread wide, because thirty pixels of displacement
    // across a forty-eight pixel radius chips the stalks.
    const stalk = bump(x, y, 848, 116, 168, 78);
    if (stalk > 0) {
      // A smooth fan outward, not Math.sign: a step across the centre line
      // folds the cells there and duplicates the antennae.
      const fan = Math.max(-1, Math.min(1, (x - 848) / 96));
      out.y += pose.antennaDroop * 12 * stalk;
      out.x += fan * pose.antennaDroop * 8 * stalk;
      // Twist tips one antenna up and the other down.
      out.y += fan * pose.antennaTwist * 9 * stalk;
      if (!reduced) out.x += Math.sin(time * 21 + x * 0.05) * pose.antennaShake * 2.6 * stalk;
    }
  };
}

const probe = { x: 0, y: 0 };
const found = { x: 0, y: 0 };

/**
 * Where the painted point `(x, y)` ends up on screen.
 *
 * `drawWarped` is a backward map: for each destination pixel it samples the
 * source at `destination - field(destination)`. So the displacement that moves
 * a painted feature is the field evaluated at the feature's *destination*, not
 * at the feature itself. Reading the field at the source is only correct where
 * it is locally constant; wherever it has a gradient — which is everywhere the
 * body is actually deforming — the two disagree by roughly `d · ∂d`, and that
 * error is what left the eyelids hanging above eyes that had moved further down
 * the face than the lids did.
 *
 * So invert it. `q - field(q) = p` converges in a couple of steps for any field
 * gentle enough to draw without folding, which is the same condition the grid
 * already has to satisfy.
 */
function inverseAt(field: WarpField, x: number, y: number, out: { x: number; y: number }) {
  let qx = x;
  let qy = y;
  for (let step = 0; step < 3; step++) {
    field(qx, qy, probe);
    qx = x + probe.x;
    qy = y + probe.y;
  }
  out.x = qx;
  out.y = qy;
}

/** Where a painted point ends up, for placing a part corner by corner. */
export function placePoint(field: WarpField, x: number, y: number) {
  inverseAt(field, x, y, found);
  return { x: found.x, y: found.y };
}

/** Local translation and scale of the field at a point, for placing a part. */
export function localTransform(field: WarpField, x: number, y: number) {
  inverseAt(field, x, y, found);
  const dx = found.x - x;
  const dy = found.y - y;
  inverseAt(field, x + 12, y, found);
  const scaleX = (found.x - (x + dx)) / 12;
  inverseAt(field, x, y + 12, found);
  const scaleY = (found.y - (y + dy)) / 12;
  // A degenerate or inverted local frame would mirror the part it places.
  return { dx, dy, scaleX: Math.max(0.35, scaleX), scaleY: Math.max(0.35, scaleY) };
}

/**
 * Redraws the warped region as a grid of cells.
 *
 * Each cell is drawn under its own affine transform fitted to the cell's three
 * displaced corners, so the mapping stays continuous across cell borders. A
 * per-cell axis-aligned rectangle would turn a smoothly varying displacement
 * into a visible staircase.
 */
export function drawWarped(context: CanvasRenderingContext2D, source: HTMLCanvasElement,
                           field: WarpField, region = WARP_REGION,
                           origin = { x: 0, y: 0 }, cellsX = CELLS_X, cellsY = CELLS_Y) {
  const stepX = region.width / cellsX;
  const stepY = region.height / cellsY;
  const point = { x: 0, y: 0 };
  const gridX = new Float64Array((cellsX + 1) * (cellsY + 1));
  const gridY = new Float64Array((cellsX + 1) * (cellsY + 1));
  for (let row = 0; row <= cellsY; row++) {
    const y = region.y + row * stepY;
    for (let column = 0; column <= cellsX; column++) {
      const x = region.x + column * stepX;
      field(x, y, point);
      const index = row * (cellsX + 1) + column;
      gridX[index] = x - point.x;
      gridY[index] = y - point.y;
    }
  }
  // Cell transforms compose with whatever transform the scene already set.
  const base = context.getTransform();
  const A = base.a, B = base.b, C = base.c, D = base.d, E = base.e, F = base.f;
  // Keep the sampled grid monotone. A displacement gradient steeper than the
  // grid spacing would invert a cell, and an inverted cell smears its source
  // across the frame; clamping here removes the failure at its source.
  const minX = stepX * 0.2;
  const minYStep = stepY * 0.2;
  for (let row = 0; row <= cellsY; row++) {
    const base0 = row * (cellsX + 1);
    for (let column = 1; column <= cellsX; column++) {
      const at = base0 + column;
      if (gridX[at] < gridX[at - 1] + minX) gridX[at] = gridX[at - 1] + minX;
    }
  }
  for (let column = 0; column <= cellsX; column++) {
    for (let row = 1; row <= cellsY; row++) {
      const at = row * (cellsX + 1) + column;
      const above = at - (cellsX + 1);
      if (gridY[at] < gridY[above] + minYStep) gridY[at] = gridY[above] + minYStep;
    }
  }

  const bleed = 0.8;
  // Whether the context is currently at the scene's own transform.
  let atBase = true;
  for (let row = 0; row < cellsY; row++) {
    for (let column = 0; column < cellsX; column++) {
      const at = row * (cellsX + 1) + column;
      const right = at + 1;
      const below = at + cellsX + 1;
      const ux = gridX[right] - gridX[at];
      const uy = gridY[right] - gridY[at];
      const vx = gridX[below] - gridX[at];
      const vy = gridY[below] - gridY[at];
      const det = ux * vy - uy * vx;
      if (det <= 0) continue;
      // A cell that would land within a third of a pixel of where the base
      // layer already drew it is not worth redrawing.
      //
      // The threshold used to be a twentieth of a pixel, which was effectively
      // "exactly undisplaced". That was free while the body only moved during a
      // mutation; once the creature grows continuously, the body kernel touches
      // most of the region for the whole shift and nothing was being skipped.
      // A third of a pixel is below what a resample can show and skips the
      // wide, nearly-still margin around every kernel.
      const opposite0 = below + 1;
      if (Math.abs(gridX[at] - (region.x + column * stepX)) < SKIP &&
          Math.abs(gridY[at] - (region.y + row * stepY)) < SKIP &&
          Math.abs(ux - stepX) < SKIP && Math.abs(vy - stepY) < SKIP &&
          Math.abs(uy) < SKIP && Math.abs(vx) < SKIP &&
          Math.abs(gridX[opposite0] - (region.x + (column + 1) * stepX)) < SKIP &&
          Math.abs(gridY[opposite0] - (region.y + (row + 1) * stepY)) < SKIP) { if (DEV_HOOKS) frameCells.skipped += 1; continue; }
      if (DEV_HOOKS) frameCells.count += 1;
      const m11 = stepX * vy / det;
      const m21 = -stepX * vx / det;
      const m12 = -stepY * uy / det;
      const m22 = stepY * ux / det;
      const x0 = region.x + column * stepX;
      const y0 = region.y + row * stepY;
      const tx = x0 - (m11 * gridX[at] + m21 * gridY[at]);
      const ty = y0 - (m12 * gridX[at] + m22 * gridY[at]);
      const opposite = below + 1;
      const minX = Math.min(gridX[at], gridX[right], gridX[below], gridX[opposite]) - bleed;
      const maxX = Math.max(gridX[at], gridX[right], gridX[below], gridX[opposite]) + bleed;
      const minY = Math.min(gridY[at], gridY[right], gridY[below], gridY[opposite]) - bleed;
      const maxY = Math.max(gridY[at], gridY[right], gridY[below], gridY[opposite]) + bleed;
      // The common cell has no skew in it: the field stretches and shifts it but
      // does not rotate it. That mapping is exactly what drawImage's own source
      // and destination rectangles express, so those cells are drawn under the
      // scene's transform with no transform switching at all — which, once the
      // warp was measured, turned out to be most of the cost. A cell is only
      // worth a custom transform when it actually shears.
      if (Math.abs(m21) < 1e-3 && Math.abs(m12) < 1e-3) {
        if (!atBase) { context.setTransform(base); atBase = true; }
        const dx0 = m11 * minX + tx;
        const dy0 = m22 * minY + ty;
        context.drawImage(source,
          (minX - origin.x) * HI, (minY - origin.y) * HI, (maxX - minX) * HI, (maxY - minY) * HI,
          dx0, dy0, m11 * (maxX - minX), m22 * (maxY - minY));
        continue;
      }
      // Back to the scene transform before every cell: the clip rectangle is
      // expressed in arena coordinates.
      context.setTransform(base);
      atBase = true;
      // A skewed cell's source rectangle is much larger than the cell itself,
      // and its image under the transform spills across the frame. Clip those
      // to their own cell; the common near-identity cells need no clip.
      const skewed = (maxX - minX) * (maxY - minY) > Math.abs(det) * 3;
      if (skewed) {
        if (DEV_HOOKS) frameCells.clipped += 1;
        context.save();
        context.beginPath();
        context.rect(x0 - 0.5, y0 - 0.5, stepX + 1, stepY + 1);
        context.clip();
      }
      context.setTransform(
        A * m11 + C * m12, B * m11 + D * m12,
        A * m21 + C * m22, B * m21 + D * m22,
        A * tx + C * ty + E, B * tx + D * ty + F);
      context.drawImage(source,
        (minX - origin.x) * HI, (minY - origin.y) * HI, (maxX - minX) * HI, (maxY - minY) * HI,
        minX, minY, maxX - minX, maxY - minY);
      if (skewed) context.restore();
      atBase = false;
    }
  }
  context.setTransform(base);
}
