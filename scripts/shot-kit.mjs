/**
 * Shared browser plumbing for the review harnesses.
 *
 * `creature-shots.mjs` (rig review) and `loop-shots.mjs` (gameplay review) both
 * boot the dev server, drive the page through the development hooks and build
 * strips and contact sheets out of captured frames. That plumbing lives here so
 * the two harnesses cannot drift apart on how a capture is taken, downscaled or
 * labelled — only on what they choose to capture.
 *
 * Nothing here is shipped: it is imported by scripts only.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/**
 * Prefer an explicitly configured browser, then the preinstalled one used by
 * the cloud workspace, and otherwise let Playwright resolve whatever
 * `npx playwright install chromium` put in its own cache — which is what
 * happens on a developer machine.
 */
export const CHROMIUM = process.env.DNFI_CHROMIUM
  ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

export const WIDTH = 1920;
export const HEIGHT = 1080;
export const STREAM_WIDTH = 960;

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Collects every script error and console error the page raises, so a capture
 * of a broken frame fails the run instead of filming a frozen canvas behind
 * an error overlay. Call `report(tag)` at the end: it prints them and sets a
 * failing exit code.
 */
export function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  return {
    errors,
    report(tag) {
      // Asset 404s in a dev server are noise; script errors are not.
      const real = errors.filter((text) => !/Failed to load resource/.test(text));
      if (!real.length) return true;
      console.error(`[${tag}] ${real.length} page error(s):`);
      for (const text of [...new Set(real)].slice(0, 20)) console.error(`  ${text}`);
      process.exitCode = 1;
      return false;
    },
  };
}

export async function stopServer(child) {
  // SIGTERM alone does not do it. The dev server spawns a workerd child that
  // ignores it, and every harness run was leaving a server and a workerd behind
  // holding half a gigabyte each: seven stale pairs had accumulated before this
  // was noticed, and every render measurement taken while they were up was
  // competing with them for the machine. Terminate the group, wait, then kill
  // whatever is still standing.
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  await wait(900);
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
  await wait(200);
}

export async function startDevServer(root, port) {
  // Detached, so the whole process group can be torn down: the dev server
  // spawns a workerd child that survives a plain kill on the npm wrapper.
  const child = spawn("npm", ["run", "dev", "--", "--port", String(port), "--strictPort"], {
    cwd: root,
    env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Dev server exited early:\n${log}`);
    try {
      const response = await fetch(url);
      if (response.ok) { await response.text(); return { child, url }; }
    } catch { /* not listening yet */ }
    await wait(500);
  }
  await stopServer(child);
  throw new Error(`Dev server did not start in time:\n${log}`);
}

export async function settle(page, frames = 3) {
  await page.evaluate(async (count) => {
    for (let i = 0; i < count; i += 1) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }, frames);
}

/** Waits until the scene's source art has decoded, so no capture is half-drawn. */
export async function waitForScene(page) {
  await page.waitForFunction(() => {
    const hook = window.__dnfi;
    return Boolean(hook && typeof hook.sceneReady === "function" && hook.sceneReady());
  }, null, { timeout: 60_000 });
}

export async function capture(page, file, frames = 3) {
  await settle(page, frames);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
}

/** Downscales a capture to stream width in the browser, where the resampler lives. */
const mimeOf = (file) => (file.endsWith(".jpg") || file.endsWith(".jpeg") ? "image/jpeg" : "image/png");

export async function makeStreamCopies(page, files, width = STREAM_WIDTH) {
  for (const file of files) {
    const source = `data:${mimeOf(file)};base64,${(await readFile(file)).toString("base64")}`;
    const encoded = await page.evaluate(async ({ source: src, width: to }) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const scale = to / image.naturalWidth;
      const canvas = document.createElement("canvas");
      canvas.width = to;
      canvas.height = Math.round(image.naturalHeight * scale);
      const context = canvas.getContext("2d");
      context.imageSmoothingQuality = "medium";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png").split(",")[1];
    }, { source, width });
    await writeFile(file.replace(/\.(png|jpe?g)$/, "-stream.png"), Buffer.from(encoded, "base64"));
  }
}

/**
 * Joins frames left to right so motion reads as a filmstrip. `labels` is one
 * caption per frame; a gameplay strip captions the game state, a pose strip
 * captions the elapsed time.
 */
export async function buildStrip(page, frames, outFile, labels, cell = 460) {
  const sources = [];
  for (const frame of frames) sources.push(`data:${mimeOf(frame)};base64,${(await readFile(frame)).toString("base64")}`);
  const encoded = await page.evaluate(async ({ sources: srcs, cell: width, labels: captions }) => {
    const images = [];
    for (const source of srcs) {
      const image = new Image();
      image.src = source;
      await image.decode();
      images.push(image);
    }
    const height = Math.round(width * images[0].naturalHeight / images[0].naturalWidth);
    const canvas = document.createElement("canvas");
    canvas.width = width * images.length;
    canvas.height = height + 26;
    const context = canvas.getContext("2d");
    context.fillStyle = "#05100f";
    context.fillRect(0, 0, canvas.width, canvas.height);
    images.forEach((image, index) => {
      context.drawImage(image, index * width, 26, width, height);
      context.fillStyle = "#c9d9a8";
      context.font = "600 15px ui-monospace, monospace";
      context.fillText(captions[index] ?? "", index * width + 10, 18);
      context.strokeStyle = "#00000088";
      context.strokeRect(index * width + 0.5, 26.5, width - 1, height - 1);
    });
    return canvas.toDataURL("image/png").split(",")[1];
  }, { sources, cell, labels });
  await writeFile(outFile, Buffer.from(encoded, "base64"));
}

/** A grid of frames, for a span of play too long to read as one row. */
export async function buildGrid(page, frames, outFile, labels, columns = 4, cell = 480) {
  const sources = [];
  for (const frame of frames) sources.push(`data:${mimeOf(frame)};base64,${(await readFile(frame)).toString("base64")}`);
  const encoded = await page.evaluate(async ({ sources: srcs, columns: cols, cell: width, labels: captions }) => {
    const images = [];
    for (const source of srcs) {
      const image = new Image();
      image.src = source;
      await image.decode();
      images.push(image);
    }
    const height = Math.round(width * images[0].naturalHeight / images[0].naturalWidth);
    const rows = Math.ceil(images.length / cols);
    const canvas = document.createElement("canvas");
    canvas.width = cols * width;
    canvas.height = rows * (height + 24);
    const context = canvas.getContext("2d");
    context.fillStyle = "#05100f";
    context.fillRect(0, 0, canvas.width, canvas.height);
    images.forEach((image, index) => {
      const x = (index % cols) * width;
      const y = Math.floor(index / cols) * (height + 24);
      context.drawImage(image, x, y + 24, width, height);
      context.fillStyle = "#c9d9a8";
      context.font = "600 14px ui-monospace, monospace";
      context.fillText(captions[index] ?? "", x + 8, y + 16);
      context.strokeStyle = "#00000088";
      context.strokeRect(x + 0.5, y + 24.5, width - 1, height - 1);
    });
    return canvas.toDataURL("image/png").split(",")[1];
  }, { sources, columns, cell, labels });
  await writeFile(outFile, Buffer.from(encoded, "base64"));
}

export async function buildContactSheet(page, dir, outFile, suffix = "-stream.png", columns = 4, cell = 470) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(suffix)).sort();
  const frames = names.map((name) => path.join(dir, name));
  const labels = names.map((name) => name.replace(suffix, ""));
  if (!frames.length) return;
  await buildGrid(page, frames, outFile, labels, columns, cell);
}

/** Average/median/p95 draw cost over a few seconds of live play. */
export async function measureRenderCost(page, seed = 4242, seconds = 4, prepare = null) {
  await page.evaluate((value) => {
    window.__dnfi.clearPose?.();
    window.__dnfi.clock(null);
    window.__dnfi.play.start(value);
    window.__dnfi.play.manual(false);
  }, seed);
  if (prepare) await prepare(page);
  // Reset after preparing, so the first frames after a state change — which
  // include one JIT spike that is not a frame cost — are not counted.
  await wait(600);
  await page.evaluate(() => window.__dnfi.resetTiming());
  await wait(seconds * 1000);
  const timing = await page.evaluate(() => {
    const value = window.__dnfi.timing();
    window.__dnfi.play.stop();
    return value;
  });
  const size = await page.evaluate(() => window.__dnfi.canvasSize());
  return { ...timing, canvas: size };
}
