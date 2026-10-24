/**
 * A bounded Canvas 2D blur that also works when `context.filter` is absent.
 *
 * Safari currently exposes no Canvas 2D filters by default. Assigning `filter`
 * there merely creates an ordinary JavaScript property, so a property check
 * after drawing is not a capability test. Probe real pixel spread once, then
 * keep the native path on engines that implement it.
 *
 * The fallback uses a small downsample/upsample pyramid. All work stays in
 * canvas surfaces: animated rims and shadows never read pixels back each frame.
 * Nothing allocates or touches the DOM until the first call.
 */
export interface PaintBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Surface {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
}

interface Workspace {
  surfaces: Surface[];
  busy: boolean;
}

let nativeBlur: boolean | null = null;
const workspaces: Workspace[] = [];
const MAX_EDGE = 1536;
const MAX_PIXELS = 1024 * 1024;

function makeSurface(): Surface {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas blur: 2D context unavailable");
  return { canvas, context };
}

function supportsNativeBlur(): boolean {
  if (nativeBlur !== null) return nativeBlur;
  const { canvas, context } = makeSurface();
  canvas.width = 9;
  canvas.height = 9;
  // Check a fresh context, before any code can leave an expando `filter` on it.
  if (typeof context.filter !== "string") return (nativeBlur = false);
  context.filter = "blur(1px)";
  context.fillStyle = "#fff";
  context.fillRect(4, 4, 1, 1);
  try {
    nativeBlur = context.getImageData(3, 4, 1, 1).data[3] > 0;
  } catch {
    nativeBlur = false;
  }
  return nativeBlur;
}

/** Grow in buckets instead of reallocating a surface as a mouth moves a pixel. */
function surfaceAt(workspace: Workspace, index: number, width: number, height: number): Surface {
  const surface = workspace.surfaces[index] ?? (workspace.surfaces[index] = makeSurface());
  const capacityWidth = Math.ceil(width / 32) * 32;
  const capacityHeight = Math.ceil(height / 32) * 32;
  if (surface.canvas.width < capacityWidth) surface.canvas.width = capacityWidth;
  if (surface.canvas.height < capacityHeight) surface.canvas.height = capacityHeight;
  const context = surface.context;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  // Only the active rectangle is sampled. Clear one bilinear border as well,
  // so a large rig bake cannot make every later tiny lip effect clear a whole
  // megapixel surface, or leak old pixels just outside its source rectangle.
  context.clearRect(0, 0, width + 2, height + 2);
  context.imageSmoothingEnabled = true;
  // Use bilinear sampling at each step: the repeated tent kernels are what
  // soften the image. A high-quality resampler can instead preserve sharpness.
  context.imageSmoothingQuality = "low";
  return surface;
}

function copyPaintState(from: CanvasRenderingContext2D, to: CanvasRenderingContext2D): void {
  to.fillStyle = from.fillStyle;
  to.strokeStyle = from.strokeStyle;
  to.lineWidth = from.lineWidth;
  to.lineCap = from.lineCap;
  to.lineJoin = from.lineJoin;
  to.miterLimit = from.miterLimit;
  to.lineDashOffset = from.lineDashOffset;
  to.setLineDash(from.getLineDash());
  to.font = from.font;
  to.textAlign = from.textAlign;
  to.textBaseline = from.textBaseline;
  to.direction = from.direction;
}

/**
 * Paint a soft shape inside local-space `bounds`, including its stroke extent.
 * `radius` has the same device-pixel units as native `filter: blur(...)`; it is
 * independent of the current transform. The callback configures paint styles
 * and draws geometry on the supplied context. Keep alpha, clipping, transforms
 * and compositing on the outer context; they apply once to the finished layer.
 *
 * Native and fallback paths both preserve the outer context's drawing state.
 * The fallback approximates a Gaussian with bilinear pyramid kernels, and caps
 * intermediate resolution so a soft full-canvas mask cannot exhaust memory.
 */
export function paintBlurred(context: CanvasRenderingContext2D, radius: number,
                             bounds: PaintBounds, paint: (layer: CanvasRenderingContext2D) => void): void {
  if (!(radius > 0) || supportsNativeBlur()) {
    context.save();
    try {
      if (radius > 0) context.filter = `blur(${radius}px)`;
      paint(context);
    } finally {
      context.restore();
    }
    return;
  }

  const transform = context.getTransform();
  const x1 = bounds.x, y1 = bounds.y;
  const x2 = x1 + bounds.width, y2 = y1 + bounds.height;
  const xs = [transform.a * x1 + transform.c * y1 + transform.e,
    transform.a * x2 + transform.c * y1 + transform.e,
    transform.a * x1 + transform.c * y2 + transform.e,
    transform.a * x2 + transform.c * y2 + transform.e];
  const ys = [transform.b * x1 + transform.d * y1 + transform.f,
    transform.b * x2 + transform.d * y1 + transform.f,
    transform.b * x1 + transform.d * y2 + transform.f,
    transform.b * x2 + transform.d * y2 + transform.f];
  const pad = Math.ceil(radius * 3) + 2;
  // Intersect with the backing canvas before allocating. No blur contribution
  // beyond this padded area can reach a visible destination pixel.
  const left = Math.max(-pad, Math.floor(Math.min(...xs)) - pad);
  const top = Math.max(-pad, Math.floor(Math.min(...ys)) - pad);
  const right = Math.min(context.canvas.width + pad, Math.ceil(Math.max(...xs)) + pad);
  const bottom = Math.min(context.canvas.height + pad, Math.ceil(Math.max(...ys)) + pad);
  const width = right - left, height = bottom - top;
  if (!(width > 0 && height > 0)) return;
  const resolution = Math.min(1, MAX_EDGE / width, MAX_EDGE / height, Math.sqrt(MAX_PIXELS / (width * height)));
  const pixelWidth = Math.max(1, Math.ceil(width * resolution));
  const pixelHeight = Math.max(1, Math.ceil(height * resolution));
  const scaleX = pixelWidth / width, scaleY = pixelHeight / height;
  let workspace = workspaces.find((candidate) => !candidate.busy);
  if (!workspace) {
    workspace = { surfaces: [], busy: false };
    workspaces.push(workspace);
  }
  workspace.busy = true;
  try {
    const source = surfaceAt(workspace, 0, pixelWidth, pixelHeight);
    const layer = source.context;
    copyPaintState(context, layer);
    layer.save();
    layer.setTransform(transform.a * scaleX, transform.b * scaleY,
      transform.c * scaleX, transform.d * scaleY,
      (transform.e - left) * scaleX, (transform.f - top) * scaleY);
    try {
      paint(layer);
    } finally {
      layer.restore();
    }

    const sizes = [{ width: pixelWidth, height: pixelHeight }];
    // A full down/up pyramid has overlapping tent kernels with a standard
    // deviation near half its final sample spacing. Fractional last steps keep
    // softness continuous as the requested radius changes.
    let reduction = Math.max(1, radius * Math.min(scaleX, scaleY) * 1.8);
    let index = 0;
    while (reduction > 1.01) {
      const previous = sizes[index];
      const step = Math.min(2, reduction);
      const nextWidth = Math.max(1, Math.round(previous.width / step));
      const nextHeight = Math.max(1, Math.round(previous.height / step));
      if (nextWidth === previous.width && nextHeight === previous.height) break;
      const next = surfaceAt(workspace, index + 1, nextWidth, nextHeight);
      next.context.drawImage(workspace.surfaces[index].canvas, 0, 0, previous.width, previous.height,
        0, 0, nextWidth, nextHeight);
      sizes.push({ width: nextWidth, height: nextHeight });
      index++;
      reduction /= step;
    }
    for (; index > 0; index--) {
      const smaller = sizes[index], larger = sizes[index - 1];
      const next = surfaceAt(workspace, index - 1, larger.width, larger.height);
      next.context.drawImage(workspace.surfaces[index].canvas, 0, 0, smaller.width, smaller.height,
        0, 0, larger.width, larger.height);
    }
    context.save();
    try {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(source.canvas, 0, 0, pixelWidth, pixelHeight, left, top, width, height);
    } finally {
      context.restore();
    }
  } finally {
    workspace.busy = false;
  }
}
