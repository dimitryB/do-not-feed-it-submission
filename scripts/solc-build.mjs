#!/usr/bin/env node
/**
 * Compile contracts/ with solc-js (the compiler bundled in the `solc` npm
 * package) and write Hardhat-3 artifacts, for machines that cannot download
 * a solc binary. Same settings as the `production` build profile in
 * hardhat.config.ts: 0.8.28, paris, viaIR, optimizer on at 200 runs.
 *
 *   node scripts/solc-build.mjs            # writes artifacts/
 *   npm run test:contract:js               # build, then hardhat test --no-compile
 *
 * `npx hardhat compile` is still the reference build; this one exists so the
 * contract tests can run in a workspace with no access to
 * binaries.soliditylang.org.
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const solc = require("solc");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractsDir = join(root, "contracts");
const artifactsDir = join(root, "artifacts");

const sources = {};
for (const name of readdirSync(contractsDir)) {
  if (!name.endsWith(".sol")) continue;
  sources[`contracts/${name}`] = { content: readFileSync(join(contractsDir, name), "utf8") };
}

function findImports(path) {
  try {
    return { contents: readFileSync(join(root, "node_modules", path), "utf8") };
  } catch {
    return { error: `File not found: ${path}` };
  }
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    evmVersion: "paris",
    viaIR: true,
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (output.errors ?? []).filter((e) => e.severity === "error");
for (const e of output.errors ?? []) console.error(e.formattedMessage);
if (errors.length) {
  console.error(`solc: ${errors.length} error(s)`);
  process.exit(1);
}

rmSync(artifactsDir, { recursive: true, force: true });
const buildInfoId = `solcjs-${Date.now().toString(36)}`;
let count = 0;
for (const [sourceName, contracts] of Object.entries(output.contracts)) {
  if (!sourceName.startsWith("contracts/")) continue;
  for (const [contractName, contract] of Object.entries(contracts)) {
    const artifact = {
      _format: "hh3-artifact-1",
      contractName,
      sourceName,
      abi: contract.abi,
      bytecode: "0x" + contract.evm.bytecode.object,
      deployedBytecode: "0x" + contract.evm.deployedBytecode.object,
      linkReferences: contract.evm.bytecode.linkReferences ?? {},
      deployedLinkReferences: contract.evm.deployedBytecode.linkReferences ?? {},
      immutableReferences: contract.evm.deployedBytecode.immutableReferences ?? {},
      inputSourceName: `project/${sourceName}`,
      buildInfoId,
    };
    const dir = join(artifactsDir, sourceName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${contractName}.json`), JSON.stringify(artifact, null, 2));
    console.log(`${relative(root, join(dir, `${contractName}.json`))}  ${(contract.evm.deployedBytecode.object.length / 2).toLocaleString()} bytes`);
    count += 1;
  }
}
mkdirSync(join(artifactsDir, "build-info"), { recursive: true });
writeFileSync(join(artifactsDir, "build-info", `${buildInfoId}.json`), JSON.stringify({ _format: "hh3-sol-build-info-1", id: buildInfoId, solcVersion: "0.8.28", solcLongVersion: solc.version(), compilerType: "solcjs", input }, null, 2));
console.log(`${count} artifact(s) written with solc-js ${solc.version()}`);
