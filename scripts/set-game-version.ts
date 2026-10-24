/**
 * Rotate the deployed FeedRegistry to this checkout's rules version
 * (docs/CHAIN.md §3): `setGameVersion(gameVersionId(GAME_VERSION))`, owner only.
 *
 *   DNFI_CONTRACT_ADDRESS=0x… npx hardhat run scripts/set-game-version.ts --network hemi
 *
 * Reads (hardhat.config.ts configVariables): HEMI_RPC_URL, HEMI_DEPLOYER_PRIVATE_KEY
 * (the owner's key, from the Hardhat keystore or the environment).
 * Reads (environment):
 *   DNFI_CONTRACT_ADDRESS  required — the registry to rotate
 *   DNFI_DRY_RUN           optional — 1 simulates the call and sends nothing
 *
 * Refuses when the unlocked account is not the owner or the registry already
 * accepts this version. Rotate only when the Pages deployment that serves the
 * same GAME_VERSION goes live: filings under the old number stop at once.
 * It never prints a key.
 */
import { network } from "hardhat";
import { formatEther, getAddress, isAddress, parseAbi } from "viem";
import { GAME_VERSION } from "../lib/game/arcade.ts";
import { gameVersionId } from "../lib/chain/types.ts";

const abi = parseAbi([
  "function owner() view returns (address)",
  "function activeGameVersion() view returns (bytes32)",
  "function setGameVersion(bytes32 nextVersion)",
]);

function fail(message: string): never {
  console.error(`set-game-version: ${message}`);
  process.exit(1);
}

async function main() {
  const raw = process.env.DNFI_CONTRACT_ADDRESS?.trim();
  if (!raw || !isAddress(raw)) fail("DNFI_CONTRACT_ADDRESS must be the registry's address.");
  const address = getAddress(raw);
  const next = gameVersionId(GAME_VERSION);

  const { viem, networkName } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  if (!wallet) fail("no account: set HEMI_DEPLOYER_PRIVATE_KEY (hardhat keystore or environment).");
  const account = getAddress(wallet.account.address);
  const [owner, current, chainId, balance] = await Promise.all([
    publicClient.readContract({ address, abi, functionName: "owner" }),
    publicClient.readContract({ address, abi, functionName: "activeGameVersion" }),
    publicClient.getChainId(),
    publicClient.getBalance({ address: account }),
  ]);

  console.log(`network         ${networkName} (chainId ${chainId})`);
  console.log(`registry        ${address}`);
  console.log(`owner           ${getAddress(owner)}`);
  console.log(`account         ${account} (${formatEther(balance)} ETH)`);
  console.log(`accepted now    ${current}`);
  console.log(`rotate to       ${next} (GAME_VERSION ${GAME_VERSION})`);

  if (getAddress(owner) !== account) fail("the unlocked account is not the registry's owner; no transaction was sent.");
  if (current.toLowerCase() === next.toLowerCase()) fail(`the registry already accepts GAME_VERSION ${GAME_VERSION}; nothing to do.`);

  const { request } = await publicClient.simulateContract({ account, address, abi, functionName: "setGameVersion", args: [next] });
  if (process.env.DNFI_DRY_RUN === "1") {
    console.log("Dry run: the call simulates cleanly; no transaction was sent.");
    return;
  }
  const hash = await wallet.writeContract(request);
  console.log(`tx              ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") fail(`setGameVersion reverted in block ${receipt.blockNumber}`);
  const after = await publicClient.readContract({ address, abi, functionName: "activeGameVersion" });
  if (after.toLowerCase() !== next.toLowerCase()) fail(`read back ${after}, expected ${next}`);
  console.log(`done            block ${receipt.blockNumber}; the registry now accepts GAME_VERSION ${GAME_VERSION}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
