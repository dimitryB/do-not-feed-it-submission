#!/usr/bin/env node
/**
 * Wallet choice on the real report, using inert injected provider doubles.
 * No wallet extension, signing request or transaction is used.
 *
 * node scripts/wallet-picker-check.mjs [--url http://127.0.0.1:4173]
 *   [--output /tmp/dnfi-wallet-picker]
 * Without --url, starts and stops a development server on port 4176.
 * DNFI_CHROMIUM can select an installed Chromium executable.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { CHROMIUM, settle, startDevServer, stopServer, waitForScene } from "./shot-kit.mjs";

const { values } = parseArgs({ options: { url: { type: "string" }, output: { type: "string" } } });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = values.output ? path.resolve(values.output) : null;
const PLAYER = "0x1234567890123456789012345678901234567890";
const CONTRACT = "0x909995303dBC651da54b1ab0FF75024E907039c2";
const RUN = `0x${"11".repeat(32)}`;
const TX = `0x${"22".repeat(32)}`;

async function setup(browser, url, { legacy = false, pending = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.addInitScript(({ legacy, pending, player, runId, txHash }) => {
    const qa = window.__walletQA = { calls: [], attests: 0, receipts: 0, ticketRequests: 0, mode: "resolve", resolveConnection: null };
    const provider = name => ({
      ...(name === "Brave Wallet" ? { isBraveWallet: true, isMetaMask: true } : { isMetaMask: true }),
      async request({ method }) {
        qa.calls.push({ name, method });
        if (method === "eth_requestAccounts") {
          if (qa.mode === "pending") return new Promise(resolve => { qa.resolveConnection = () => resolve([player]); });
          if (qa.mode === "reject") throw Object.assign(new Error("Connection rejected for regression test"), { code: 4001 });
          return [player];
        }
        if (method === "eth_chainId") return "0xa867";
        throw new Error(`Unexpected wallet request: ${method}`);
      },
    });
    const brave = provider("Brave Wallet"), metamask = provider("MetaMask");
    window.ethereum = brave;
    if (legacy) brave.providers = [brave, metamask];
    const announce = (name, rdns, uuid, announced) => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
      detail: { info: { uuid, name, rdns, icon: "data:image/svg+xml," }, provider: announced },
    }));
    qa.announceMetaLater = () => {
      // MetaMask can inject after Brave and after the old 250 ms collection cap.
      window.setTimeout(() => {
        announce("MetaMask", "io.metamask", "22222222-2222-4222-8222-222222222222", metamask);
        announce("MetaMask", "io.metamask", "22222222-2222-4222-8222-222222222222", metamask);
        window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: null, provider: {} } }));
      }, 500);
    };
    if (!legacy) window.addEventListener("eip6963:requestProvider", () => {
      announce("Brave Wallet", "com.brave.wallet", "11111111-1111-4111-8111-111111111111", brave);
    });
    window.__dnfi = { ledgerDeps: {
      async attest() { qa.attests++; throw new Error("Wallet picker check stops before signing"); },
      async waitForReceipt() { qa.receipts++; return null; },
      async sign() { throw new Error("Wallet picker check must not sign"); },
      async send() { throw new Error("Wallet picker check must not send"); },
    } };
    if (pending) sessionStorage.setItem("dnfi-ledger-filing", JSON.stringify({ runId, txHash, player, status: "pending", blockNumber: null, sentAt: Math.floor(Date.now() / 1000) }));
  }, { legacy, pending, player: PLAYER, runId: RUN, txHash: TX });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
  await page.route("**/api/chain/config", route => route.fulfill({ json: {
    enabled: true, chainId: 43111, contractAddress: CONTRACT, explorerUrl: "https://explorer.hemi.xyz", rpcUrl: "http://127.0.0.1:1",
    gameVersion: 11, epochSeconds: 86400, ticketSeconds: 2400,
  } }));
  await page.route("**/api/chain/world", route => route.fulfill({ json: {
    epoch: 0, epochSeconds: 86400, genesis: Math.floor(Date.now() / 1000), sourceEpoch: null, inherited: 0,
    pile: { current: {}, previous: {}, allTime: {} }, top: [], epochs: [], updatedAt: Date.now(), stale: false,
  } }));
  await page.route("**/api/chain/ticket", async route => {
    await page.evaluate(() => window.__walletQA.ticketRequests++);
    const now = Math.floor(Date.now() / 1000);
    await route.fulfill({ json: { runId: RUN, seed: 7, issuedAt: now, expiresAt: now + 2400, epoch: 0, sourceEpoch: null, inherited: 0,
      snapshotHash: `0x${"33".repeat(32)}`, snapshot: { btc: "0", eth: "0", hemi: "0", runs: "0", dominant: 0 } } });
  });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__dnfi?.play));
  await waitForScene(page);
  return { context, page, errors };
}

async function report(page) {
  await page.evaluate(() => window.__dnfi.play.manual(true));
  await page.getByRole("button", { name: /^Start your shift/ }).click();
  await page.waitForFunction(() => Boolean(window.__dnfi.play.state()));
  await page.evaluate(() => { window.__dnfi.play.step(43200); window.__dnfi.play.manual(false); });
  await page.waitForFunction(() => document.querySelector(".ledger")?.dataset.ledger === "ready");
}

const chooser = page => page.getByRole("dialog", { name: "Choose a wallet" });
const qa = page => page.evaluate(() => ({ calls: window.__walletQA.calls, attests: window.__walletQA.attests, receipts: window.__walletQA.receipts, ticketRequests: window.__walletQA.ticketRequests }));
const open = async (page, retry = false) => {
  await page.getByRole("button", { name: retry ? "Retry" : "File this shift on Hemi", exact: true }).click();
  await chooser(page).waitFor();
};

async function checkChoice(browser, url, legacy) {
  const { context, page, errors } = await setup(browser, url, { legacy });
  try {
    await report(page);
    await open(page);
    if (!legacy) {
      await chooser(page).getByRole("button", { name: "Brave Wallet", exact: true }).waitFor();
      assert.equal(await chooser(page).getByRole("button", { name: "MetaMask", exact: true }).count(), 0);
      await page.evaluate(() => window.__walletQA.announceMetaLater());
    }
    await chooser(page).getByRole("button", { name: "MetaMask", exact: true }).waitFor();
    assert.equal(await chooser(page).getByRole("button", { name: "MetaMask", exact: true }).count(), 1, "duplicate announcements must not duplicate MetaMask");
    await chooser(page).getByRole("button", { name: "Brave Wallet", exact: true }).waitFor();
    assert.deepEqual((await qa(page)).calls, [], "discovery and opening the chooser must not request wallet access");
    if (output) await chooser(page).screenshot({ path: path.join(output, legacy ? "legacy-choices.png" : "wallet-choices.png") });
    if (!legacy) {
      await page.setViewportSize({ width: 390, height: 844 });
      await settle(page, 2);
      const layout = await chooser(page).evaluate(element => {
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
      });
      assert(layout.x >= 0 && layout.y >= 0 && layout.right <= layout.viewportWidth + 1 && layout.bottom <= layout.viewportHeight + 1, "phone chooser must fit the viewport");
      assert(layout.scrollWidth <= layout.clientWidth + 1, "phone chooser must not overflow horizontally");
      if (output) await chooser(page).screenshot({ path: path.join(output, "wallet-choices-phone.png") });
      await page.setViewportSize({ width: 1366, height: 900 });
    }
    const before = await qa(page);
    await chooser(page).focus();
    await page.keyboard.press("r");
    await page.keyboard.press("Space");
    await settle(page, 2);
    assert.equal((await qa(page)).ticketRequests, before.ticketRequests, "chooser keystrokes must not restart the shift");
    assert.equal(await chooser(page).count(), 1);
    await page.keyboard.press("Escape");
    await chooser(page).waitFor({ state: "hidden" });
    assert.deepEqual((await qa(page)).calls, [], "closing the chooser must not connect");
    await open(page);
    await chooser(page).getByRole("button", { name: "MetaMask", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".ledger")?.dataset.ledger === "failed");
    let seen = await qa(page);
    assert(seen.calls.some(call => call.name === "MetaMask" && call.method === "eth_requestAccounts"));
    assert.equal(seen.calls.filter(call => call.name === "Brave Wallet").length, 0, "MetaMask choice must never call Brave");
    assert.equal(seen.attests, 1, "the explicitly selected provider reaches the verifier");

    await page.evaluate(() => { window.__walletQA.mode = "reject"; });
    await open(page, true);
    await chooser(page).getByRole("button", { name: "MetaMask", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".ledger")?.dataset.ledger === "failed");
    assert.equal((await qa(page)).attests, 1, "rejected connection must not attest");

    await page.evaluate(() => { window.__walletQA.mode = "pending"; });
    await open(page, true);
    await chooser(page).getByRole("button", { name: "MetaMask", exact: true }).click();
    await page.waitForFunction(() => Boolean(window.__walletQA.resolveConnection));
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.evaluate(() => window.__walletQA.resolveConnection());
    await settle(page, 4);
    assert.equal(await page.locator(".ledger").getAttribute("data-ledger"), "ready", "cancelled connection must remain cancelled after its late answer");
    assert.equal((await qa(page)).attests, 1, "late connection after cancellation must not attest");
    assert.deepEqual(errors, [], "no browser or scene errors");
    console.log(`${legacy ? "legacy provider array" : "late EIP-6963 announcement"}: PASS (explicit MetaMask, no Brave calls, cancel, retry, keyboard containment)`);
  } finally { await context.close(); }
}

async function checkResume(browser, url) {
  const { context, page, errors } = await setup(browser, url, { pending: true });
  try {
    await page.waitForFunction(() => window.__walletQA.receipts > 0);
    assert.deepEqual((await qa(page)).calls, [], "pending receipt resume must not connect a wallet");
    assert.equal(await chooser(page).count(), 0, "pending receipt resume must not open the chooser");
    assert.deepEqual(errors, []);
    console.log("pending receipt resume: PASS (no chooser or wallet request)");
  } finally { await context.close(); }
}

let server;
let browser;
try {
  if (output) await mkdir(output, { recursive: true });
  if (!values.url) server = await startDevServer(root, 4176);
  const url = values.url ?? server.url;
  browser = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) });
  await checkChoice(browser, url, false);
  await checkChoice(browser, url, true);
  await checkResume(browser, url);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) await stopServer(server.child);
}
