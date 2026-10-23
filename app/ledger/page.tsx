"use client";
/**
 * The ledger: every filed shift, by epoch, read from `GET /api/chain/world`
 * (docs/CHAIN.md §6, §10). The epochs strip says what each epoch was fed,
 * the trait its creature came in with and the coin it passes on; the board
 * switches between all time and any listed epoch. Everything here is a
 * cache of `ResultRecorded` events; each row links its trace and transaction.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { addressUrl, chainFromConfig, fetchConfig, fetchWorld, txUrl, type ChainConfig, type ChainInfo, type Keeper, type LedgerEpoch, type World } from "../../lib/chain/api";
import { defaultBoard, epochSpan, formatSpan, sharesOf, traitOf, uptime } from "../../lib/chain/ledgerView";
import { LEDGER_PAGE as COPY, TICKERS, TOKEN_TRAITS } from "../../lib/render/lore";
import { shortAddress } from "../components/TopKeepers";

const REFRESH_MS = 30_000;

type Load = { status: "loading" } | { status: "off" } | { status: "failed" } | { status: "ready"; config: ChainConfig; world: World };

export default function LedgerPage() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [board, setBoard] = useState<number | "all" | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    // Every state change happens after a network answer, never synchronously inside the effect.
    const read = () => fetchConfig({ signal })
      .then(async (config) => {
        if (!config.enabled) { setLoad({ status: "off" }); return; }
        const world = await fetchWorld({ signal });
        setLoad({ status: "ready", config, world });
      })
      .catch(() => { if (!signal.aborted) setLoad((previous) => (previous.status === "ready" ? previous : { status: "failed" })); });
    void read();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, REFRESH_MS);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);

  const ready = load.status === "ready" ? load : null;
  const info = useMemo(() => chainFromConfig(ready?.config ?? null), [ready?.config]);
  const epochRows = ready?.world.epochs ?? [];
  // A pick that is no longer listed (the strip moved on while the page was open) falls back to the default board.
  const picked = board === "all" || epochRows.some((e) => e.epoch === board) ? board : null;
  const selected = picked ?? (ready ? defaultBoard(ready.world.epochs, ready.world.epoch) : "all");
  const chosen = selected === "all" ? null : epochRows.find((e) => e.epoch === selected) ?? null;
  const rows = chosen ? chosen.top : ready?.world.top ?? [];

  return (
    <main className="ledger-page">
      <header className="masthead">
        <Link className="brand" href="/">
          <div className="brand-mark" aria-hidden="true">!</div>
          <div><h1>DO NOT FEED IT</h1><p>QUESTIONABLE APPETITES DAO</p></div>
        </Link>
        <Link className="ledger-back" href="/">{COPY.back}</Link>
      </header>

      <section className="ledger-hero">
        <div className="section-tag">{COPY.eyebrow(info.label)}</div>
        <h2>{COPY.headline[0]}<br /><span>{COPY.headline[1]}</span></h2>
        <p className="ledger-lede">{COPY.lede}</p>
        {ready && <AllTime world={ready.world} />}
      </section>

      {load.status === "loading" && <p className="ledger-note">{COPY.loading}</p>}
      {load.status === "off" && <p className="ledger-note">{COPY.off}</p>}
      {load.status === "failed" && <p className="ledger-note">{COPY.failed}</p>}

      {ready && (
        <>
          <section className="ledger-epochs" aria-label={COPY.epochsTitle}>
            <h3 className="ledger-h3">{COPY.epochsTitle}</h3>
            <ol>
              {epochRows.map((e) => (
                <li key={e.epoch}>
                  <EpochCard epoch={e} world={ready.world} current={e.epoch === ready.world.epoch} active={selected === e.epoch} onPick={() => setBoard(e.epoch)} />
                </li>
              ))}
            </ol>
          </section>

          <section className="ledger-board" aria-label={COPY.boardTitle}>
            <div className="ledger-board-head">
              <h3 className="ledger-h3">{COPY.boardTitle}</h3>
              <div className="ledger-tabs" role="tablist">
                <button role="tab" aria-selected={selected === "all"} onClick={() => setBoard("all")}>{COPY.tabAllTime}</button>
                {epochRows.map((e) => (
                  <button key={e.epoch} role="tab" aria-selected={selected === e.epoch} onClick={() => setBoard(e.epoch)}>{COPY.tabEpoch(e.epoch)}</button>
                ))}
              </div>
            </div>
            <Board rows={rows} info={info} showEpoch={selected === "all"} past={chosen !== null && chosen.epoch < ready.world.epoch} />
          </section>

          <Footer config={ready.config} world={ready.world} info={info} />
        </>
      )}
    </main>
  );
}

function AllTime({ world }: { world: World }) {
  const shares = sharesOf(world.pile.allTime);
  if (world.pile.allTime.runs === 0n) return null;
  return (
    <p className="ledger-alltime">
      <b>{COPY.allTime(world.pile.allTime.runs.toLocaleString("en-US"))}</b>
      {shares.map((s) => <span key={s.coin} className={`coin-count ${s.coin}`}><i aria-hidden="true" />{s.count.toLocaleString("en-US")} {TICKERS[s.ingredient]}</span>)}
    </p>
  );
}

function EpochCard({ epoch, world, current, active, onPick }: { epoch: LedgerEpoch; world: World; current: boolean; active: boolean; onPick: () => void }) {
  const shares = sharesOf(epoch.pile);
  const fed = epoch.pile.runs > 0n;
  const span = formatSpan(epochSpan(world.genesis, world.epochSeconds, epoch.epoch));
  const came = traitOf(epoch.inherited);
  const passes = traitOf(epoch.dominant);
  return (
    <button className={`epoch-card${current ? " is-now" : ""}`} aria-pressed={active} onClick={onPick}>
      <span className="epoch-card-head">
        <b>{COPY.epoch(epoch.epoch)}</b>
        {current && <em>{COPY.now}</em>}
      </span>
      {span && <span className="epoch-card-span">{span}</span>}
      {fed ? (
        <span className="share-bar" aria-hidden="true">
          {shares.filter((s) => s.percent > 0).map((s) => <i key={s.coin} className={s.coin} style={{ width: `${s.percent}%` }} />)}
        </span>
      ) : <span className="share-bar is-empty" aria-hidden="true" />}
      <span className="epoch-card-shares">
        {fed ? shares.map((s) => <span key={s.coin} className={`coin-count ${s.coin}`}><i aria-hidden="true" />{s.percent}% {TICKERS[s.ingredient]}</span>) : current ? COPY.nothingFed : COPY.nothingFedPast}
      </span>
      <span className="epoch-card-runs">{COPY.shifts(Number(epoch.pile.runs))}</span>
      <span className="epoch-card-trait">
        <small>{COPY.cameWith}</small>
        {epoch.inherited === null ? COPY.unknown : came ? <><strong>{TOKEN_TRAITS[came]}</strong>{epoch.sourceEpoch !== null && <span> {COPY.from(epoch.sourceEpoch)}</span>}</> : COPY.nothing}
      </span>
      <span className="epoch-card-trait">
        <small>{current ? COPY.leading : COPY.passesOn}</small>
        {passes ? <strong>{TOKEN_TRAITS[passes]}</strong> : COPY.nothing}
      </span>
    </button>
  );
}

function Board({ rows, info, showEpoch, past }: { rows: readonly Keeper[]; info: ChainInfo; showEpoch: boolean; past: boolean }) {
  if (!rows.length) return <p className="ledger-note">{past ? COPY.emptyBoardPast : COPY.emptyBoard}</p>;
  const c = COPY.columns;
  return (
    <div className="ledger-table-wrap">
      <table className="ledger-table">
        <thead>
          <tr>
            <th scope="col" className="num">{c.rank}</th>
            <th scope="col">{c.keeper}</th>
            <th scope="col" className="num">{c.score}</th>
            <th scope="col" className="num col-uptime">{c.uptime}</th>
            <th scope="col" className="col-fed">{c.fed}</th>
            <th scope="col" className="num col-size">{c.size}</th>
            {showEpoch && <th scope="col" className="num col-epoch">{c.epoch}</th>}
            <th scope="col" className="col-proof">{c.proof}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((k, i) => {
            const player = addressUrl(info, k.player);
            const tx = k.txHash ? txUrl(info, k.txHash) : null;
            return (
              <tr key={`${k.player}-${k.epoch}`}>
                <td className="num rank">{i + 1}</td>
                <td className="keeper">{player ? <a href={player} target="_blank" rel="noreferrer" title={k.player}>{shortAddress(k.player)}</a> : <span title={k.player}>{shortAddress(k.player)}</span>}</td>
                <td className="num score">{k.score.toLocaleString("en-US")}</td>
                <td className="num col-uptime">{uptime(k.durationTicks)}</td>
                <td className="col-fed">
                  <span className="coin-count btc"><i aria-hidden="true" />{k.btcFed}</span>
                  <span className="coin-count eth"><i aria-hidden="true" />{k.ethFed}</span>
                  <span className="coin-count hemi"><i aria-hidden="true" />{k.hemiFed}</span>
                </td>
                <td className="num col-size">×{(k.sizeCenti / 100).toFixed(2)}</td>
                {showEpoch && <td className="num col-epoch">{k.epoch}</td>}
                <td className="col-proof">
                  {k.runId && <a href={`/api/chain/trace?runId=${k.runId}`} target="_blank" rel="noreferrer">{COPY.trace}</a>}
                  {tx && <a href={tx} target="_blank" rel="noreferrer">{COPY.tx}</a>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Footer({ config, world, info }: { config: ChainConfig; world: World; info: ChainInfo }) {
  const registry = config.contractAddress ? addressUrl(info, config.contractAddress) : null;
  // Measured when the world arrived, not on every render.
  const minutes = Math.max(0, Math.round((world.fetchedAt / 1000 - world.updatedAt) / 60));
  return (
    <footer className="ledger-foot">
      <span>{world.stale ? COPY.stale(Math.max(1, minutes)) : COPY.updated(minutes)}</span>
      {registry && <a href={registry} target="_blank" rel="noreferrer">{COPY.registry}</a>}
      <span className="ledger-verify">{COPY.verify}</span>
    </footer>
  );
}
