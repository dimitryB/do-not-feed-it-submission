#!/usr/bin/env node
/**
 * Exercise the real renderer in Chromium, Firefox and Safari's WebKit engine.
 * Needs Playwright browsers: npx playwright install chromium firefox webkit
 *
 * node scripts/browser-render-check.mjs [--browser chromium|firefox|webkit|all]
 *   [--url http://127.0.0.1:4175] [--output /tmp/dnfi-render] [--dpr 1|2]
 *   [--profile] [--headed]
 * Without --url, starts and stops its own development server on port 4175.
 * DNFI_CHROMIUM, DNFI_FIREFOX and DNFI_WEBKIT can select browser executables.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, firefox, webkit } from "playwright";
import { CHROMIUM, settle, startDevServer, stopServer, waitForScene } from "./shot-kit.mjs";

const { values } = parseArgs({ options: {
  browser: { type: "string", default: "all" },
  url: { type: "string" },
  output: { type: "string" },
  dpr: { type: "string", default: "2" },
  profile: { type: "boolean", default: false },
  headed: { type: "boolean", default: false },
} });
assert(["chromium", "firefox", "webkit", "both", "all"].includes(values.browser), "--browser must be chromium, firefox, webkit or all (both selects Chromium and WebKit)");
assert(["1", "2"].includes(values.dpr), "--dpr must be 1 or 2");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = values.output ? path.resolve(values.output) : null;

function assertFinite(value, label) {
  if (typeof value === "number") assert(Number.isFinite(value), `${label} is not finite`);
  else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) assertFinite(nested, `${label}.${key}`);
  }
}

async function checkBlur(page) {
  const result = await page.evaluate(async () => {
    const { paintBlurred } = await import("/lib/render/canvasBlur.ts");
    const make = () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 128;
      return canvas.getContext("2d");
    };
    const samples = {};
    for (const mode of ["source-over", "destination-in", "destination-out"]) {
      const ctx = make();
      if (mode !== "source-over") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 128, 128); }
      ctx.globalCompositeOperation = mode;
      paintBlurred(ctx, 6, { x: 40, y: 40, width: 48, height: 48 }, layer => {
        layer.fillStyle = "#fff";
        layer.fillRect(40, 40, 48, 48);
      });
      const alpha = (x, y) => ctx.getImageData(x, y, 1, 1).data[3];
      samples[mode] = { center: alpha(64, 64), edge: alpha(40, 64), outside: alpha(2, 2) };
    }
    const ctx = make();
    ctx.setTransform(1.2, 0.1, -0.2, 0.9, 7, 11);
    ctx.globalAlpha = 0.6;
    ctx.globalCompositeOperation = "screen";
    const state = () => ({ transform: [...["a", "b", "c", "d", "e", "f"].map(key => ctx.getTransform()[key])],
      alpha: ctx.globalAlpha, composite: ctx.globalCompositeOperation });
    const before = state();
    paintBlurred(ctx, 4, { x: 20, y: 20, width: 30, height: 30 }, layer => {
      layer.fillStyle = "#fff";
      layer.fillRect(20, 20, 30, 30);
    });
    return { samples, before, after: state(), filter: typeof make().filter };
  });
  for (const [mode, sample] of Object.entries(result.samples)) {
    assert(sample.edge > 0 && sample.edge < 255, `${mode}: blur edge must have intermediate alpha: ${JSON.stringify(sample)}`);
    assert.equal(sample.outside, mode === "destination-out" ? 255 : 0, `${mode}: transparent source must apply outside the paint bounds`);
    assert(mode === "destination-out" ? sample.center < 10 : sample.center > 245, `${mode}: mask center: ${JSON.stringify(sample)}`);
  }
  assert.deepEqual(result.after, result.before, "blur must preserve transform, alpha and compositing");
  return result.filter;
}

async function canvasStats(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector(".game-canvas");
    const sample = document.createElement("canvas");
    sample.width = 128; sample.height = 75;
    const ctx = sample.getContext("2d");
    ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
    const pixels = ctx.getImageData(0, 0, sample.width, sample.height).data;
    let min = 255, max = 0, opaque = 0, hash = 2166136261;
    for (let i = 0; i < pixels.length; i += 4) {
      const light = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
      min = Math.min(min, light); max = Math.max(max, light);
      if (pixels[i + 3] > 0) opaque++;
      for (let channel = 0; channel < 4; channel++) hash = Math.imul(hash ^ pixels[i + channel], 16777619);
    }
    return { min, max, opaque, hash: hash >>> 0, width: canvas.width, height: canvas.height };
  });
}

async function checkGameplay(page) {
  await page.evaluate(() => { const h = window.__dnfi; h.clearPose(); h.clock(null); h.reduced(null); });
  await page.getByRole("button", { name: /^Start your shift/ }).click();
  await page.waitForFunction(() => window.__dnfi.play.state()?.tick > 3);
  const launch = page.getByRole("button", { name: /^Launch/ });
  await launch.waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector(".launch-button")?.disabled);
  const commands = await page.evaluate(() => window.__dnfi.play.commands().length);
  await launch.click();
  await page.waitForFunction(count => window.__dnfi.play.commands().length > count, commands);
  await page.getByRole("button", { name: "Pause game" }).click();
  await page.getByRole("dialog").waitFor({ state: "visible" });
  await settle(page, 2);
  const paused = await page.evaluate(() => window.__dnfi.play.state().tick);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__dnfi.play.state().tick), paused, "pause must stop simulation ticks");
  await page.getByRole("button", { name: /^Back to the kitchen/ }).click();
  await page.waitForFunction(tick => window.__dnfi.play.state().tick > tick, paused);
}

/** Report costs without a hardware-dependent pass/fail threshold. */
async function profileAnimations(page, label) {
  for (const id of ["active-balloon", "active-pepper"]) {
    await page.evaluate(id => window.__dnfi.settle(id, 0.35), id);
    await page.evaluate(() => window.__dnfi.clock(null));
    await settle(page, 30);
    const timing = await page.evaluate(async () => {
      window.__dnfi.resetTiming();
      const intervals = [];
      let previous = await new Promise(resolve => requestAnimationFrame(resolve));
      for (let i = 0; i < 120; i++) {
        const now = await new Promise(resolve => requestAnimationFrame(resolve));
        intervals.push(now - previous);
        previous = now;
      }
      intervals.sort((a, b) => a - b);
      return { draw: window.__dnfi.timing(), frameMedianMs: intervals[60], frameP95Ms: intervals[114] };
    });
    console.log(`${label} ${id}: ${JSON.stringify(timing)}`);
  }
}

async function checkContext(browser, url, label, forceFallback) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: Number(values.dpr) });
  if (forceFallback) await context.addInitScript(() => {
    // Safari accepts an expando named filter while leaving pixels unfiltered.
    delete CanvasRenderingContext2D.prototype.filter;
    if (typeof OffscreenCanvasRenderingContext2D !== "undefined") delete OffscreenCanvasRenderingContext2D.prototype.filter;
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  const directory = output ? path.join(output, label) : null;
  try {
    if (directory) await mkdir(directory, { recursive: true });
    await page.goto(url, { waitUntil: "networkidle" });
    await waitForScene(page);
    const filter = await checkBlur(page);
    if (forceFallback) assert.equal(filter, "undefined", "fallback context must expose no native filter");
    const states = await page.evaluate(() => window.__dnfi.states());
    assert.equal(states.length, 25, "exercise every creature preset");
    for (const id of states) {
      await page.evaluate(id => window.__dnfi.settle(id, 0.35), id);
      await settle(page, 2);
      const frame = await page.evaluate(async () => ({ mouth: await window.__dnfi.mouthBox(), pose: window.__dnfi.poseNow() }));
      assertFinite(frame, id);
      assert(frame.mouth.rx > 0 && frame.mouth.ry >= 0, `${id}: creature mouth must render`);
      const stats = await canvasStats(page);
      assert(stats.width > 0 && stats.height > 0 && stats.opaque > 1000 && stats.max - stats.min > 30, `${id}: canvas is blank`);
      if (directory) await page.locator(".game-canvas").screenshot({ path: path.join(directory, `${id}.png`) });
    }
    await page.evaluate(() => window.__dnfi.settle("attract-idle", 0));
    await settle(page, 2);
    const first = await canvasStats(page);
    await page.evaluate(() => window.__dnfi.settle("attract-idle", 0.75));
    await settle(page, 2);
    assert.notEqual((await canvasStats(page)).hash, first.hash, "advancing the frozen animation clock must change pixels");
    if (values.profile) await profileAnimations(page, label);
    await checkGameplay(page);
    assert.deepEqual(errors, [], `${label}: browser/scene errors`);
    console.log(`${label}: PASS (DPR ${values.dpr}, blur pixels, 25 poses, animation, launch, pause/resume)`);
  } catch (error) {
    if (directory) await page.screenshot({ path: path.join(directory, "failure.png") }).catch(() => {});
    if (errors.length) console.error(`${label} browser errors:`, [...new Set(errors)]);
    throw error;
  } finally { await context.close(); }
}

let server;
try {
  if (!values.url) server = await startDevServer(root, 4175);
  const url = values.url ?? server.url;
  const engines = values.browser === "all" ? ["chromium", "firefox", "webkit"]
    : values.browser === "both" ? ["chromium", "webkit"] : [values.browser];
  for (const engine of engines) {
    const executablePath = { chromium: CHROMIUM, firefox: process.env.DNFI_FIREFOX, webkit: process.env.DNFI_WEBKIT }[engine];
    const browser = await ({ chromium, firefox, webkit }[engine]).launch({ headless: !values.headed, ...(executablePath ? { executablePath } : {}) });
    try {
      console.log(`${engine} ${browser.version()}`);
      await checkContext(browser, url, engine, false);
      if (engine === "chromium") await checkContext(browser, url, "chromium-no-filter", true);
    } finally { await browser.close(); }
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (server) await stopServer(server.child);
}
