/**
 * Deploy FeedRegistry v1 to Hemi Mainnet (docs/CHAIN.md §5).
 *
 *   npx hardhat run scripts/deploy-registry.ts --network hemi
 *
 * Reads (hardhat.config.ts configVariables): HEMI_RPC_URL, HEMI_DEPLOYER_PRIVATE_KEY.
 * Reads (environment):
 *   DNFI_VERIFIER_ADDRESS  required — the address of DNFI_VERIFIER_PRIVATE_KEY, never the key
 *   DNFI_OWNER             optional — default: the deployer
 *   DNFI_EPOCH_SECONDS     optional — default 86400; the contract refuses anything under 3600
 * The game version is gameVersionId(GAME_VERSION) from lib/chain/types.ts: deploy
 * from the commit whose rules the verifier runs.
 *
 * Prints the address, GENESIS, the deploy block and the exact verify command.
 * It never prints a key. Deploying is a deliberate, manual step.
 */
import { network } from "hardhat";
import { getAddress, isAddress, type Address } from "viem";
import { GAME_VERSION } from "../lib/game/arcade.ts";
import { gameVersionId } from "../lib/chain/types.ts";

const DEFAULT_EPOCH_SECONDS = 86_400n;
const MIN_EPOCH_SECONDS = 3_600n;

function fail(message: string): never {
  console.error(`deploy-registry: ${message}`);
  process.exit(1);
}

function readAddress(name: string, fallback?: string): `0x${string}` {
  const value = process.env[name]?.trim() || fallback;
  if (!value) fail(`${name} is not set. Refusing to deploy with an unknown ${name === "DNFI_VERIFIER_ADDRESS" ? "verifier" : "owner"}.`);
  if (!isAddress(value)) fail(`${name} is not an address: ${value}`);
  if (/^0x0{40}$/.test(value)) fail(`${name} is the zero address.`);
  return getAddress(value);
}

function readEpochSeconds(): bigint {
  const raw = process.env.DNFI_EPOCH_SECONDS?.trim();
  if (!raw) return DEFAULT_EPOCH_SECONDS;
  if (!/^\d+$/.test(raw)) fail(`DNFI_EPOCH_SECONDS must be a whole number of seconds: ${raw}`);
  const seconds = BigInt(raw);
  if (seconds < MIN_EPOCH_SECONDS) fail(`DNFI_EPOCH_SECONDS must be at least ${MIN_EPOCH_SECONDS} (the contract's minimum): ${raw}`);
  return seconds;
}

async function main() {
  // Required first, so a run with nothing configured stops before touching the network.
  const verifier = readAddress("DNFI_VERIFIER_ADDRESS");
  const epochSeconds = readEpochSeconds();
  const gameVersion = gameVersionId(GAME_VERSION);

  const connection = await network.connect();
  const { viem, networkName } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();
  if (!deployer) fail("no deployer account: set HEMI_DEPLOYER_PRIVATE_KEY (hardhat keystore or environment).");
  const owner = readAddress("DNFI_OWNER", deployer.account.address);
  const chainId = await publicClient.getChainId();

  console.log(`network         ${networkName} (chainId ${chainId})`);
  console.log(`deployer        ${getAddress(deployer.account.address)}`);
  console.log(`owner           ${owner}${owner === getAddress(deployer.account.address) ? " (the deployer)" : ""}`);
  console.log(`verifier        ${verifier}`);
  console.log(`game version    ${GAME_VERSION} → ${gameVersion}`);
  console.log(`epoch seconds   ${epochSeconds}`);

  const { contract, deploymentTransaction } = await viem.sendDeploymentTransaction("FeedRegistry", [owner, verifier, gameVersion, epochSeconds]);
  console.log(`deploy tx       ${deploymentTransaction.hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentTransaction.hash });
  if (receipt.status !== "success" || !receipt.contractAddress) fail(`deployment reverted in block ${receipt.blockNumber}`);

  // The artifact's generated types exist only after `hardhat compile`; read back with explicit types so a solc-js build typechecks too.
  const registry = await viem.getContractAt("FeedRegistry", receipt.contractAddress);
  const [genesis, onChainEpoch, onChainVersion, onChainVerifier, onChainOwner] = (await Promise.all([
    registry.read.GENESIS(), registry.read.EPOCH_SECONDS(), registry.read.activeGameVersion(), registry.read.verifier(), registry.read.owner(),
  ])) as [bigint, bigint, `0x${string}`, Address, Address];
  if (onChainEpoch !== epochSeconds || onChainVersion !== gameVersion || getAddress(onChainVerifier) !== verifier || getAddress(onChainOwner) !== owner) {
    fail("the deployed contract does not read back the constructor arguments; do not use it.");
  }

  console.log("");
  console.log(`FeedRegistry    ${getAddress(contract.address)}`);
  console.log(`GENESIS         ${genesis} (${new Date(Number(genesis) * 1000).toISOString()})`);
  console.log(`deploy block    ${receipt.blockNumber}`);
  console.log(`gas used        ${receipt.gasUsed}`);
  console.log("");
  console.log("Worker / client configuration:");
  console.log(`  DNFI_CONTRACT_ADDRESS=${getAddress(contract.address)}`);
  console.log(`  DNFI_CHAIN_ID=${chainId}`);
  console.log(`  DNFI_EPOCH_SECONDS=${epochSeconds}`);
  console.log(`  indexer start block: ${receipt.blockNumber}`);
  console.log("");
  console.log("Verify on Blockscout (hardhat.config.ts has verify.blockscout enabled):");
  console.log(`  npx hardhat verify blockscout --network ${networkName} --build-profile production --contract contracts/FeedRegistry.sol:FeedRegistry -- ${getAddress(contract.address)} ${owner} ${verifier} ${gameVersion} ${epochSeconds}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
