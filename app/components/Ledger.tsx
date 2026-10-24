"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Address, Hex } from "viem";
import type { ArcadeCommand, Ingredient } from "../../lib/game/arcade";
import { ChainApiError, addressUrl, chainFromConfig, fetchConfig, fetchWorld, requestTicket, ticketIsFresh, txUrl, type ChainConfig, type ChainInfo, type Ticket, type World } from "../../lib/chain/api";
import { attest as attestCall } from "../../lib/chain/api";
import {
  OFF_DISABLED, OFF_PRACTICE, READY, isCancellable, playedNumbers, reduce, runLedger, sessionFilingStore,
  type Filing, type LedgerDeps, type LedgerInput, type LedgerState,
} from "../../lib/chain/ledger";
import { HEMI_CHAIN_ID, inheritedOf, type RunResult } from "../../lib/chain/types";
import { epochSpan } from "../../lib/chain/ledgerView";
import { connect, ensureChain, pickProvider, publicClientFor, publicClientOver, readBestScore, readUsedRunId, signResult, submitResult, waitForReceipt, walletClientFor, type Eip1193Provider } from "../../lib/chain/wallet";
import { DEV_HOOKS, devHookBag } from "../../lib/dev/hook";
import { INHERITED, LEDGER } from "../../lib/render/lore";
import { communityDietLine, type CommunityDiet } from "../../lib/community/diet";

/**
 * The ledger panel on the epoch report (docs/CHAIN.md §8) and the hook that
 * owns the page's view of the chain: the config, the world, the ticket for
 * the next shift and a filing remembered across a reload. The state machine
 * is `lib/chain/ledger.ts`; this file renders it and wires in the wallet and
 * the Worker. Every word comes from `LEDGER` in lib/render/lore.ts.
 */

/** Tickets that reached a report: a shift that ended cannot lend its ticket to the next one. */
const consumed = new Set<Hex>();
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
/** The resume driver never attests, so it never compares numbers; this is the placeholder its input carries. */
const NOTHING_PLAYED = playedNumbers({ score: 0, totalFeeds: 0, servings: { metal: 0, balloon: 0, pepper: 0 }, bestCombo: 0, frenzies: 0, size: 1, ending: 0, failureReason: null });

export interface ChainView {
  config: ChainConfig | null;
  world: World | null;
  info: ChainInfo;
  /** The diet line's input, from the pile: this epoch when it has runs, else last epoch. */
  diet: CommunityDiet | null;
  /**
   * What a shift started now inherits, as the world predicts it (the ticket
   * is the authority): the trait and the source pile's largest share, which
   * the client knows only when the source epoch is the previous one (the
   * world carries `pile.previous`). Null when nothing is inherited.
   */
  inherited: { trait: Ingredient; share: number | null } | null;
  /** The remembered filing (sent before a reload), as the resume driver last saw it. */
  filing: Filing | null;
  /** A ticket for the next shift, or null for practice: disabled, slow (1.5 s) or failed. */
  ticket: () => Promise<Ticket | null>;
  refreshWorld: () => void;
}

const dietOf = (world: World | null): CommunityDiet | null => {
  if (!world) return null;
  const pick = world.pile.current.runs > 0n ? { pile: world.pile.current, window: "this epoch" } : world.pile.previous.runs > 0n ? { pile: world.pile.previous, window: "last epoch" } : null;
  if (!pick) return null;
  return { btc: Number(pick.pile.btc), eth: Number(pick.pile.eth), hemi: Number(pick.pile.hemi), window: pick.window };
};

const inheritedOfWorld = (world: World | null): ChainView["inherited"] => {
  const trait = world ? inheritedOf(world.inherited) : null;
  if (!world || !trait) return null;
  const source = world.sourceEpoch === world.epoch - 1 ? world.pile.previous : null;
  const total = source ? Number(source.btc + source.eth + source.hemi) : 0;
  const top = source ? Number(trait === "metal" ? source.btc : trait === "balloon" ? source.eth : source.hemi) : 0;
  return { trait, share: source && total > 0 ? top / total : null };
};

/**
 * The real dependencies: the wallet is picked on connect; reads go over the
 * config's public RPC, or over the wallet's own connection when the config
 * gave none (a local chain in the end-to-end run).
 */
function realDeps(info: ChainInfo, contractAddress: Address): LedgerDeps {
  let provider: Eip1193Provider | null = null;
  let account: Address | null = null;
  let publicClient = info.rpcUrl ? publicClientFor(info) : null;
  const reader = () => { if (!publicClient && provider) publicClient = publicClientOver(provider, info); return publicClient; };
  const wallet = () => {
    if (!provider || !account) throw new Error("Wallet not connected");
    return walletClientFor(provider, info, account);
  };
  const deps: LedgerDeps = {
    async connect() { provider ??= await pickProvider(); account = await connect(provider); return account; },
    async ensureChain() { if (!provider) throw new Error("Wallet not connected"); await ensureChain(provider, info); },
    attest: (request, signal) => attestCall(request, { signal }),
    sign: (typedData, player) => signResult(wallet(), player, typedData),
    send: (result, playerSig, verifierSig, player) => submitResult(wallet(), reader(), player, info, contractAddress, result, playerSig, verifierSig),
    async waitForReceipt(txHash, runId, timeoutMs, signal) {
      const client = reader();
      if (!client) throw new ChainApiError("unavailable", "No RPC for this chain");
      return waitForReceipt(client, txHash, timeoutMs, contractAddress, runId, signal);
    },
    async bestScore(player) { const client = reader(); return client ? readBestScore(client, contractAddress, player) : null; },
    async usedRunId(runId) { const client = reader(); if (!client) throw new ChainApiError("unavailable", "No RPC for this chain"); return readUsedRunId(client, contractAddress, runId); },
    store: sessionFilingStore(typeof sessionStorage === "undefined" ? null : sessionStorage),
    now: () => Math.floor(Date.now() / 1000),
  };
  if (DEV_HOOKS) {
    // Development only: a harness may shorten the receipt cap or replace a dependency.
    const bag = devHookBag() as { ledgerOptions?: { receiptTimeoutMs?: number }; ledgerDeps?: Partial<LedgerDeps> } | null;
    if (bag?.ledgerOptions?.receiptTimeoutMs) deps.receiptTimeoutMs = bag.ledgerOptions.receiptTimeoutMs;
    if (bag?.ledgerDeps) Object.assign(deps, bag.ledgerDeps);
  }
  return deps;
}

export function useChain(): ChainView {
  const [config, setConfig] = useState<ChainConfig | null>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [filing, setFiling] = useState<Filing | null>(null);
  const configRef = useRef<ChainConfig | null>(null);
  const spare = useRef<Ticket | null>(null);
  const info = useMemo(() => chainFromConfig(config), [config]);
  useEffect(() => {
    const controller = new AbortController();
    void fetchConfig({ signal: controller.signal }).then(async (c) => {
      if (controller.signal.aborted) return;
      configRef.current = c;
      setConfig(c);
      if (c.enabled) {
        const latest = await fetchWorld({ signal: controller.signal });
        if (!controller.signal.aborted) setWorld(latest);
      }
    }).catch(() => { /* practice, or no community strip */ });
    return () => controller.abort();
  }, []);
  // A transaction sent before a reload: pick it up where it was.
  useEffect(() => {
    if (!config?.enabled || !config.contractAddress) return;
    const store = sessionFilingStore(typeof sessionStorage === "undefined" ? null : sessionStorage);
    const remembered = store.read();
    if (!remembered) return;
    const controller = new AbortController();
    // Shown as remembered first (off the render path: sessionStorage is the client's, the server rendered none), then as the chain says.
    queueMicrotask(() => { if (!controller.signal.aborted) setFiling(remembered); });
    if (remembered.status !== "pending") return () => controller.abort();
    const deps = realDeps(info, config.contractAddress);
    const stub: Ticket = { runId: remembered.runId, seed: 0, issuedAt: 0, expiresAt: 0, epoch: 0, snapshotHash: ZERO32, sourceEpoch: null, inherited: 0, snapshot: { btc: 0n, eth: 0n, hemi: 0n, runs: 0n, dominant: 0 } };
    const input: LedgerInput = { ticket: stub, commands: [], endTick: 0, played: NOTHING_PLAYED, contractAddress: config.contractAddress, chainId: info.id };
    void runLedger({ input, deps, emit: () => setFiling(deps.store.read()), signal: controller.signal, resume: { txHash: remembered.txHash, player: remembered.player } })
      .then((state) => { if (state.status === "filed") void fetchWorld().then(setWorld).catch(() => {}); });
    return () => controller.abort();
  }, [config, info]);
  const refreshWorld = useCallback(() => {
    if (configRef.current?.enabled) void fetchWorld().then(setWorld).catch(() => { /* keep the old one */ });
  }, []);
  const ticket = useCallback(async () => {
    const current = configRef.current;
    if (!current?.enabled) return null;
    const now = Math.floor(Date.now() / 1000);
    if (spare.current && ticketIsFresh(spare.current, now) && !consumed.has(spare.current.runId)) return spare.current;
    try {
      const issued = await requestTicket();
      spare.current = issued;
      return issued;
    } catch { return null; }
  }, []);
  const diet = useMemo(() => dietOf(world), [world]);
  const inherited = useMemo(() => inheritedOfWorld(world), [world]);
  return { config, world, info, diet, inherited, filing, ticket, refreshWorld };
}

/** The title shows the available chain; only a started shift needs a ticket. */
export function headerLabel(ticket: Ticket | null, info: ChainInfo, shiftNo: number, config: ChainConfig | null, hasShift: boolean): string {
  const chain = info.id === HEMI_CHAIN_ID ? LEDGER.header.hemi : LEDGER.header.chain(info.id);
  if (ticket) return `${chain} · ${LEDGER.header.shift(shiftNo)}`;
  if (hasShift || config?.enabled === false) return LEDGER.header.practice;
  return config?.enabled ? chain : LEDGER.header.ready;
}

const formatScore = (value: bigint | number) => value.toLocaleString("en-US");
const formatBlock = (value: bigint) => value.toLocaleString("en-US");

function ExplorerLink({ info, txHash }: { info: ChainInfo; txHash: Hex }) {
  const href = txUrl(info, txHash);
  if (!href) return null;
  return <a className="ledger-link" href={href} target="_blank" rel="noreferrer">{LEDGER.lines.explorer(info.label)}</a>;
}

/** On the title: the shift filed (or still pending) before a reload. */
export function LastFiling({ chain }: { chain: ChainView }) {
  const { filing, info } = chain;
  if (!filing) return null;
  const line = filing.status === "filed" ? LEDGER.last.filed(info.label) : filing.status === "reverted" ? LEDGER.last.reverted : LEDGER.last.pending(info.label);
  return <p className="last-filing">{line} <ExplorerLink info={info} txHash={filing.txHash} /></p>;
}

/**
 * The report's line about the pile (docs/CHAIN.md §7, §10.4): the epoch the
 * contract credited when the receipt carried this run's PileFed; the cap when
 * it carried only ResultRecorded (the wallet's first three filings this epoch
 * already fed it); and when no receipt of ours was read (DuplicateRun, filed
 * elsewhere), only what the shift itself fed, claiming no pile.
 */
function pileLine(epoch: bigint | null, fedPile: boolean | null, result: Pick<RunResult, "btcFed" | "ethFed" | "hemiFed">): string {
  if (epoch !== null && fedPile === true) return LEDGER.lines.pile(epoch.toString(), result.btcFed, result.ethFed, result.hemiFed);
  if (epoch !== null && fedPile === false) return LEDGER.lines.pileFull(epoch.toString());
  return LEDGER.lines.pileUnknownEpoch(result.btcFed, result.ethFed, result.hemiFed);
}

/** The clock in whole seconds, every `everyMs`; null until mounted, so the server render and the first client render agree. */
function useNowSeconds(everyMs: number): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, everyMs);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [everyMs]);
  return now;
}

/** When the world's current epoch, and its pile, closes (unix seconds): `GENESIS + (epoch + 1) × EPOCH_SECONDS`; null until GENESIS is known. */
const epochEndOf = (world: World | null): number | null => (world ? epochSpan(world.genesis, world.epochSeconds, world.epoch)?.to ?? null : null);

/** Seconds until this epoch's pile closes (docs/CHAIN.md §7); null when unknown, or once it has closed. */
function useSecondsToClose(world: World | null): number | null {
  const now = useNowSeconds(30_000);
  const endsAt = epochEndOf(world);
  const left = endsAt !== null && now !== null ? endsAt - now : null;
  return left !== null && left > 0 ? left : null;
}

/** After the diet line, in its sentence case: when the pile it names closes. */
export function DietClose({ chain }: { chain: ChainView }) {
  const left = useSecondsToClose(chain.world);
  if (left === null || !chain.diet) return null;
  return <> <span className="diet-closes">{INHERITED.closesAfterDiet(left, chain.diet.window)}</span></>;
}

/**
 * On the title, under the diet line: what last epoch's pile did to tonight's
 * creature (docs/CHAIN.md §10.4), and — only when there is no diet line to
 * carry it (`DietClose`) — when this epoch's pile closes. When the epoch
 * rolls over while the title is open, the world is fetched again once.
 */
export function InheritedLine({ chain }: { chain: ChainView }) {
  const { inherited, world, refreshWorld } = chain;
  const left = useSecondsToClose(world);
  const now = useNowSeconds(30_000);
  const endsAt = epochEndOf(world);
  const refreshedFor = useRef<number | null>(null);
  useEffect(() => {
    if (endsAt === null || now === null || now < endsAt || refreshedFor.current === endsAt) return;
    refreshedFor.current = endsAt;
    refreshWorld();
  }, [endsAt, now, refreshWorld]);
  const dietShown = communityDietLine(chain.diet) !== null;
  const closes = left !== null && !dietShown ? INHERITED.closes(left) : null;
  const line = inherited ? INHERITED.line(inherited.trait, inherited.share) : null;
  if (!line && !closes) return null;
  return (
    <p className="inherited-line">
      {line && <><span>{line.last}</span> <span>{line.tonight}</span></>}
      {line && closes && " "}
      {closes && <span className="pile-closes">{closes}</span>}
    </p>
  );
}

/** The ending's numbers, as the page shows them (the final `ArcadeState`); the panel compares the verifier's answer against these. */
export type Played = Parameters<typeof playedNumbers>[0];

/**
 * The panel. `commands` is the page's trace ref: it is read when the player
 * files, never during render. `played` is the page's own final state: the
 * numbers on the report, which the verifier's answer must match before the
 * wallet is asked for anything (M2). The panel only ever mounts on the
 * report, on the client, so the remembered filing can seed its first state.
 */
export function Ledger({ ticket, commands, endTick, played, chain }: { ticket: Ticket | null; commands: RefObject<readonly ArcadeCommand[]>; endTick: number; played: Played; chain: ChainView }) {
  const { config, info, refreshWorld } = chain;
  const contractAddress = config?.enabled ? config.contractAddress : null;
  const deps = useMemo(() => (contractAddress ? realDeps(info, contractAddress) : null), [info, contractAddress]);
  const [state, setState] = useState<LedgerState>(() => {
    if (!contractAddress || !deps) return OFF_DISABLED;
    if (!ticket) return OFF_PRACTICE;
    const remembered = deps.store.read();
    if (remembered && remembered.runId === ticket.runId) {
      if (remembered.status === "filed") return { status: "filed", player: remembered.player, txHash: remembered.txHash, blockNumber: BigInt(remembered.blockNumber ?? "0"), best: null, result: null, epoch: null, fedPile: null };
      if (remembered.status === "pending") return { status: "confirming", player: remembered.player, txHash: remembered.txHash, stalled: false, result: null };
    }
    return READY;
  });
  const stateRef = useRef(state);
  const abortRef = useRef<AbortController | null>(null);
  const set = useCallback((next: LedgerState) => { stateRef.current = next; setState(next); }, []);
  const run = useCallback((resume: { txHash: Hex; player: Address | null } | null = null) => {
    if (!ticket || !contractAddress || !deps) return;
    const input: LedgerInput = { ticket, commands: (commands.current ?? []).map((c) => ({ ...c })), endTick, played: playedNumbers(played), contractAddress, chainId: info.id };
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    void runLedger({ input, deps, emit: (s) => { if (!controller.signal.aborted) set(s); }, signal: controller.signal, resume })
      .then((final) => { if (!controller.signal.aborted && final.status === "filed") refreshWorld(); });
  }, [ticket, commands, endTick, played, contractAddress, deps, info.id, set, refreshWorld]);
  // A shift that reached the report cannot lend its ticket to the next one; and a
  // transaction sent for this very shift (then a reload) picks up its receipt.
  useEffect(() => {
    if (!ticket) return;
    consumed.add(ticket.runId);
    const remembered = deps?.store.read();
    if (remembered && remembered.runId === ticket.runId && remembered.status === "pending") run({ txHash: remembered.txHash, player: remembered.player });
  }, [ticket, deps, run]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (!DEV_HOOKS) return;
    const bag = devHookBag();
    if (!bag) return;
    bag.ledger = { state: () => stateRef.current };
    return () => { delete bag.ledger; };
  }, []);

  const file = () => run(null);
  const cancel = () => { abortRef.current?.abort(); set(reduce(stateRef.current, { type: "cancel" })); };
  const retry = () => {
    const current = stateRef.current;
    if (current.status === "confirming" && current.stalled) { run({ txHash: current.txHash, player: current.player }); return; }
    set(reduce(current, { type: "retry" }));
    run(null);
  };
  const skip = () => set(reduce(stateRef.current, { type: "skip" }));

  const label = info.label;
  let body: React.ReactNode;
  switch (state.status) {
    case "off":
      body = <p className="ledger-off">{state.reason === "skipped" ? LEDGER.skipped : LEDGER.practice}</p>;
      break;
    case "ready":
      body = <div className="ledger-row"><button className="ledger-button" onClick={file}>{LEDGER.button}</button><small className="ledger-gas">{LEDGER.gas}</small></div>;
      break;
    case "connecting":
    case "attesting":
    case "signing":
    case "sending":
      body = (
        <div className="ledger-row">
          <b className="ledger-caption">{LEDGER.captions[state.status]}</b>
          <span className="ledger-line">{LEDGER.lines[state.status]}</span>
          {isCancellable(state) && <button className="text-button ledger-action" onClick={cancel}>{LEDGER.actions.cancel}</button>}
        </div>
      );
      break;
    case "confirming":
      body = (
        <div className="ledger-row">
          <b className="ledger-caption">{LEDGER.captions.confirming}</b>
          <span className="ledger-line">{state.stalled ? LEDGER.lines.stalled(label) : LEDGER.lines.confirming(label)}</span>
          <ExplorerLink info={info} txHash={state.txHash} />
          {state.stalled && <button className="text-button ledger-action" onClick={retry}>{LEDGER.actions.check}</button>}
        </div>
      );
      break;
    case "filed": {
      // No transaction of its own (DuplicateRun, confirmed by usedRunIds): the line says so, and is the link to the registry's explorer page (one line at 1366).
      const registry = state.txHash || !contractAddress ? null : addressUrl(info, contractAddress);
      body = (
        <div className="ledger-row">
          <b className="ledger-caption">{LEDGER.captions.filed}</b>
          {state.txHash
            ? <span className="ledger-line">{state.blockNumber !== null ? LEDGER.lines.block(formatBlock(state.blockNumber)) : LEDGER.lines.already(label)}</span>
            : registry
              ? <a className="ledger-link ledger-line" href={registry} target="_blank" rel="noreferrer">{LEDGER.lines.alreadyLink(label)}</a>
              : <span className="ledger-line">{LEDGER.lines.already(label)}</span>}
          {state.txHash && <ExplorerLink info={info} txHash={state.txHash} />}
          {ticket && <a className="ledger-link" href={`/api/chain/trace?runId=${ticket.runId}`} target="_blank" rel="noreferrer" title={LEDGER.lines.traceTitle}>{LEDGER.lines.trace}</a>}
          {state.best !== null && <span className="ledger-best">{LEDGER.lines.best(label, formatScore(state.best))}</span>}
          {state.result && <span className="ledger-pile">{pileLine(state.epoch, state.fedPile, state.result)}</span>}
        </div>
      );
      break;
    }
    case "failed": {
      const f = state.failure;
      const reason = f.code === "reverted" && f.revert ? LEDGER.reverts[f.revert] : LEDGER.reasons[f.code];
      const text = typeof reason === "function" ? reason(label) : reason;
      body = (
        <div className="ledger-row">
          <b className="ledger-caption">{LEDGER.captions.failed}</b>
          <span className="ledger-line" title={f.detail}>{text}</span>
          {f.txHash && <ExplorerLink info={info} txHash={f.txHash} />}
          <button className="ledger-button ledger-retry" onClick={retry}>{LEDGER.actions.retry}</button>
          <button className="text-button ledger-action" onClick={skip}>{LEDGER.actions.skip}</button>
        </div>
      );
      break;
    }
  }
  return <div className={`ledger is-${state.status}`} role="status" aria-live="polite" data-ledger={state.status}>{body}</div>;
}
