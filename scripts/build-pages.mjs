#!/usr/bin/env node
/**
 * Build the full app for Cloudflare Pages Advanced Mode, including the chain API.
 * Produces dist/pages: public assets, _routes.json and a reserved _worker.js bundle.
 * This only builds and runs Wrangler's local dry run; it never deploys anything.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pagesConfig = JSON.parse(readFileSync(path.join(root, "cloudflare/pages/wrangler.jsonc"), "utf8"));
const work = path.join(root, ".wrangler/pages-build");
const output = path.join(root, "dist/pages");
const client = path.join(root, "dist/client");
const site = new URL(process.env.DNFI_SITE_URL?.trim() || "https://do-not-feed-it.pages.dev");
if (!/^https?:$/.test(site.protocol) || site.pathname !== "/" || site.search || site.hash || site.username || site.password) {
  throw new Error("DNFI_SITE_URL must be a public HTTP(S) origin without a path, query or credentials.");
}

const environment = {
  ...process.env,
  WRANGLER_LOG_PATH: path.join(root, ".wrangler/pages-build.log"),
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_WRITE_LOGS: "false",
};
function run(script, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root, env: { ...environment, ...extraEnv }, stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} failed (${result.signal || result.status}).`);
}
function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
// Pages configuration has no Worker main. Keep Vite's source configuration
// separate, with no machine-specific domain, D1 binding or chain settings.
const workerSettings = {
  name: pagesConfig.name,
  compatibility_date: pagesConfig.compatibility_date,
  compatibility_flags: pagesConfig.compatibility_flags,
};
const viteConfig = path.join(work, "worker.json");
writeJson(viteConfig, { ...workerSettings, main: "../../worker/index.ts" });
run("node_modules/vinext/dist/cli.js", ["build"], {
  DNFI_WRANGLER_CONFIG: path.relative(root, viteConfig),
  DNFI_SITE_URL: site.origin,
});

// Rebundle Vite's Worker and its SSR chunks into one self-contained module.
// Do not copy dist/server itself: it also contains deployment config, source
// maps and internal framework metadata that are not public static assets.
const bundleConfig = path.join(work, "bundle.json");
const bundle = path.join(work, "bundle");
writeJson(bundleConfig, { ...workerSettings, main: "../../dist/server/index.js" });
run("node_modules/wrangler/bin/wrangler.js", [
  "deploy", "--dry-run", "--config", bundleConfig, "--outdir", bundle,
  "--upload-source-maps=false", "--no-autoconfig",
]);
if (!existsSync(path.join(bundle, "index.js"))) throw new Error("Wrangler did not produce the Pages Worker entrypoint.");

rmSync(output, { recursive: true, force: true });
cpSync(client, output, {
  recursive: true,
  filter: (source) => !source.endsWith(".map") && !path.basename(source).startsWith("."),
});
if (existsSync(path.join(output, "_worker.js")) || existsSync(path.join(output, "_routes.json"))) {
  throw new Error("Client output contains a reserved Pages filename.");
}
const staticRoutes = readdirSync(output, { withFileTypes: true })
  .filter((entry) => !entry.name.startsWith("_"))
  .map((entry) => `/${entry.name}${entry.isDirectory() ? "/*" : ""}`)
  .sort();
if (staticRoutes.length >= 100 || staticRoutes.some((route) => route.startsWith("/api/"))) {
  throw new Error("Static assets cannot shadow the chain API or exceed Pages' route limit.");
}
const workerOutput = path.join(output, "_worker.js");
mkdirSync(workerOutput);
for (const entry of readdirSync(bundle, { withFileTypes: true })) {
  if (entry.name.endsWith(".map") || entry.name === "README.md") continue;
  if (!entry.isFile() || !/\.(?:[cm]?js|wasm)$/.test(entry.name)) {
    throw new Error(`Unexpected Wrangler bundle output: ${entry.name}`);
  }
  cpSync(path.join(bundle, entry.name), path.join(workerOutput, entry.name));
}
writeJson(path.join(output, "_routes.json"), {
  version: 1, include: ["/*"], exclude: staticRoutes,
});
// Vite's Workers deployment redirect must not override the separate Pages
// configuration when Wrangler later discovers the deployment target.
rmSync(path.join(root, ".wrangler/deploy/config.json"), { force: true });
console.log(`Pages output: ${path.relative(root, output)} (${site.origin})`);
console.log("Deploy with: npx wrangler pages deploy --cwd cloudflare/pages --project-name do-not-feed-it --branch main");
