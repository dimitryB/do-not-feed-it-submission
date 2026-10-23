/**
 * The player's wallet, in the browser only (docs/CHAIN.md §8). EIP-6963
 * discovery with a `window.ethereum` fallback, the chain switch, and viem
 * clients over the injected provider (signing, sending) and over the chain's
 * public RPC (receipts, reads). No private key exists here, ever: every
 * signature is the wallet's. Errors are classified into a short list of
 * codes the Ledger turns into plain words.
 */
import {
  BaseError, ChainMismatchError, ContractFunctionRevertedError, InsufficientFundsError, SwitchChainError, UserRejectedRequestError,
  createPublicClient, createWalletClient, custom, decodeErrorResult, defineChain, getAddress, http, numberToHex,
  type Address, type Chain, type Hex, type PublicClient, type WalletClient, decodeEventLog } from "viem";
import { feedRegistryAbi, resultTypedData, type RunResult } from "./types.ts";
import type { ChainInfo } from "./api.ts";

/** EIP-1193, the two calls' worth of it this module needs. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
}
export interface DiscoveredProvider {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
}

export type WalletErrorCode = "no_wallet" | "rejected" | "wrong_chain" | "insufficient_funds" | "reverted" | "network" | "unknown";
export type RevertName = "InvalidResult" | "InvalidSignature" | "DuplicateRun" | "WrongVersion" | "Expired";

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  /** The contract's custom error, when the code is `reverted` and it decoded. */
  readonly revert: RevertName | null;
  constructor(code: WalletErrorCode, message: string, revert: RevertName | null = null) {
    super(message);
    this.name = "WalletError";
    this.code = code;
    this.revert = revert;
  }
}

/** A viem chain from the Worker's config, so Hardhat's 31337 works in the end-to-end run. */
export function toViemChain(chain: ChainInfo): Chain {
  return defineChain({
    id: chain.id,
    name: chain.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: chain.rpcUrl ? [chain.rpcUrl] : [] } },
    ...(chain.explorerUrl ? { blockExplorers: { default: { name: `${chain.label} Explorer`, url: chain.explorerUrl } } } : {}),
  });
}

// ---- discovery.

/**
 * EIP-6963: ask every wallet extension to announce itself and collect the
 * answers for a moment; fall back to `window.ethereum`. The first wallet to
 * announce wins (the common case is one wallet; a chooser is not worth its
 * screen space on the report). A dev harness that injects `window.ethereum`
 * lands on the fallback.
 */
export async function discoverProviders(waitMs = 250): Promise<DiscoveredProvider[]> {
  if (typeof window === "undefined") return [];
  const found: DiscoveredProvider[] = [];
  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<DiscoveredProvider>).detail;
    if (detail?.provider && typeof detail.provider.request === "function" && !found.some((p) => p.info?.uuid === detail.info?.uuid)) found.push(detail);
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  try {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  } finally {
    window.removeEventListener("eip6963:announceProvider", onAnnounce);
  }
  return found;
}

export async function pickProvider(): Promise<Eip1193Provider> {
  const announced = await discoverProviders();
  if (announced.length) return announced[0].provider;
  const injected = typeof window !== "undefined" ? (window as unknown as { ethereum?: Eip1193Provider }).ethereum : undefined;
  if (injected && typeof injected.request === "function") return injected;
  throw new WalletError("no_wallet", "No wallet found");
}

// ---- connect and the chain.

export async function connect(provider: Eip1193Provider): Promise<Address> {
  let accounts: unknown;
  try {
    accounts = await provider.request({ method: "eth_requestAccounts" });
  } catch (error) {
    throw classifyWalletError(error);
  }
  const first = Array.isArray(accounts) ? accounts[0] : null;
  if (typeof first !== "string") throw new WalletError("no_wallet", "The wallet returned no account");
  try { return getAddress(first); } catch { throw new WalletError("no_wallet", "The wallet returned a malformed account"); }
}

export async function currentChainId(provider: Eip1193Provider): Promise<number> {
  const id = await provider.request({ method: "eth_chainId" });
  if (typeof id === "string") return Number.parseInt(id, 16);
  if (typeof id === "number") return id;
  throw new WalletError("unknown", "The wallet returned no chain id");
}

const isAddChainNeeded = (error: unknown): boolean => {
  const code = (error as { code?: unknown })?.code;
  const message = String((error as { message?: unknown })?.message ?? "");
  const inner = (error as { data?: { originalError?: { code?: unknown } } })?.data?.originalError?.code;
  return code === 4902 || inner === 4902 || /unrecognized chain|not added|4902/i.test(message);
};

/**
 * Switch the wallet to the chain; when the wallet does not know it (4902),
 * add it with the public RPC and the explorer, then check `eth_chainId`
 * again. A refusal at any point is `wrong_chain`.
 */
export async function ensureChain(provider: Eip1193Provider, chain: ChainInfo): Promise<void> {
  const want = chain.id;
  const hex = numberToHex(want);
  if ((await currentChainId(provider)) === want) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (error) {
    if (isUserRejection(error)) throw new WalletError("rejected", "Chain switch cancelled");
    if (!isAddChainNeeded(error)) throw new WalletError("wrong_chain", (error as Error)?.message ?? "Could not switch chain");
    try {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hex, chainName: chain.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: chain.rpcUrl ? [chain.rpcUrl] : [], ...(chain.explorerUrl ? { blockExplorerUrls: [chain.explorerUrl] } : {}),
        }],
      });
    } catch (addError) {
      if (isUserRejection(addError)) throw new WalletError("rejected", "Adding the chain was cancelled");
      throw new WalletError("wrong_chain", (addError as Error)?.message ?? "Could not add chain");
    }
  }
  if ((await currentChainId(provider)) !== want) throw new WalletError("wrong_chain", "The wallet stayed on another chain");
}

// ---- the clients.

export function walletClientFor(provider: Eip1193Provider, chain: ChainInfo, account: Address): WalletClient {
  return createWalletClient({ account, chain: toViemChain(chain), transport: custom(provider) });
}

export function publicClientFor(chain: ChainInfo): PublicClient {
  return createPublicClient({ chain: toViemChain(chain), transport: http(chain.rpcUrl || undefined) });
}

/** Reads over the wallet's own connection, for a chain the config gave no public RPC for (a local Hardhat node in the end-to-end run). */
export function publicClientOver(provider: Eip1193Provider, chain: ChainInfo): PublicClient {
  return createPublicClient({ chain: toViemChain(chain), transport: custom(provider) });
}

export type ResultTypedData = ReturnType<typeof resultTypedData>;

/** The player's EIP-712 signature over the result. The wallet shows every field. */
export async function signResult(client: WalletClient, account: Address, typedData: ResultTypedData): Promise<Hex> {
  try {
    return await client.signTypedData({ account, domain: typedData.domain, types: typedData.types, primaryType: typedData.primaryType, message: typedData.message });
  } catch (error) {
    throw classifyWalletError(error);
  }
}

/**
 * `submitResult` on the registry. Simulated first over the public RPC, so a
 * refusal comes back as the contract's own error (decoded below) before the
 * wallet opens and before any gas is spent; a simulation that fails for
 * network reasons is not a refusal, and the transaction goes to the wallet
 * anyway (the wallet has its own RPC).
 */
export async function submitResult(
  client: WalletClient, publicClient: PublicClient | null, account: Address, chain: ChainInfo, contractAddress: Address,
  result: RunResult, playerSignature: Hex, verifierSignature: Hex,
): Promise<Hex> {
  const args = [result, playerSignature, verifierSignature] as const;
  if (publicClient) {
    try {
      await publicClient.simulateContract({ account, address: contractAddress, abi: feedRegistryAbi, functionName: "submitResult", args });
    } catch (error) {
      const classified = classifyWalletError(error);
      if (classified.code === "reverted" || classified.code === "insufficient_funds") throw classified;
    }
  }
  try {
    return await client.writeContract({ account, chain: toViemChain(chain), address: contractAddress, abi: feedRegistryAbi, functionName: "submitResult", args });
  } catch (error) {
    throw classifyWalletError(error);
  }
}

/**
 * A mined transaction. `recorded` is the registry's `ResultRecorded` for the
 * run this receipt was waited for — null when the mined transaction did not
 * file it: a replacement (a cancel or a speed-up with other calldata) mines
 * under the same nonce with `status: "success"` and the wallet's own hash is
 * then never found, so a success without the event is not a filing.
 */
export interface Receipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  /** The hash that mined — the replacement's when the wallet replaced ours. */
  txHash: Hex;
  recorded: Recorded | null;
}

/** What the registry said about a filing: its epoch, its wallet, and whether it fed the pile (a `PileFed` beside it). */
export interface Recorded { epoch: bigint; player: Address; fedPile: boolean }

/**
 * The registry's `ResultRecorded` for `runId` in a receipt's logs, if it is
 * there, and whether a `PileFed` for the same run came with it — a wallet's
 * filings past `PILE_FILINGS_PER_EPOCH` in an epoch are recorded but feed
 * nothing (docs/CHAIN.md §7).
 */
export function recordedIn(logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[], contractAddress: Address, runId: Hex): Recorded | null {
  let recorded: Omit<Recorded, "fedPile"> | null = null;
  let fedPile = false;
  for (const log of logs) {
    if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: feedRegistryAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (decoded.eventName === "ResultRecorded" && decoded.args.runId.toLowerCase() === runId.toLowerCase()) {
        recorded = { epoch: BigInt(decoded.args.epoch), player: decoded.args.player };
      } else if (decoded.eventName === "PileFed" && decoded.args.runId.toLowerCase() === runId.toLowerCase()) {
        fedPile = true;
      }
    } catch { /* another event */ }
  }
  return recorded ? { ...recorded, fedPile } : null;
}

/** Polls for the receipt; null when the cap passes first (the transaction may still land). Follows a replacement and says so through `recorded`. */
export async function waitForReceipt(publicClient: PublicClient, txHash: Hex, timeoutMs: number, contractAddress: Address, runId: Hex, signal?: AbortSignal): Promise<Receipt | null> {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: timeoutMs, pollingInterval: 2_000, retryCount: 3 });
    if (signal?.aborted) return null;
    return { status: receipt.status, blockNumber: receipt.blockNumber, txHash: receipt.transactionHash, recorded: receipt.status === "success" ? recordedIn(receipt.logs, contractAddress, runId) : null };
  } catch (error) {
    if (signal?.aborted) return null;
    const name = (error as { name?: string })?.name ?? "";
    if (/WaitForTransactionReceiptTimeoutError|TimeoutError/.test(name)) return null;
    throw classifyWalletError(error);
  }
}

export async function readBestScore(publicClient: PublicClient, contractAddress: Address, player: Address): Promise<bigint> {
  try {
    const best = await publicClient.readContract({ address: contractAddress, abi: feedRegistryAbi, functionName: "bestScore", args: [player] });
    return BigInt(best);
  } catch (error) {
    throw classifyWalletError(error);
  }
}

/** `usedRunIds(runId)`: whether the registry already holds this shift (asked after a DuplicateRun refusal, so the report can say FILED instead of offering a retry that can only fail again). */
export async function readUsedRunId(publicClient: PublicClient, contractAddress: Address, runId: Hex): Promise<boolean> {
  try {
    return Boolean(await publicClient.readContract({ address: contractAddress, abi: feedRegistryAbi, functionName: "usedRunIds", args: [runId] }));
  } catch (error) {
    throw classifyWalletError(error);
  }
}

// ---- classification.

const REVERTS: readonly RevertName[] = ["InvalidResult", "InvalidSignature", "DuplicateRun", "WrongVersion", "Expired"];

function isUserRejection(error: unknown): boolean {
  if (error instanceof UserRejectedRequestError) return true;
  const code = (error as { code?: unknown })?.code;
  const message = String((error as { message?: unknown })?.message ?? "");
  const inner = (error as { cause?: { code?: unknown } })?.cause?.code;
  return code === 4001 || inner === 4001 || /user rejected|user denied|rejected the request|user cancel/i.test(message);
}

/** The contract's custom error name out of a viem error or raw revert data, when it is one of the registry's. */
function revertNameOf(error: unknown): RevertName | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof ContractFunctionRevertedError) {
      const name = current.data?.errorName as string | undefined;
      if (name && (REVERTS as readonly string[]).includes(name)) return name as RevertName;
    }
    const data = (current as { data?: unknown }).data;
    if (typeof data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(data)) {
      try {
        const decoded = decodeErrorResult({ abi: feedRegistryAbi, data: data as Hex });
        if ((REVERTS as readonly string[]).includes(decoded.errorName)) return decoded.errorName as RevertName;
      } catch { /* not one of ours */ }
    }
    const message = String((current as { message?: unknown }).message ?? "");
    for (const name of REVERTS) if (new RegExp(`\\b${name}\\(\\)`).test(message)) return name;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Any error from the wallet, the RPC or viem, as one of the Ledger's codes. A WalletError passes through. */
export function classifyWalletError(error: unknown): WalletError {
  if (error instanceof WalletError) return error;
  const message = (error instanceof BaseError ? error.shortMessage : (error as { message?: string })?.message) || String(error);
  if (isUserRejection(error)) return new WalletError("rejected", message);
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof ChainMismatchError || e instanceof SwitchChainError)) return new WalletError("wrong_chain", message);
    if (error.walk((e) => e instanceof InsufficientFundsError)) return new WalletError("insufficient_funds", message);
  }
  if (/insufficient funds/i.test(message)) return new WalletError("insufficient_funds", message);
  const revert = revertNameOf(error);
  if (revert) return new WalletError("reverted", message, revert);
  if (/\brevert/i.test(message) || error instanceof ContractFunctionRevertedError) return new WalletError("reverted", message);
  if (/chain|network id|wrong chain/i.test(message) && /mismatch|unsupported|does not match|wrong/i.test(message)) return new WalletError("wrong_chain", message);
  if (/HttpRequestError|TimeoutError|fetch|network|ECONN|Failed to fetch|timed out|timeout/i.test(`${(error as { name?: string })?.name ?? ""} ${message}`)) return new WalletError("network", message);
  return new WalletError("unknown", message);
}
