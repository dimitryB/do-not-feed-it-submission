#!/usr/bin/env node
/**
 * The chain, end to end, unattended: a real Chromium on the real page, the
 * real Worker (the Vite dev server with the Cloudflare plugin, Miniflare's D1
 * and `.dev.vars`), a real EVM (`hardhat node`, chainId 31337) and a real
 * wallet signature — nothing in the app is mocked. Keys never enter the page:
 * the injected `window.ethereum` forwards every request to Node over a
 * Playwright bridge, where a viem local account (one of Hardhat's public test
 * keys) signs typed data and sends raw transactions to the node.
 *
 *   docs/qa/chain/e2e/
 *     NN-<what>.png     1366×768 captures: title before, report ready, filed, title after, each failure
 *     manifest.json     every shot with the Ledger's text, the on-chain numbers, the timings and the fixes
 *
 * What it proves:
 *   ticket → play → "File this shift on Hemi" → attest (server replay) → wallet signature → submitResult
 *   → receipt → FILED on the report; the result readable on chain (usedRunIds, bestScore, diet, the
 *   ResultRecorded event) and on the title (diet line, TOP KEEPERS, the resume line). Then the failure
 *   paths, live: the wallet rejecting the signature, a tampered trace, the same run filed twice
 *   (DuplicateRun), the wallet on the wrong chain, the Worker's attest rate limit — each with Retry
 *   where the design offers one.
 *
 * Usage:
 *   node --experimental-strip-types scripts/chain-e2e.mjs [--port 4333] [--out docs/qa/chain/e2e]
 *        [--keep] [--skip-rate-limit]
 *
 *   --keep             leave the node and the dev server running (for a look by hand); default: kill both
 *   --skip-rate-limit  skip the rate-limit path (it costs up to a minute of waiting for the next window)
 *
 * Needs: the preinstalled Chromium (scripts/shot-kit.mjs CHROMIUM), ports 8545 and --port free, the
 * contract artifacts (built with scripts/solc-build.mjs when missing). Everything stays on localhost.
 * An existing `.dev.vars` is moved to `.dev.vars.e2e-backup` for the run and put back at the end.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { chromium } from "playwright";
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, getAddress, http, keccak256, numberToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { playShift } from "./loop-bots.mjs";
import { GAME_VERSION } from "../lib/game/arcade.ts";
import { GAME_VERSION_ID, PILE_FILINGS_PER_EPOCH, feedRegistryAbi, inheritedOf, resultFromJson, resultTypedData, seedToBytes32, snapshotHashOf } from "../lib/chain/types.ts";
import { traceHash } from "../lib/chain/trace.ts";
import { CHROMIUM, settle, startDevServer, stopServer, wait, waitForScene } from "./shot-kit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC_PORT = 8545;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const CHAIN_ID = 31337;
const CHAIN_HEX = numberToHex(CHAIN_ID);
/** Hardhat's public test keys (hardhat node prints them); never funds, never a secret. */
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // #0, the owner
  verifier: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // #1, DNFI_VERIFIER_PRIVATE_KEY
  player: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2, the wallet
};
const VERIFIER = privateKeyToAccount(KEYS.verifier);
const PLAYER = privateKeyToAccount(KEYS.player);
/** The local D1 database the Vite config hands Miniflare (vite.config.ts: binding "DB", the placeholder id). */
const D1_ID = "00000000-0000-4000-8000-000000000000";
const D1_PERSIST = path.join(ROOT, ".wrangler", "state", "v3", "d1");
const MIGRATIONS_DIR = path.join(ROOT, "drizzle");
const DEV_VARS = path.join(ROOT, ".dev.vars");
const DEV_VARS_BACKUP = path.join(ROOT, ".dev.vars.e2e-backup");
const VIEWPORT = { width: 1366, height: 768 };

const chain = defineChain({ id: CHAIN_ID, name: "Hardhat", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ account: PLAYER, chain, transport: http(RPC) });
const json = (value, indent = 0) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), indent);
const log = (...parts) => console.log("[chain-e2e]", ...parts);
const fail = (message) => { throw new Error(message); };
const expect = (condition, message) => { if (!condition) fail(`expected ${message}`); };

function parseArgs(argv) {
  const args = { port: 4333, out: path.join("docs", "qa", "chain", "e2e"), keep: false, rateLimit: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") args.port = Number(argv[++i]);
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--keep") args.keep = true;
    else if (argv[i] === "--skip-rate-limit") args.rateLimit = false;
  }
  return args;
}

/* ------------------------------------------------------------------ *
 * The node, the contract, the Worker's environment
 * ------------------------------------------------------------------ */

async function rpc(method, params = []) {
  const response = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const answer = await response.json();
  if (answer.error) { const e = new Error(answer.error.message); e.code = answer.error.code; e.data = answer.error.data; throw e; }
  return answer.result;
}

async function portAnswers(url) {
  try { await fetch(url, { method: "POST", body: "{}" }); return true; } catch { return false; }
}

/** `npx hardhat node`: automine, one block per transaction, wall-clock timestamps. Detached so the group can be torn down. */
async function startNode() {
  if (await portAnswers(RPC)) fail(`something already answers on ${RPC}; stop it first (the e2e wants a fresh chain)`);
  const child = spawn("npx", ["hardhat", "node", "--chain-id", String(CHAIN_ID), "--port", String(RPC_PORT)], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, FORCE_COLOR: "0" } });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`hardhat node exited early:\n${out}`);
    try { if ((await rpc("eth_chainId")) === CHAIN_HEX) return child; } catch { /* not yet */ }
    await wait(500);
  }
  fail(`hardhat node did not answer in time:\n${out}`);
}

/** scripts/deploy-registry.ts on Hardhat 3's built-in `localhost` network (http://localhost:8545, the node's unlocked accounts). */
function deployRegistry() {
  if (!existsSync(path.join(ROOT, "artifacts", "contracts", "FeedRegistry.sol", "FeedRegistry.json"))) {
    log("no artifacts; building with solc-js");
    const build = spawnSync("node", ["scripts/solc-build.mjs"], { cwd: ROOT, stdio: "inherit" });
    if (build.status !== 0) fail("solc-build failed");
  }
  const run = spawnSync("npx", ["hardhat", "run", "scripts/deploy-registry.ts", "--network", "localhost", "--no-compile"], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, DNFI_VERIFIER_ADDRESS: VERIFIER.address, FORCE_COLOR: "0" },
  });
  if (run.status !== 0) fail(`deploy-registry failed:\n${run.stdout}\n${run.stderr}`);
  const address = /FeedRegistry\s+(0x[0-9a-fA-F]{40})/.exec(run.stdout)?.[1];
  const block = /deploy block\s+(\d+)/.exec(run.stdout)?.[1];
  const genesis = /GENESIS\s+(\d+)/.exec(run.stdout)?.[1];
  const gas = /gas used\s+(\d+)/.exec(run.stdout)?.[1];
  if (!address || !block) fail(`could not read the address and block from deploy-registry's output:\n${run.stdout}`);
  return { address: getAddress(address), deployBlock: Number(block), genesis: Number(genesis), deployGas: Number(gas), output: run.stdout };
}

/**
 * Every `drizzle/*.sql` not yet applied, in order, onto the Vite plugin's persisted D1, recorded in
 * Wrangler's own `d1_migrations` table (the one `wrangler d1 migrations apply --local` keeps), then a
 * clean slate for a fresh chain. A D1 prepared by an older e2e (before the table existed) is
 * recognised by what the first two migrations created, so they are not applied twice.
 */
async function prepareD1(contractAddress) {
  const miniflare = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Persist: D1_PERSIST, d1Databases: { DB: D1_ID } });
  try {
    const db = await miniflare.getD1Database("DB");
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    await db.prepare("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
    const recorded = new Set((await db.prepare("SELECT name FROM d1_migrations").all()).results.map((r) => r.name));
    if (recorded.size === 0) {
      const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map((r) => r.name);
      const columns = tables.includes("dnfi_run_tickets") ? (await db.prepare("PRAGMA table_info(dnfi_run_tickets)").all()).results.map((r) => r.name) : [];
      const legacy = [tables.includes("dnfi_run_tickets") && "0000_dnfi_chain_state.sql", columns.includes("result_json") && "0001_dnfi_chain_v1.sql"].filter(Boolean);
      for (const name of legacy) { await db.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)").bind(name).run(); recorded.add(name); }
    }
    const applied = [];
    for (const file of files) {
      if (recorded.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) if (statement.trim()) await db.prepare(statement).run();
      await db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(file).run();
      applied.push(file);
    }
    // A fresh node is a fresh chain: the cached world for this chain id and any old tickets or counters would lie.
    await db.prepare("DELETE FROM dnfi_leaderboard_snapshots WHERE chain_id = ?").bind(CHAIN_ID).run();
    await db.prepare("DELETE FROM dnfi_run_tickets").run();
    await db.prepare("DELETE FROM dnfi_rate_limits").run();
    return { applied, persist: path.relative(ROOT, D1_PERSIST), contractAddress };
  } finally {
    await miniflare.dispose();
  }
}

async function writeDevVars(contractAddress, deployBlock, extra = [], { backupOriginal = true } = {}) {
  let hadOwn = false;
  // Only the first write owns the original file. Later epoch rewrites contain generated test settings.
  if (backupOriginal) {
    if (existsSync(DEV_VARS) && !existsSync(DEV_VARS_BACKUP)) { await copyFile(DEV_VARS, DEV_VARS_BACKUP); hadOwn = true; }
    else if (existsSync(DEV_VARS_BACKUP)) hadOwn = true;
  }
  await writeFile(DEV_VARS, [
    "# written by scripts/chain-e2e.mjs for one run; the previous file (if any) is .dev.vars.e2e-backup",
    `HEMI_RPC_URL=${RPC}`,
    `DNFI_PUBLIC_RPC_URL=${RPC}`,
    `DNFI_CHAIN_ID=${CHAIN_ID}`,
    `DNFI_CONTRACT_ADDRESS=${contractAddress}`,
    `DNFI_VERIFIER_PRIVATE_KEY=${KEYS.verifier}`,
    `DNFI_DEPLOY_BLOCK=${deployBlock}`,
    // Hardhat automines one block per transaction and never reorgs; the board must show a filing at once.
    "DNFI_CONFIRMATIONS=0",
    ...extra,
    "",
  ].join("\n"));
  return async () => {
    if (hadOwn) { await copyFile(DEV_VARS_BACKUP, DEV_VARS); await rm(DEV_VARS_BACKUP, { force: true }); } else await rm(DEV_VARS, { force: true });
  };
}

/* ------------------------------------------------------------------ *
 * The wallet: an EIP-1193 provider in the page, the key in Node
 * ------------------------------------------------------------------ */

/** Installed before the page's scripts run; every request crosses the bridge. Announces over EIP-6963 too, so discovery is exercised. */
const PROVIDER_SCRIPT = (address) => `
  (() => {
    const provider = {
      isDnfiE2E: true,
      on() {}, removeListener() {},
      async request({ method, params }) {
        const answer = await window.__e2eWallet(method, JSON.stringify(params ?? []));
        if (answer.error) { const e = new Error(answer.error.message); e.code = answer.error.code; if (answer.error.data !== undefined) e.data = answer.error.data; throw e; }
        return answer.result;
      },
    };
    window.ethereum = provider;
    // Every value data-ledger takes, in order, with the page's own clock: a state that lasts a few
    // milliseconds (a refused chain switch) is still seen, and the happy path's steps are timed.
    window.__ledgerTrail = [];
    const note = (el) => window.__ledgerTrail.push({ status: el.dataset.ledger, at: performance.now(), text: el.textContent });
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes" && m.target.matches?.(".ledger")) note(m.target);
        else if (m.type === "childList") for (const n of m.addedNodes) { if (n.nodeType !== 1) continue; if (n.matches?.(".ledger")) note(n); n.querySelectorAll?.(".ledger").forEach(note); }
      }
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-ledger"], childList: true });
    window.addEventListener("eip6963:requestProvider", () => {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "7a2e1b6c-e2e0-4b00-8000-${address.slice(2, 14)}", name: "E2E Wallet", icon: "data:image/svg+xml,", rdns: "test.dnfi.e2e" }, provider }) }));
    });
  })();
`;

/** The Node side of the bridge. `mode` is what the next request should do; the happy path is the defaults. */
function makeWallet() {
  const wallet = {
    chainIdHex: CHAIN_HEX,
    /** Reject the next eth_signTypedData_v4 with 4001 (counts down). */
    rejectSign: 0,
    /** "ok" | "refuse" (a plain error) | "needs-add" (4902, then addEthereumChain succeeds, the chain stays). */
    switchMode: "ok",
    log: [], signed: [], sent: [],
  };
  wallet.handle = async (method, paramsJson) => {
    const params = JSON.parse(paramsJson);
    const at = Date.now();
    wallet.log.push({ method, at });
    switch (method) {
      case "eth_requestAccounts": case "eth_accounts": return { result: [PLAYER.address] };
      case "eth_chainId": return { result: wallet.chainIdHex };
      case "wallet_switchEthereumChain": {
        if (wallet.switchMode === "refuse") return { error: { code: -32002, message: "The e2e wallet refused to switch chains" } };
        if (wallet.switchMode === "needs-add") return { error: { code: 4902, message: "Unrecognized chain ID" } };
        wallet.chainIdHex = params[0].chainId;
        return { result: null };
      }
      case "wallet_addEthereumChain": return { result: null };
      case "eth_signTypedData_v4": {
        if (wallet.rejectSign > 0) { wallet.rejectSign -= 1; return { error: { code: 4001, message: "E2E Wallet: user rejected the signature" } }; }
        const typed = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
        const { EIP712Domain: _domain, ...types } = typed.types;
        void _domain;
        const started = Date.now();
        const signature = await PLAYER.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message });
        wallet.signed.push({ at: started, ms: Date.now() - started, domain: typed.domain, primaryType: typed.primaryType, message: typed.message });
        return { result: signature };
      }
      case "eth_sendTransaction": {
        const tx = params[0];
        const started = Date.now();
        const hash = await walletClient.sendTransaction({
          to: tx.to, data: tx.data,
          ...(tx.value ? { value: BigInt(tx.value) } : {}), ...(tx.gas ? { gas: BigInt(tx.gas) } : {}),
        });
        wallet.sent.push({ at: started, ms: Date.now() - started, hash, to: tx.to, from: tx.from ?? null });
        return { result: hash };
      }
      default: {
        try { return { result: await rpc(method, params) }; } catch (error) { return { error: { code: error.code ?? -32603, message: error.message, data: error.data } }; }
      }
    }
  };
  return wallet;
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(ROOT, args.out);
  await mkdir(outDir, { recursive: true });
  const manifest = {
    startedAt: new Date().toISOString(), chainId: CHAIN_ID, rpc: RPC, gameVersion: GAME_VERSION, gameVersionId: GAME_VERSION_ID,
    accounts: { deployer: privateKeyToAccount(KEYS.deployer).address, verifier: VERIFIER.address, player: PLAYER.address },
    node: { command: `npx hardhat node --chain-id ${CHAIN_ID} --port ${RPC_PORT}`, mining: "automine (one block per transaction, no interval mining, wall-clock timestamps)" },
    deploy: null, d1: null, shots: [], shifts: [], timings: {}, chain: {}, errors: [], pageErrors: [],
  };
  const cleanups = [];
  const cleanup = async () => { for (const fn of cleanups.reverse()) { try { await fn(); } catch (error) { manifest.errors.push(`cleanup: ${error.message}`); } } cleanups.length = 0; };
  process.on("SIGINT", () => { cleanup().finally(() => process.exit(130)); });

  let ok = false;
  try {
    // ---- the chain.
    const node = await startNode();
    if (!args.keep) cleanups.push(() => stopServer(node));
    log(`hardhat node up at ${RPC} (chainId ${CHAIN_ID}, automine)`);
    const deployed = deployRegistry();
    manifest.deploy = { address: deployed.address, deployBlock: deployed.deployBlock, genesis: deployed.genesis, gasUsed: deployed.deployGas, owner: manifest.accounts.deployer, verifier: VERIFIER.address };
    log(`FeedRegistry at ${deployed.address}, block ${deployed.deployBlock}, GENESIS ${deployed.genesis}`);

    // ---- the Worker's environment and D1.
    const restoreDevVars = await writeDevVars(deployed.address, deployed.deployBlock);
    cleanups.push(restoreDevVars);
    manifest.d1 = await prepareD1(deployed.address);
    log(`D1 ready (${manifest.d1.persist}; migrations applied now: ${manifest.d1.applied.join(", ") || "none, already there"})`);
    const server = await startDevServer(ROOT, args.port);
    if (!args.keep) cleanups.push(() => stopServer(server.child));
    const api = async (route, init = {}) => { const r = await fetch(`${server.url}api/chain/${route}`, init); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; };
    const config = (await api("config")).body;
    expect(config?.enabled === true && config.chainId === CHAIN_ID && getAddress(config.contractAddress) === deployed.address && config.rpcUrl === RPC, `the Worker to be enabled for ${deployed.address} on ${CHAIN_ID}; got ${JSON.stringify(config)}`);
    manifest.config = config;
    log(`dev server at ${server.url}; /api/chain/config enabled, gameVersion ${config.gameVersion}`);

    // ---- the browser and the wallet.
    const wallet = makeWallet();
    const browser = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-device-scale-factor=1", "--hide-scrollbars"] });
    cleanups.push(() => browser.close());
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await context.exposeFunction("__e2eWallet", (method, paramsJson) => wallet.handle(method, paramsJson));
    await context.addInitScript(PROVIDER_SCRIPT(PLAYER.address));
    const page = await context.newPage();
    page.on("pageerror", (error) => manifest.pageErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) manifest.pageErrors.push(`console: ${message.text()}`); });
    /** Every attest the page makes: request time, response time, status and body. */
    const attests = [];
    page.on("request", (request) => { if (request.url().endsWith("/api/chain/attest")) attests.push({ sentAt: Date.now(), request }); });
    page.on("response", async (response) => {
      if (!response.url().endsWith("/api/chain/attest")) return;
      const entry = attests.find((a) => a.request === response.request());
      if (!entry) return;
      entry.receivedAt = Date.now(); entry.status = response.status(); entry.ms = entry.receivedAt - entry.sentAt;
      try { entry.body = await response.json(); } catch { entry.body = null; }
    });

    const ledgerText = () => page.evaluate(() => document.querySelector(".ledger")?.textContent?.trim() ?? null);
    const ledgerStatus = () => page.evaluate(() => document.querySelector(".ledger")?.dataset.ledger ?? null);
    const shoot = async (name, note = {}) => {
      await settle(page, 4);
      const file = path.join(outDir, `${name}.png`);
      await page.screenshot({ path: file });
      const shot = { name, file: path.relative(ROOT, file), ...note, ledger: await ledgerText(), ledgerStatus: await ledgerStatus() };
      manifest.shots.push(shot);
      log(`shot ${name}${shot.ledger ? ` — ledger: "${shot.ledger}"` : ""}`);
      return shot;
    };

    const freshTitle = async () => {
      await page.goto(`${server.url}?season=none`, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* fine */ } });
      const configSeen = page.waitForResponse((r) => r.url().endsWith("/api/chain/config"));
      await page.reload({ waitUntil: "domcontentloaded" });
      await configSeen;
      await page.waitForFunction(() => Boolean(window.__dnfi && window.__dnfi.play), null, { timeout: 60_000 });
      await waitForScene(page);
      await settle(page, 6);
    };

    /** A ticketed shift from the real button, the moderate bot's commands for the ticket's seed replayed through the dev hooks, to the report. */
    const playShiftToReport = async (from) => {
      // Freeze the page's loop before the shift exists: `manual` is a ref the real `start()` leaves alone, so
      // the run waits at tick 0 for the hooks and the tick-0 launch lands on tick 0, as in the Node replay.
      await page.evaluate(() => { window.__dnfi.play.manual(true); });
      const ticketSeen = page.waitForResponse((r) => r.url().endsWith("/api/chain/ticket"), { timeout: 10_000 });
      await page.getByRole("button", { name: from === "report" ? "Ape back in" : "Start your shift" }).click();
      const ticket = await (await ticketSeen).json();
      await page.waitForFunction(() => /SHIFT #/.test(document.querySelector(".practice-label")?.textContent ?? ""), null, { timeout: 10_000 });
      const header = await page.evaluate(() => document.querySelector(".practice-label")?.textContent?.trim());
      const inherited = inheritedOf(ticket.inherited ?? 0);
      const bot = playShift("moderate", ticket.seed >>> 0, { inherited });
      const opening = await page.evaluate(() => { const st = window.__dnfi.play.state(); return { tick: st.tick, mutations: st.mutations, chip: document.querySelector(".trait-inherited")?.textContent ?? null }; });
      if (inherited) expect(opening.tick === 0 && opening.mutations[inherited] === 1 && opening.chip === "INHERITED", `the page's creature to start with ${inherited} at level 1 and the INHERITED tag; got ${JSON.stringify(opening)}`);
      else expect(opening.mutations.metal === 0 && opening.mutations.balloon === 0 && opening.mutations.pepper === 0 && opening.chip === null, `a plain creature when nothing is inherited; got ${JSON.stringify(opening)}`);
      const commands = bot.commands;
      let index = 0;
      let state = await page.evaluate(() => window.__dnfi.play.state());
      while (state && state.phase === "playing") {
        while (state.phase === "playing" && index < commands.length && commands[index].tick <= state.tick) {
          const c = commands[index++];
          await page.evaluate((cmd) => (cmd.kind === "hatch" ? window.__dnfi.play.hatch() : cmd.kind === "e" ? window.__dnfi.play.pressE() : window.__dnfi.play.launch(cmd.ingredient, cmd.angle, cmd.power)), c);
        }
        const next = index < commands.length ? commands[index].tick : Infinity;
        state = await page.evaluate((k) => window.__dnfi.play.step(k), Math.max(1, Math.min(600, next - state.tick)));
      }
      const recorded = await page.evaluate(() => window.__dnfi.play.commands());
      await page.evaluate(() => { window.__dnfi.play.manual(false); });
      await page.waitForSelector(".result-copy", { timeout: 20_000 });
      await page.waitForFunction(() => document.querySelector(".ledger")?.dataset.ledger === "ready", null, { timeout: 20_000 });
      await settle(page, 12);
      const report = await page.evaluate(() => ({
        score: Number((document.querySelector(".result-sub")?.textContent ?? "").replace(/[^\d]/g, "")),
        uptime: document.querySelector(".result-score")?.textContent?.trim() ?? null,
        stats: [...document.querySelectorAll(".result-stats div")].map((d) => `${d.querySelector("small")?.textContent}=${d.querySelector("strong")?.textContent}`),
      }));
      expect(state.phase === "lost", `the shift to end on its own (phase ${state?.phase})`);
      expect(bot.ticks === state.tick && bot.score === state.score, `the page's run to match the Node replay (page ${state.tick}/${state.score}, Node ${bot.ticks}/${bot.score})`);
      const shift = { ticket, header, inherited, endTick: state.tick, score: state.score, cause: state.failureReason, ending: state.ending, commands: recorded, commandCount: recorded.length, botCommands: commands.length, report, traceHash: traceHash(recorded, state.tick), filings: [] };
      manifest.shifts.push({ ...shift, commands: undefined });
      log(`shift ${manifest.shifts.length}: seed ${ticket.seed}, ${state.tick} ticks, ${recorded.length} commands, score ${state.score}, ${state.failureReason}; header "${header}"`);
      return shift;
    };

    /** Clicks the button (or Retry) and waits for the Ledger to settle, by the trail: a terminal state after the click. */
    const file = async (button = "File this shift on Hemi") => {
      const before = attests.length;
      const mark = await page.evaluate(() => window.__ledgerTrail.length);
      const clickedAt = Date.now();
      await page.getByRole("button", { name: button }).click();
      // Filing always starts with an explicit provider choice; receipt-only
      // checks resume without opening a wallet or asking for a connection.
      if (button !== "Check again") {
        await page.getByRole("dialog", { name: "Choose a wallet" }).getByRole("button", { name: "E2E Wallet", exact: true }).click();
      }
      try {
        await page.waitForFunction((m) => window.__ledgerTrail.slice(m).some((e) => e.status === "filed" || e.status === "failed" || e.status === "off"), mark, { timeout: 60_000, polling: 50 });
      } catch (error) {
        const seen = await page.evaluate((m) => ({ trail: window.__ledgerTrail.slice(m), ledger: document.querySelector(".ledger")?.dataset.ledger ?? null, text: document.querySelector(".ledger")?.textContent ?? null }), mark);
        fail(`the Ledger did not settle after "${button}": ${error.message}; ${json({ ...seen, wallet: wallet.log.slice(-8), attests: attests.slice(before).map((a) => ({ status: a.status, ms: a.ms, body: a.body })) })}`);
      }
      const settledAt = Date.now();
      const trail = await page.evaluate((m) => window.__ledgerTrail.slice(m), mark);
      const terminal = trail.find((e) => e.status === "filed" || e.status === "failed" || e.status === "off");
      const attest = attests.slice(before).at(-1) ?? null;
      if (attest) { const t = Date.now(); while (attest.body === undefined && Date.now() - t < 5_000) await wait(20); }
      const steps = trail.map((e, i) => `${e.status}${i ? `+${Math.round(e.at - trail[0].at)}ms` : ""}`);
      return { status: terminal.status, text: terminal.text.trim(), ms: Math.round(terminal.at - trail[0].at), wallMs: settledAt - clickedAt, clickedAt, steps, attest: attest ? { status: attest.status, ms: attest.ms, body: attest.body } : null };
    };

    /** The filed shift against the chain: the receipt, the event, the views. */
    const verifyOnChain = async (shift, filing, label) => {
      const result = resultFromJson(filing.attest.body.result);
      const txHash = wallet.sent.at(-1)?.hash ?? fail("no transaction was sent");
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      expect(receipt.status === "success", `receipt success for ${txHash}`);
      const decoded = receipt.logs.map((l) => decodeEventLog({ abi: feedRegistryAbi, data: l.data, topics: l.topics }));
      const logs = decoded.filter((l) => l.eventName === "ResultRecorded");
      expect(logs.length === 1, `one ResultRecorded in ${txHash}`);
      const ev = logs[0].args;
      // PileFed only for the wallet's first PILE_FILINGS_PER_EPOCH filings in the epoch (docs/CHAIN.md §7).
      const fed = decoded.find((l) => l.eventName === "PileFed" && l.args.runId.toLowerCase() === ev.runId.toLowerCase())?.args ?? null;
      const used = await publicClient.readContract({ address: deployed.address, abi: feedRegistryAbi, functionName: "usedRunIds", args: [shift.ticket.runId] });
      const best = await publicClient.readContract({ address: deployed.address, abi: feedRegistryAbi, functionName: "bestScore", args: [PLAYER.address] });
      const runs = await publicClient.readContract({ address: deployed.address, abi: feedRegistryAbi, functionName: "runs", args: [PLAYER.address] });
      const blockLine = /Block ([\d,]+)/.exec(filing.text)?.[1]?.replace(/,/g, "");
      const bestLine = /Your best on \w+: ([\d,]+)/.exec(filing.text)?.[1]?.replace(/,/g, "");
      const checks = {
        usedRunId: used === true,
        resultIsTheShift: result.runId.toLowerCase() === shift.ticket.runId.toLowerCase() && result.durationTicks === shift.endTick && Number(result.score) === shift.score
          && result.traceHash.toLowerCase() === shift.traceHash.toLowerCase() && result.seed.toLowerCase() === seedToBytes32(shift.ticket.seed).toLowerCase()
          && result.snapshotHash.toLowerCase() === shift.ticket.snapshotHash.toLowerCase() && getAddress(result.player) === PLAYER.address && result.gameVersion.toLowerCase() === GAME_VERSION_ID.toLowerCase(),
        eventMatchesResult: ev.runId.toLowerCase() === result.runId.toLowerCase() && getAddress(ev.player) === PLAYER.address && ev.score === result.score && ev.durationTicks === result.durationTicks
          && ev.btcFed === result.btcFed && ev.ethFed === result.ethFed && ev.hemiFed === result.hemiFed && ev.bestCombo === result.bestCombo && ev.frenzies === result.frenzies
          && ev.sizeCenti === result.sizeCenti && ev.ending === result.ending && ev.cause === result.cause && ev.traceHash.toLowerCase() === result.traceHash.toLowerCase() && ev.snapshotHash.toLowerCase() === result.snapshotHash.toLowerCase(),
        reportMatchesResult: shift.report.score === Number(result.score) && shift.report.stats.includes(`TOKENS FED=${result.totalFeeds}`) && shift.report.stats.includes(`BEST COMBO=×${result.bestCombo}`) && shift.report.stats.includes(`FOMO=${result.frenzies}`),
        ledgerBlock: blockLine !== undefined && BigInt(blockLine) === receipt.blockNumber,
        ledgerBest: bestLine !== undefined && BigInt(bestLine) === best,
        bestIsMax: best >= result.score,
        pileEventMatches: fed === null || (fed.epoch === ev.epoch && fed.btcFed === ev.btcFed && fed.ethFed === ev.ethFed && fed.hemiFed === ev.hemiFed && getAddress(fed.player) === PLAYER.address),
        ledgerPileLine: fed
          ? filing.text.includes(`Filed into epoch ${ev.epoch}’s pile: ${ev.btcFed} BTC · ${ev.ethFed} ETH · ${ev.hemiFed} HEMI.`)
          : filing.text.includes(`Epoch ${ev.epoch}’s pile takes three shifts a wallet; yours are in. This one counts for the board.`),
        walletSignedThisResult: wallet.signed.at(-1)?.message?.runId?.toLowerCase() === result.runId.toLowerCase() && wallet.signed.at(-1)?.domain?.verifyingContract?.toLowerCase() === deployed.address.toLowerCase() && Number(wallet.signed.at(-1)?.domain?.chainId) === CHAIN_ID,
      };
      const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
      const record = {
        label, txHash, blockNumber: Number(receipt.blockNumber), gasUsed: Number(receipt.gasUsed), effectiveGasPrice: receipt.effectiveGasPrice?.toString() ?? null,
        result: filing.attest.body.result, event: JSON.parse(json(ev)), fedPile: fed !== null, steps: filing.steps, usedRunId: used, bestScore: best.toString(), runs: Number(runs), ledger: filing.text, checks,
      };
      shift.filings.push(record);
      manifest.shifts.at(-1).filings = shift.filings;
      if (failed.length) fail(`${label}: on-chain checks failed: ${failed.join(", ")} — ${json(record)}`);
      log(`${label}: tx ${txHash} in block ${receipt.blockNumber}, gas ${receipt.gasUsed}; usedRunIds true, bestScore ${best}, runs ${runs}; event == result == report`);
      return record;
    };

    /** What the Worker's world says, until the player is on the board (the indexer refreshes at most every 20 s). */
    const waitForWorld = async (timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const world = (await api("world")).body;
        if (world?.top?.some((k) => getAddress(k.player) === PLAYER.address)) return world;
        if (Date.now() > deadline) fail(`the world never listed ${PLAYER.address}: ${JSON.stringify(world)}`);
        await wait(2_000);
      }
    };

    const filedResults = [];
    const filedRecords = [];
    const recordFiled = (shift, filing, label) => verifyOnChain(shift, filing, label).then((r) => { filedResults.push(resultFromJson(r.result)); filedRecords.push(r); return r; });

    /** The world once the indexer has folded `runs` filings in all and lists `epoch` (it refreshes at most every 20 s). */
    const waitForRuns = async (runs, epoch, timeoutMs = 90_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const world = (await api("world")).body;
        const listed = world?.epochs?.find((e) => e.epoch === epoch);
        if (world?.pile?.allTime && BigInt(world.pile.allTime.runs) === BigInt(runs) && listed?.top?.length) return world;
        if (Date.now() > deadline) fail(`the world never folded ${runs} runs with epoch ${epoch} listed: ${json({ allTime: world?.pile?.allTime, epochs: world?.epochs?.map((e) => [e.epoch, e.runs, e.top?.length]) })}`);
        await wait(2_000);
      }
    };
    /** The ledger page (/ledger) as a reader sees it: the epochs strip, the selected board, its rows and proof links. */
    const readLedger = async () => {
      await page.goto(`${server.url}ledger`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".epoch-card", { timeout: 60_000 });
      await page.waitForSelector(".ledger-table tbody tr", { timeout: 20_000 });
      await settle(page, 4);
      return page.evaluate(() => ({
        cards: [...document.querySelectorAll(".epoch-card")].map((c) => ({
          head: c.querySelector(".epoch-card-head b")?.textContent ?? null, now: Boolean(c.querySelector(".epoch-card-head em")),
          runs: c.querySelector(".epoch-card-runs")?.textContent ?? null, shares: c.querySelector(".epoch-card-shares")?.textContent ?? null,
          traits: [...c.querySelectorAll(".epoch-card-trait")].map((t) => t.textContent),
        })),
        tab: document.querySelector(".ledger-tabs [aria-selected=true]")?.textContent ?? null,
        rows: [...document.querySelectorAll(".ledger-table tbody tr")].map((tr) => ({
          keeper: tr.querySelector(".keeper [title]")?.getAttribute("title") ?? null, score: tr.querySelector(".score")?.textContent ?? null,
          epoch: tr.querySelector(".col-epoch")?.textContent ?? null,
          trace: tr.querySelector(".col-proof a[href*='/api/chain/trace']")?.getAttribute("href") ?? null,
        })),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
    };
    /** A board row's Trace link answers with the trace whose keccak is the event's traceHash. */
    const traceLinkMatches = async (href, record) => {
      if (!href) return false;
      const r = await fetch(new URL(href, server.url));
      const body = await r.json().catch(() => null);
      return r.status === 200 && body?.runId?.toLowerCase() === record.result.runId.toLowerCase() && body?.traceHash?.toLowerCase() === record.event.traceHash.toLowerCase() && keccak256(body.trace).toLowerCase() === body.traceHash.toLowerCase();
    };
    const ledgerShot = async (name, note) => {
      const file = path.join(outDir, `${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      manifest.shots.push({ name, file: path.relative(ROOT, file), ...note });
      log(`shot ${name}`);
    };
    const TRAIT = { 1: "HODL jaws", 2: "Gas belly", 3: "Turbo breath" };

    // ================================================================
    // 1. The title before anything was filed.
    // ================================================================
    await freshTitle();
    const titleBefore = await page.evaluate(() => ({ diet: document.querySelector(".diet-line")?.textContent ?? null, keepers: document.querySelector(".top-keepers")?.textContent ?? null, last: document.querySelector(".last-filing")?.textContent ?? null }));
    expect(titleBefore.diet === null && titleBefore.keepers === null && titleBefore.last === null, `an empty title (no diet line, no keepers, no resume line); got ${JSON.stringify(titleBefore)}`);
    await shoot("01-title-before", { title: titleBefore });

    // ================================================================
    // 2. The happy path: ticket → play → File → FILED.
    // ================================================================
    const s1 = await playShiftToReport("title");
    expect(/CHAIN 31337 · SHIFT #1/.test(s1.header), `the header to name the chain and the shift; got "${s1.header}"`);
    await shoot("02-report-ready", { shift: 1 });
    const f1 = await file();
    expect(f1.status === "filed", `FILED; got ${f1.status}: ${f1.text}`);
    expect(f1.attest?.status === 200, `an attested result; got ${f1.attest?.status}`);
    await shoot("03-report-filed", { shift: 1, clickToFiledMs: f1.ms, attestMs: f1.attest.ms });
    const r1 = await recordFiled(s1, f1, "shift 1 (happy path)");
    const sign = wallet.signed.at(-1); const send = wallet.sent.at(-1);
    manifest.timings.happyPath = {
      clickToFiledMs: f1.ms, clickToFiledWallMs: f1.wallMs, steps: f1.steps, attestRoundTripMs: f1.attest.ms, walletSignMs: sign.ms, sendRawTransactionMs: send.ms,
      signToSendMs: send.at - sign.at, sendToFiledWallMs: f1.clickedAt + f1.wallMs - send.at, gasUsed: r1.gasUsed, blockNumber: r1.blockNumber,
      walletCalls: wallet.log.filter((l) => l.at >= f1.clickedAt).map((l) => l.method),
    };
    log(`happy path: click→FILED ${f1.ms} ms; attest ${f1.attest.ms} ms; sign ${sign.ms} ms; send ${send.ms} ms; gas ${r1.gasUsed}`);
    // The record anyone can check: the trace the site serves, replayed and compared with the chain by the public script.
    const traceLink = await page.evaluate(() => document.querySelector(".ledger a[href^='/api/chain/trace']")?.getAttribute("href") ?? null);
    expect(traceLink === `/api/chain/trace?runId=${s1.ticket.runId}`, `the Trace link on the filed row; got ${traceLink}`);
    const verify = spawnSync("node", ["--experimental-strip-types", "scripts/verify-filing.mjs", "--site", server.url, "--rpc", RPC, "--tx", r1.txHash], { cwd: ROOT, encoding: "utf8" });
    manifest.verify = { status: verify.status, output: verify.stdout.trim().split("\n") };
    expect(verify.status === 0 && /PASS: all \d+ checks/.test(verify.stdout), `verify-filing.mjs to pass on shift 1:\n${verify.stdout}${verify.stderr}`);
    log(`verify-filing: ${verify.stdout.trim().split("\n").at(-1)}`);

    // ================================================================
    // 3. The title after: the diet line, TOP KEEPERS, the resume line.
    // ================================================================
    const world = await waitForWorld();
    manifest.chain.worldAfterFirstFiling = world;
    const configSeen = page.waitForResponse((r) => r.url().endsWith("/api/chain/config"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await configSeen;
    await page.waitForFunction(() => Boolean(window.__dnfi && window.__dnfi.play), null, { timeout: 60_000 });
    await waitForScene(page);
    await page.waitForSelector(".top-keepers", { timeout: 20_000 });
    await page.waitForFunction(() => /was filed/.test(document.querySelector(".last-filing")?.textContent ?? ""), null, { timeout: 20_000 });
    await settle(page, 6);
    const titleAfter = await page.evaluate(() => ({
      diet: document.querySelector(".diet-line")?.textContent ?? null,
      keepers: [...document.querySelectorAll(".top-keepers li")].map((li) => li.textContent?.trim()),
      last: document.querySelector(".last-filing")?.textContent?.trim() ?? null,
    }));
    const r = filedResults[0];
    let dominant = ["BTC", r.btcFed];
    for (const entry of [["ETH", r.ethFed], ["HEMI", r.hemiFed]]) if (entry[1] > dominant[1]) dominant = entry;
    const share = Math.round((dominant[1] / r.totalFeeds) * 100);
    expect(titleAfter.diet?.startsWith(`The community fed it ${share}% ${dominant[0]} this epoch.`), `the diet line from the pile; got "${titleAfter.diet}" (expected ${share}% ${dominant[0]})`);
    // Then when the pile closes (D185), from the contract's GENESIS and EPOCH_SECONDS against this browser's clock.
    expect(/ The pile closes in (\d+h( \d+m)?|\d+m)\.$/.test(titleAfter.diet ?? ""), `the diet line to end with when the pile closes; got "${titleAfter.diet}"`);
    expect(titleAfter.keepers.length === 1 && titleAfter.keepers[0].includes(`${PLAYER.address.slice(0, 6)}…${PLAYER.address.slice(-4)}`) && titleAfter.keepers[0].includes(Number(r.score).toLocaleString("en-US")), `TOP KEEPERS to list the player with the score; got ${JSON.stringify(titleAfter.keepers)}`);
    expect(/Your last shift was filed on Hardhat\./.test(titleAfter.last), `the resume line; got "${titleAfter.last}"`);
    await shoot("04-title-after", { title: titleAfter });
    log(`title after: "${titleAfter.diet}" · ${titleAfter.keepers[0]} · "${titleAfter.last}"`);

    // ================================================================
    // 4. The wallet rejects the signature, then Retry succeeds.
    // ================================================================
    const s2 = await playShiftToReport("title");
    wallet.rejectSign = 1;
    const f2 = await file();
    expect(f2.status === "failed" && /You cancelled it in your wallet\./.test(f2.text) && /Retry/.test(f2.text), `the rejected state with Retry; got ${f2.status}: ${f2.text}`);
    await shoot("05-failed-rejected", { shift: 2, failure: "rejected (4001 from the wallet at eth_signTypedData_v4)" });
    const f2b = await file("Retry");
    expect(f2b.status === "filed", `FILED after Retry; got ${f2b.status}: ${f2b.text}`);
    expect(f2b.attest.status === 200 && f2b.attest.body.verifierSignature === f2.attest.body.verifierSignature, "the Retry's attest to be the idempotent repeat (same signature)");
    await recordFiled(s2, f2b, "shift 2 (rejected, then Retry)");

    // ================================================================
    // 5. A tampered trace: the verifier fails closed (and, in range, the client refuses to sign).
    // ================================================================
    const s3 = await playShiftToReport("report");
    const launchIndex = Math.max(0, s3.commands.findIndex((c) => c.kind === "launch" && c.tick > 0));
    const tamper = (power) => page.route("**/api/chain/attest", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      body.commands[launchIndex] = { ...body.commands[launchIndex], power };
      await route.continue({ postData: JSON.stringify(body) });
    });
    await tamper(99);
    const f3 = await file();
    await page.unroute("**/api/chain/attest");
    expect(f3.status === "failed" && f3.attest?.status === 422 && f3.attest.body?.error?.code === "invalid_trace" && /The verifier could not replay this shift\./.test(f3.text), `invalid_trace from an out-of-range power; got ${f3.status} ${f3.attest?.status} ${JSON.stringify(f3.attest?.body)}: ${f3.text}`);
    await shoot("06-failed-invalid-trace", { shift: 3, failure: `launch #${launchIndex} power → 99 (out of range) in the attest body`, workerAnswer: f3.attest.body });
    const inRange = s3.commands[launchIndex].power === 9 ? 16 : 9;
    await tamper(inRange);
    const f3b = await file("Retry");
    await page.unroute("**/api/chain/attest");
    const tamperedReason = f3b.attest?.body?.error?.code ?? (f3b.attest?.status === 200 ? "mismatch (client)" : "?");
    expect(f3b.status === "failed" && ["invalid_trace", "run_not_over", "mismatch (client)"].includes(tamperedReason), `a rejection of the in-range tamper; got ${f3b.status} ${tamperedReason}: ${f3b.text}`);
    expect(wallet.signed.length === 2, "nothing to have been signed for the tampered traces");
    await shoot("07-failed-tampered-in-range", { shift: 3, failure: `launch #${launchIndex} power ${s3.commands[launchIndex].power} → ${inRange} (in range)`, reason: tamperedReason, workerStatus: f3b.attest?.status });
    const f3c = await file("Retry");
    expect(f3c.status === "filed", `FILED with the honest trace; got ${f3c.status}: ${f3c.text}`);
    await recordFiled(s3, f3c, "shift 3 (tampered twice, then the honest trace)");

    // ================================================================
    // 6. The same run filed twice: a relayer (Node) files it first, the page's own filing meets DuplicateRun.
    // ================================================================
    const s4 = await playShiftToReport("report");
    const relayed = await api("attest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: s4.ticket.runId, player: PLAYER.address, commands: s4.commands, endTick: s4.endTick }) });
    expect(relayed.status === 200, `the relayer's attest; got ${relayed.status} ${JSON.stringify(relayed.body)}`);
    const relayedResult = resultFromJson(relayed.body.result);
    const relayedTyped = resultTypedData(relayedResult, deployed.address, CHAIN_ID);
    const relayedSig = await PLAYER.signTypedData(relayedTyped);
    const relayedHash = await walletClient.writeContract({ address: deployed.address, abi: feedRegistryAbi, functionName: "submitResult", args: [relayedResult, relayedSig, relayed.body.verifierSignature] });
    const relayedReceipt = await publicClient.waitForTransactionReceipt({ hash: relayedHash });
    expect(relayedReceipt.status === "success", "the relayed filing to land");
    filedResults.push(relayedResult);
    filedRecords.push({ label: "shift 4 (relayed)", txHash: relayedHash, result: { runId: relayedResult.runId, score: relayedResult.score.toString() }, event: { traceHash: relayedResult.traceHash } });
    const sentBefore = wallet.sent.length;
    const f4 = await file();
    // DuplicateRun is recovered: the page reads usedRunIds, sees the run on chain, and settles on FILED with the on-chain best.
    const relayedBest = await publicClient.readContract({ address: deployed.address, abi: feedRegistryAbi, functionName: "bestScore", args: [PLAYER.address] });
    expect(f4.status === "filed" && /This shift was already on/.test(f4.text) && f4.text.includes(relayedBest.toLocaleString("en-US")), `DuplicateRun recovered as FILED with the on-chain best ${relayedBest}; got ${f4.status}: ${f4.text}`);
    expect(wallet.sent.length === sentBefore, "no transaction to have been sent for the duplicate (the simulation caught it)");
    expect(f4.attest.status === 200 && f4.attest.body.verifierSignature === relayed.body.verifierSignature, "the page's attest to be the idempotent repeat of the relayer's");
    expect(/This shift: \d+ BTC · \d+ ETH · \d+ HEMI\./.test(f4.text) && !/pile/.test(f4.text), `the recovered filing claims no pile (no receipt of ours in hand); got: ${f4.text}`);
    manifest.shifts.at(-1).filings.push({ label: "shift 4 (filed first by a relayer from Node)", txHash: relayedHash, blockNumber: Number(relayedReceipt.blockNumber), gasUsed: Number(relayedReceipt.gasUsed), result: relayed.body.result, ledger: f4.text });
    await shoot("08-filed-already", { shift: 4, note: "DuplicateRun() from simulateContract: the run was already on chain (relayed from Node); the page read usedRunIds and settled on FILED", relayedTx: relayedHash });

    // ================================================================
    // 7. The wrong chain: the wallet says 0x1 and will not switch; then 4902 + add with no effect; then it switches.
    // ================================================================
    const s5 = await playShiftToReport("report");
    wallet.chainIdHex = "0x1"; wallet.switchMode = "refuse";
    const f5 = await file();
    expect(f5.status === "failed" && /Your wallet is on another chain\. Switch to Hardhat and retry\./.test(f5.text) && f5.attest === null, `wrong_chain before any attest; got ${f5.status}: ${f5.text}`);
    await shoot("09-failed-wrong-chain", { shift: 5, failure: "eth_chainId 0x1, wallet_switchEthereumChain refused" });
    wallet.switchMode = "needs-add";
    const f5b = await file("Retry");
    expect(f5b.status === "failed" && /Your wallet is on another chain/.test(f5b.text) && wallet.log.some((l) => l.method === "wallet_addEthereumChain"), `wrong_chain after 4902 → add → still 0x1; got ${f5b.status}: ${f5b.text}`);
    wallet.switchMode = "ok";
    const f5c = await file("Retry");
    expect(f5c.status === "filed" && wallet.chainIdHex === CHAIN_HEX, `FILED once the wallet switched; got ${f5c.status}: ${f5c.text}`);
    await recordFiled(s5, f5c, "shift 5 (wrong chain twice, then switched)");

    // ================================================================
    // 8. The Worker's rate limit: eleven attests in a minute.
    // ================================================================
    if (args.rateLimit) {
      const s6 = await playShiftToReport("report");
      // The limit is per fixed minute window (floor(now / 60 s)); start the burst early in one, so the page's attest lands in the same window.
      const intoWindow = Date.now() % 60_000;
      if (intoWindow > 45_000) { log(`waiting ${Math.round((60_000 - intoWindow) / 1000)} s for a fresh rate-limit window`); await wait(60_000 - intoWindow + 250); }
      let spent = 0; let limited = null;
      for (let i = 0; i < 12 && !limited; i += 1) {
        const answer = await api("attest", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        spent += 1;
        if (answer.status === 429) limited = { after: spent, retryAfter: answer.headers.get("Retry-After"), body: answer.body };
      }
      expect(limited, "the Worker to answer 429 within twelve bad attests");
      const f6 = await file();
      expect(f6.status === "failed" && f6.attest?.status === 429 && /Too many requests\. Wait a minute and retry\./.test(f6.text), `rate_limited; got ${f6.status} ${f6.attest?.status}: ${f6.text}`);
      await shoot("10-failed-rate-limited", { shift: 6, failure: `${limited.after} attests from Node in this minute (the ${limited.after}th was 429, Retry-After ${limited.retryAfter}), then the page's`, workerAnswer: f6.attest.body });
      const untilNextWindow = 60_000 - (Date.now() % 60_000) + 1_000;
      log(`waiting ${Math.round(untilNextWindow / 1000)} s for the next rate-limit window`);
      await wait(untilNextWindow);
      const f6b = await file("Retry");
      expect(f6b.status === "filed", `FILED in the next window; got ${f6b.status}: ${f6b.text}`);
      await recordFiled(s6, f6b, "shift 6 (rate limited, then the next minute)");
    }

    // ================================================================
    // 9. The pile: the wallet's first PILE_FILINGS_PER_EPOCH filings, summed on chain; the rest ranked, not fed.
    // ================================================================
    const epoch = await publicClient.readContract({ address: deployed.address, abi: feedRegistryAbi, functionName: "currentEpoch" });
    const diet = await publicClient.readContract({ address: deployed.address, abi: feedRegistryAbi, functionName: "diet", args: [epoch] });
    const allTime = await publicClient.readContract({ address: deployed.address, abi: feedRegistryAbi, functionName: "allTimeDiet" });
    // Every filing here is the one wallet's, in epoch 0, each mined before the next was sent: chain order is filing order.
    const pileLimit = Number(await publicClient.readContract({ address: deployed.address, abi: feedRegistryAbi, functionName: "PILE_FILINGS_PER_EPOCH" }));
    expect(pileLimit === PILE_FILINGS_PER_EPOCH, `the contract's cap ${pileLimit} == lib/chain/types.ts's ${PILE_FILINGS_PER_EPOCH}`);
    expect(filedResults.length > pileLimit, `more filings (${filedResults.length}) than the cap (${pileLimit}), so the cap is exercised`);
    const fedResults = filedResults.slice(0, pileLimit);
    const sum = fedResults.reduce((acc, r) => ({ btc: acc.btc + BigInt(r.btcFed), eth: acc.eth + BigInt(r.ethFed), hemi: acc.hemi + BigInt(r.hemiFed), runs: acc.runs + 1n }), { btc: 0n, eth: 0n, hemi: 0n, runs: 0n });
    const pageFilings = manifest.shifts.flatMap((s) => s.filings ?? []).filter((f) => typeof f.fedPile === "boolean");
    expect(pageFilings.slice(0, 3).every((f) => f.fedPile) && pageFilings.slice(3).every((f) => !f.fedPile),
      `the first three filings fed the pile and none after: ${json(pageFilings.map((f) => [f.label, f.fedPile]))}`);
    const filingsIn = await publicClient.readContract({ address: deployed.address, abi: feedRegistryAbi, functionName: "filingsIn", args: [epoch, PLAYER.address] });
    expect(Number(filingsIn) === filedResults.length, `filingsIn(${epoch}, player) ${filingsIn} == ${filedResults.length} filings`);
    const best = filedResults.reduce((m, r) => (r.score > m ? r.score : m), 0n);
    const onChainBest = await publicClient.readContract({ address: deployed.address, abi: feedRegistryAbi, functionName: "bestScore", args: [PLAYER.address] });
    const onChainRuns = await publicClient.readContract({ address: deployed.address, abi: feedRegistryAbi, functionName: "runs", args: [PLAYER.address] });
    const dominantOnChain = await publicClient.readContract({ address: deployed.address, abi: feedRegistryAbi, functionName: "dominant", args: [epoch] });
    manifest.chain.final = {
      epoch: Number(epoch), diet: { btc: diet[0].toString(), eth: diet[1].toString(), hemi: diet[2].toString(), runs: diet[3].toString() },
      allTime: { btc: allTime[0].toString(), eth: allTime[1].toString(), hemi: allTime[2].toString(), runs: allTime[3].toString() },
      expectedFromFilings: JSON.parse(json(sum)), dominant: dominantOnChain, bestScore: onChainBest.toString(), runs: Number(onChainRuns), filings: filedResults.length,
      head: Number(await publicClient.getBlockNumber()),
    };
    expect(diet[0] === sum.btc && diet[1] === sum.eth && diet[2] === sum.hemi && diet[3] === sum.runs, `diet(${epoch}) to equal the filings' sums: chain ${json(diet)} vs ${json(sum)}`);
    expect(allTime[0] === sum.btc && allTime[1] === sum.eth && allTime[2] === sum.hemi && allTime[3] === sum.runs, "allTimeDiet to equal the same sums");
    expect(onChainBest === best && Number(onChainRuns) === filedResults.length, `bestScore ${onChainBest} == max ${best} over every filing and runs ${onChainRuns} == ${filedResults.length} (all filings, fed or not)`);
    const finalWorld = (await api("world")).body;
    manifest.chain.finalWorld = finalWorld;
    log(`pile: diet(${epoch}) = ${json(manifest.chain.final.diet)} == sum of the first ${pileLimit} of ${filedResults.length} filings; bestScore ${onChainBest}; runs ${onChainRuns}; head block ${manifest.chain.final.head}`);

    // ================================================================
    // 9b. The ledger page in epoch 0: one epoch, its pile, the player's best with a trace that replays.
    // ================================================================
    await waitForRuns(sum.runs, 0);
    const ledger0 = await readLedger();
    manifest.chain.ledgerEpoch0 = ledger0;
    const bestRecord = filedRecords.find((rec) => BigInt(rec.result.score) === onChainBest) ?? fail(`no filing scored the best ${onChainBest}`);
    expect(ledger0.cards.length === 1 && ledger0.cards[0].head === "EPOCH 0" && ledger0.cards[0].now && ledger0.cards[0].runs === `${sum.runs} shift${sum.runs === 1n ? "" : "s"} in the pile`, `one card, EPOCH 0 marked NOW with ${sum.runs} shifts; got ${json(ledger0.cards)}`);
    expect(ledger0.cards[0].traits[0] === "CAME IN WITHnothing" && ledger0.cards[0].traits[1] === `LEADING${TRAIT[dominantOnChain]}`, `epoch 0 inherits nothing and leads with ${TRAIT[dominantOnChain]}; got ${json(ledger0.cards[0].traits)}`);
    expect(ledger0.tab === "Epoch 0", `the current epoch's board to open; got ${ledger0.tab}`);
    expect(ledger0.rows.length === 1 && getAddress(ledger0.rows[0].keeper) === PLAYER.address && ledger0.rows[0].score === onChainBest.toLocaleString("en-US"), `one row per player: the player's best ${onChainBest}; got ${json(ledger0.rows)}`);
    expect(await traceLinkMatches(ledger0.rows[0].trace, bestRecord), `the row's Trace link to serve the trace committed by ${bestRecord.txHash}; got ${ledger0.rows[0].trace}`);
    expect(ledger0.overflow <= 0, `no horizontal overflow on /ledger; got ${ledger0.overflow}px`);
    await ledgerShot("10b-ledger-epoch-0", { epoch: 0, rows: ledger0.rows.length });
    log(`ledger: epoch 0 card (${ledger0.cards[0].shares}), board = the player's best ${onChainBest}, trace link replays to the committed hash`);

    // ================================================================
    // 10. A day later: the creature inherits the pile's dominant coin (stage 2).
    // ================================================================
    expect(Number(epoch) === 0 && dominantOnChain > 0, `epoch 0 with a dominant coin to inherit; got epoch ${epoch}, dominant ${dominantOnChain}`);
    const dayAhead = Number(await publicClient.readContract({ address: deployed.address, abi: feedRegistryAbi, functionName: "EPOCH_SECONDS" }));
    await publicClient.request({ method: "evm_increaseTime", params: [dayAhead] });
    await publicClient.request({ method: "evm_mine", params: [] });
    expect(Number(await publicClient.readContract({ address: deployed.address, abi: feedRegistryAbi, functionName: "currentEpoch" })) === 1, "the chain to be in epoch 1");
    // The Worker's clock follows (a local-chain-only knob): restart it with the offset.
    await stopServer(server.child);
    await writeDevVars(deployed.address, deployed.deployBlock, [`DNFI_TEST_CLOCK_OFFSET_SECONDS=${dayAhead}`], { backupOriginal: false });
    const server2 = await startDevServer(ROOT, args.port);
    if (!args.keep) cleanups.push(() => stopServer(server2.child));
    // The page's clock follows too, or the client (rightly) refuses a deadline a day ahead of its own time.
    await context.addInitScript((offsetMs) => {
      const RealDate = Date;
      const now = () => RealDate.now() + offsetMs;
      const Shifted = function (...args) { return args.length ? new RealDate(...args) : new RealDate(now()); };
      Shifted.prototype = RealDate.prototype;
      Shifted.now = now; Shifted.parse = RealDate.parse; Shifted.UTC = RealDate.UTC;
      window.Date = Shifted;
    }, dayAhead * 1000);
    const world2 = (await api("world")).body;
    manifest.chain.nextEpochWorld = world2;
    expect(world2?.epoch === 1 && world2.sourceEpoch === 0 && world2.inherited === dominantOnChain, `the world to inherit epoch 0's dominant coin ${dominantOnChain} in epoch 1; got ${json({ epoch: world2?.epoch, sourceEpoch: world2?.sourceEpoch, inherited: world2?.inherited, stale: world2?.stale })}`);
    await freshTitle();
    const inheritedLine = await page.evaluate(() => document.querySelector(".inherited-line")?.textContent?.trim() ?? null);
    const traitName = { 1: "HODL JAWS", 2: "GAS BELLY", 3: "TURBO BREATH" }[dominantOnChain];
    expect(inheritedLine !== null && inheritedLine.includes(`TONIGHT IT HAS ${traitName}.`) && /^LAST EPOCH: \d+% (BTC|ETH|HEMI)\./.test(inheritedLine), `the title's inherited line; got ${JSON.stringify(inheritedLine)}`);
    await shoot("11-title-inherits", { epoch: 1, inherited: dominantOnChain, line: inheritedLine });
    const s7 = await playShiftToReport("title");
    expect(s7.ticket.epoch === 1 && s7.ticket.sourceEpoch === 0 && s7.ticket.inherited === dominantOnChain, `the ticket to carry the inheritance; got ${json({ epoch: s7.ticket.epoch, sourceEpoch: s7.ticket.sourceEpoch, inherited: s7.ticket.inherited })}`);
    const sourcePile = await publicClient.readContract({ address: deployed.address, abi: feedRegistryAbi, functionName: "diet", args: [0n] });
    expect(s7.ticket.snapshotHash.toLowerCase() === snapshotHashOf(1n, 0n, { btc: sourcePile[0], eth: sourcePile[1], hemi: sourcePile[2] }).toLowerCase(), "the ticket's snapshot hash to be recomputable from diet(0) on chain");
    await shoot("12-play-inherited-report", { shift: 7, inherited: s7.inherited });
    const f7 = await file();
    expect(f7.status === "filed", `FILED with the inherited trait; got ${f7.status}: ${f7.text}`);
    const r7 = await recordFiled(s7, f7, "shift 7 (epoch 1, inherited)");
    expect(Number(r7.event.epoch) === 1, `the event to say epoch 1; got ${r7.event.epoch}`);
    expect(/Filed into epoch 1.s pile: \d+ BTC · \d+ ETH · \d+ HEMI\./.test(f7.text), `the pile line to name epoch 1; got: ${f7.text}`);
    const diet1 = await publicClient.readContract({ address: deployed.address, abi: feedRegistryAbi, functionName: "diet", args: [1n] });
    expect(diet1[3] === 1n && diet1[0] === BigInt(r7.result.btcFed) && diet1[1] === BigInt(r7.result.ethFed) && diet1[2] === BigInt(r7.result.hemiFed), `diet(1) to hold exactly this run; got ${json(diet1)}`);
    await shoot("13-report-filed-inherited", { shift: 7, epoch: 1 });
    log(`stage 2: epoch 1 inherits ${traitName} from diet(0); the ticket said so, the page started with it, the filing landed in diet(1)`);

    // ================================================================
    // 11. The ledger page in epoch 1: what epoch 0 passed on, what epoch 1 came in with, both boards.
    // ================================================================
    await waitForRuns(sum.runs + 1n, 1);
    const ledger1 = await readLedger();
    manifest.chain.ledgerEpoch1 = ledger1;
    expect(ledger1.cards.map((c) => `${c.head}${c.now ? "*" : ""}`).join(",") === "EPOCH 1*,EPOCH 0", `the strip: EPOCH 1 (NOW), then EPOCH 0; got ${json(ledger1.cards)}`);
    expect(ledger1.cards[0].traits[0] === `CAME IN WITH${TRAIT[dominantOnChain]} from epoch 0` && ledger1.cards[1].traits[1] === `PASSES ON${TRAIT[dominantOnChain]}`, `epoch 0 passes on ${TRAIT[dominantOnChain]} and epoch 1 came in with it; got ${json(ledger1.cards.map((c) => c.traits))}`);
    expect(ledger1.tab === "Epoch 1" && ledger1.rows.length === 1 && ledger1.rows[0].score === BigInt(r7.result.score).toLocaleString("en-US"), `epoch 1's board: shift 7 alone; got ${json({ tab: ledger1.tab, rows: ledger1.rows })}`);
    expect(await traceLinkMatches(ledger1.rows[0].trace, r7), `epoch 1's Trace link to serve shift 7's trace; got ${ledger1.rows[0].trace}`);
    await ledgerShot("14-ledger-epoch-1", { epoch: 1, rows: ledger1.rows.length });
    await page.getByRole("tab", { name: "All time" }).click();
    await settle(page, 2);
    const allTimeRows = await page.evaluate(() => [...document.querySelectorAll(".ledger-table tbody tr")].map((tr) => ({ score: tr.querySelector(".score")?.textContent ?? null, epoch: tr.querySelector(".col-epoch")?.textContent ?? null })));
    const bestEver = onChainBest > BigInt(r7.result.score) ? { score: onChainBest, epoch: "0" } : { score: BigInt(r7.result.score), epoch: "1" };
    expect(allTimeRows.length === 1 && allTimeRows[0].score === bestEver.score.toLocaleString("en-US") && allTimeRows[0].epoch === bestEver.epoch, `all time: the player's best ever (${bestEver.score} in epoch ${bestEver.epoch}); got ${json(allTimeRows)}`);
    await page.getByRole("tab", { name: "Epoch 0" }).click();
    await settle(page, 2);
    const epoch0Rows = await page.evaluate(() => [...document.querySelectorAll(".ledger-table tbody tr")].map((tr) => tr.querySelector(".score")?.textContent ?? null));
    expect(epoch0Rows.length === 1 && epoch0Rows[0] === onChainBest.toLocaleString("en-US"), `epoch 0's board kept after the epoch turned; got ${json(epoch0Rows)}`);
    await ledgerShot("15-ledger-epoch-0-from-epoch-1", { epoch: 0 });
    log(`ledger: epoch 0 passes on ${TRAIT[dominantOnChain]}, epoch 1 came in with it; boards per epoch and all time agree with the chain`);
    ok = manifest.pageErrors.length === 0;
    if (!ok) log(`page errors: ${manifest.pageErrors.join(" | ")}`);
  } catch (error) {
    manifest.errors.push(error.stack ?? String(error));
    console.error(error);
  } finally {
    manifest.finishedAt = new Date().toISOString();
    manifest.ok = ok;
    await writeFile(path.join(outDir, "manifest.json"), `${json(manifest, 2)}\n`);
    await cleanup();
  }
  log(`${ok ? "PASS" : "FAIL"}: ${manifest.shots.length} shots, ${manifest.shifts.length} shifts; manifest at ${path.relative(ROOT, path.join(outDir, "manifest.json"))}`);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
