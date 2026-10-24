/**
 * Build a self-contained page that proves a browser's JavaScript engine runs
 * the rules bit for bit like Node and workerd.
 *
 *   node --experimental-strip-types scripts/engine-check.mjs [--out FILE] [--casual 6] [--naive 2] [--moderate 0]
 *
 * The page carries the bundled rules (lib/game/arcade.ts and what it imports),
 * the six frozen fixtures plus bot shifts for every inherited trait, Node's
 * digest of the whole state every ten seconds of each, and the exact-bit
 * digests of lib/game/detmath.ts. Open it in any browser: it replays every
 * shift and says PASS only if every checkpoint, every final state, every
 * signed number and every maths digest is identical. Nothing is fetched; it
 * works from file://.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as rules from "../lib/game/arcade.ts";
import * as detmath from "../lib/game/detmath.ts";
import { playShift } from "./loop-bots.mjs";
import { digestReplay } from "../tests/support/replay-digest.mjs";
import { goldenDigests } from "../tests/support/detmath-goldens.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = { out: "docs/qa/engines/engine-check.html", casual: 6, naive: 2, moderate: 0 };
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i].replace(/^--/, "");
  if (!(flag in args)) throw new Error(`unknown flag --${flag}`);
  args[flag] = flag === "out" ? process.argv[++i] : Number(process.argv[++i]);
}

const TRAITS = [null, "metal", "balloon", "pepper"];
const fixtures = JSON.parse(await readFile(path.join(ROOT, "tests/fixtures/loop-traces.json"), "utf8"));
const traces = fixtures.traces.map((t) => ({ name: `fixture ${t.bot}`, seed: t.seed, inherited: t.inherited ?? null, endTick: t.endTick, commands: t.commands }));
for (const [bot, count] of [["naive", args.naive], ["casual", args.casual], ["moderate", args.moderate]]) {
  for (const inherited of TRAITS) for (let i = 0; i < count; i++) {
    const seed = (0x0dbf00d + traces.length * 7919 + i * 104729) >>> 0;
    const run = playShift(bot, seed, { inherited });
    traces.push({ name: bot, seed, inherited, endTick: run.ticks, commands: run.commands });
  }
}
for (const t of traces) t.expect = digestReplay(rules, t);
const ticks = traces.reduce((sum, t) => sum + t.endTick, 0);

const bundle = await build({
  stdin: {
    contents: `export * as rules from "./lib/game/arcade.ts";
export * as detmath from "./lib/game/detmath.ts";
export { digestReplay } from "./tests/support/replay-digest.mjs";
export { goldenDigests } from "./tests/support/detmath-goldens.mjs";`,
    resolveDir: ROOT, sourcefile: "engine-check-entry.ts", loader: "ts",
  },
  bundle: true, format: "iife", globalName: "DNFI", target: "es2020", write: false, minify: false, legalComments: "inline",
});

// Commands as [tick, kind, ingredient, angle, power] to keep the page small.
const KIND = { launch: 0, hatch: 1, e: 2 };
const FOOD = { metal: 0, balloon: 1, pepper: 2 };
const data = {
  gameVersion: rules.GAME_VERSION,
  built: new Date().toISOString(),
  node: process.version,
  golden: goldenDigests(detmath),
  traces: traces.map((t) => ({
    name: t.name, seed: t.seed, inherited: t.inherited, endTick: t.endTick,
    commands: t.commands.map((c) => c.kind === "launch" ? [c.tick, KIND.launch, FOOD[c.ingredient], c.angle, c.power] : [c.tick, KIND[c.kind]]),
    expect: t.expect,
  })),
};

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DNFI engine check</title>
<style>
:root{--ink:#0f1918;--panel:#162423;--line:#2f403b;--paper:#e4ead9;--muted:#9aa995;--pass:#c8e17a;--fail:#ff7a5c}
*{box-sizing:border-box}body{margin:0;background:var(--ink);color:var(--paper);font:15px/1.5 -apple-system,'Helvetica Neue',Arial,sans-serif}
main{max-width:860px;margin:auto;padding:28px 16px 48px}h1{font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 18px;font-weight:700}
#verdict{font:800 clamp(44px,12vw,92px)/1 'Arial Black',Impact,sans-serif;letter-spacing:-.01em;margin:6px 0 10px}#verdict.pass{color:var(--pass)}#verdict.fail{color:var(--fail)}
#summary{font-size:17px;margin:0 0 6px}#engine{color:var(--muted);font-size:13px;word-break:break-word;margin:0 0 22px}
progress{width:100%;height:6px;accent-color:var(--pass)}table{width:100%;border-collapse:collapse;font-size:13px;margin-top:18px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}th{color:var(--muted);font-weight:600}
td.ok{color:var(--pass)}td.bad{color:var(--fail)}.note{color:var(--muted);font-size:13px;margin-top:22px}
</style></head><body><main>
<h1>Do Not Feed It · engine check · rules v${rules.GAME_VERSION}</h1>
<div id="verdict">…</div><p id="summary">Replaying ${traces.length} shifts (${Math.round(ticks / 3600)} minutes of play)…</p>
<p id="engine"></p><progress id="bar" max="${traces.length + 1}" value="0"></progress>
<table><thead><tr><th>Check</th><th>Trait</th><th>Seed</th><th>Length</th><th>Result</th></tr></thead><tbody id="rows"></tbody></table>
<p class="note">Built ${data.built} from Node ${data.node}. Every shift is replayed by this browser and compared with Node's digest of the whole game state every ten seconds, at the end, and on the numbers a filing signs. PASS means this engine computes the rules bit for bit like the verifier.</p>
</main>
<script>${bundle.outputFiles[0].text}</script>
<script>
const DATA = ${JSON.stringify(data)};
(async () => {
  const KIND = ["launch", "hatch"], FOOD = ["metal", "balloon", "pepper"];
  const rows = document.getElementById("rows"), bar = document.getElementById("bar");
  document.getElementById("engine").textContent = navigator.userAgent;
  const row = (cells, ok) => { const tr = document.createElement("tr"); cells.forEach((c, i) => { const td = document.createElement("td"); td.textContent = c; if (i === cells.length - 1) td.className = ok ? "ok" : "bad"; tr.appendChild(td); }); rows.appendChild(tr); };
  const result = { pass: true, shifts: 0, failures: [], golden: null, ms: 0 };
  const t0 = performance.now();
  const golden = DNFI.goldenDigests(DNFI.detmath);
  const badMath = Object.keys(DATA.golden).filter((k) => golden[k] !== DATA.golden[k]);
  result.golden = badMath.length ? badMath : "identical";
  row(["maths: " + Object.keys(DATA.golden).join(", "), "", "", "", badMath.length ? "differs: " + badMath.join(", ") : "identical"], !badMath.length);
  if (badMath.length) { result.pass = false; result.failures.push("maths " + badMath.join(",")); }
  bar.value = 1;
  for (const t of DATA.traces) {
    await new Promise((r) => setTimeout(r, 0));
    const trace = { seed: t.seed, inherited: t.inherited, endTick: t.endTick,
      commands: t.commands.map((c) => c[1] === 1 ? { tick: c[0], kind: "hatch" } : c[1] === 2 ? { tick: c[0], kind: "e" } : { tick: c[0], kind: "launch", ingredient: FOOD[c[2]], angle: c[3], power: c[4] }) };
    const got = DNFI.digestReplay(DNFI.rules, trace);
    const at = got.checkpoints.findIndex((d, i) => d !== t.expect.checkpoints[i]);
    const same = at < 0 && got.checkpoints.length === t.expect.checkpoints.length && got.final === t.expect.final && got.signed === t.expect.signed;
    const where = same ? "identical" : at >= 0 ? "parts by " + ((at + 1) * 10) + " s" : got.signed !== t.expect.signed ? "signed numbers differ" : "final state differs";
    row([t.name, t.inherited || "—", String(t.seed), Math.round(t.endTick / 60) + " s", where], same);
    if (!same) { result.pass = false; result.failures.push(t.name + "/" + (t.inherited || "-") + "/" + t.seed + ": " + where); }
    result.shifts++; bar.value++;
  }
  result.ms = Math.round(performance.now() - t0);
  const v = document.getElementById("verdict");
  v.textContent = result.pass ? "PASS" : "FAIL"; v.className = result.pass ? "pass" : "fail";
  document.getElementById("summary").textContent = (result.pass ? "Every shift identical: " : (result.failures.length + " of " + (DATA.traces.length + 1) + " checks differ. ")) + DATA.traces.length + " shifts, ${Math.round(ticks / 3600)} minutes of play, " + Object.keys(DATA.golden).length + " maths digests, in " + (result.ms / 1000).toFixed(1) + " s.";
  document.title = (result.pass ? "PASS" : "FAIL") + " · DNFI engine check";
  window.__engineCheck = result;
})().catch((e) => { document.getElementById("verdict").textContent = "ERROR"; document.getElementById("verdict").className = "fail"; document.getElementById("summary").textContent = String(e && e.stack || e); document.title = "ERROR · DNFI engine check"; window.__engineCheck = { pass: false, error: String(e) }; });
</script></body></html>
`;
const out = path.resolve(ROOT, args.out);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, page);
console.log(`wrote ${path.relative(ROOT, out)}: ${traces.length} shifts, ${ticks} ticks, ${(page.length / 1024).toFixed(0)} KB`);
