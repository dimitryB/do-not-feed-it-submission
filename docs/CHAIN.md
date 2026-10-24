# The chain — design and interfaces

What the blockchain part of Do Not Feed It is, what it is not, and the exact
interfaces the pieces share. This page is the contract between the Solidity,
the Worker, the client and the tests; change it first, then the code.

The contract, Worker, client and local test harness are implemented in this
repository. The [public practice game](https://do-not-feed-it.pages.dev) is live
on Cloudflare Pages. Hemi Mainnet contract deployment remains pending; record
its address in the README after deployment and public verification.
D-numbers (D183, …) are historical references to the development decision
register, which is not included in this submission.

## 1. What it does, in one paragraph

A shift can be **filed on Hemi**. Before a shift the client asks the server for
a **ticket** (a run ID, a seed, a snapshot of the community state). The player
plays; the client records the **trace** (every launch and hatch, tick-stamped;
the rules are deterministic, so the trace *is* the run). When the night ends,
the epoch report offers one button. The client sends the trace to the
**verifier**, a Worker that replays the authoritative rules
(`lib/game/arcade.ts` `replayArcade`) from the ticket's seed and derives every
number itself — score, uptime, coins fed by token, best combo, size, ending.
It signs that **RunResult** (EIP-712). The player signs the same result with
their wallet, and sends both signatures to `FeedRegistry` on **Hemi Mainnet**
in one transaction they pay for (gas on Hemi is a fraction of a cent). The
contract checks both signatures, the version, the bounds and replay
protection, then records the result, updates the player's best, and adds the
coins to **the community pile** for the current **epoch**. The title screen
reads the pile back: *"The community fed it 61% BTC this epoch."* A leaderboard
is indexed from the contract's events.

What it does not do: it does not sign browser-claimed numbers (a score the
server could not replay is never attested); it does not need a wallet to play
(practice is free and instant; the button appears only on the report); it
does not charge, gate, sell or wager anything; it does not prove a human
played (a bot that plays the real rules gets a real score; see §9).

## 2. Trust model (say this honestly, in the README too)

- **The rules are the truth.** The verifier replays `replayArcade(seed,
  commands, endTick)`. A tampered trace fails closed. A plausible-looking score
  with no valid trace is never signed.
- **The verifier is trusted.** If its key leaks, false results can be filed
  inside the contract's bounds. The owner can rotate it (`setVerifier`) and
  pause. Bounds are defence in depth, not proof of play.
- **The player is attribution.** Their signature binds the address; it proves
  nothing about play. One wallet is not one human.
- **The contract is the record.** Accepted results, best scores and the pile
  are on Hemi; the leaderboard is derived from events and can be rebuilt.

## 3. The run, the trace, the version

- `GAME_VERSION` is `lib/game/arcade.ts`'s number (10 today). The signed
  `gameVersion` is `keccak256(utf8("do-not-feed-it/arcade/10"))` —
  `lib/chain/types.ts` `gameVersionId(n)`. A rules change bumps the number; the
  contract's `activeGameVersion` is owner-rotatable so a bump needs a
  `setGameVersion`, not a redeploy; the board filters by version.
- **Seed**: the ticket's `uint32`, server-random. `createArcade(seed)` as today.
  Practice (no ticket) keeps its client-random seed and is never filed.
- **Trace**: the `ArcadeCommand[]` the page already records plus `endTick`
  (the tick the run ended on, `state.tick` after `phase === "lost"`).
  Canonical bytes (`lib/chain/trace.ts` `encodeTrace`):
  `u8 version=1 · u32 endTick · u16 count · count × (u32 tick · u8 kind
  [0 launch, 1 hatch] · u8 ingredient [0 metal, 1 balloon, 2 pepper; 255 for
  hatch] · i8 angle · u8 power)`, big-endian. `traceHash = keccak256(bytes)`.
  Bounds: `count ≤ MAX_COMMANDS` (3,088 from ARENA), `endTick ≤ 43,200`,
  JSON body ≤ 256 KB. The ticket row keeps `payloadHash` (see §6), the
  signed result as JSON, the player and the signature; the **trace itself is
  kept for good** in `dnfi_run_traces` (migration 0003) with the seed, the
  trait, the snapshot's preimage and the first attested result, and served
  by `GET /api/chain/trace?runId=…` so anyone can replay a filed shift
  against the `traceHash` the contract holds (`scripts/verify-filing.mjs`).
  Max, Oct 21: a server-signed verified execution trace with the hash
  committed is the reasonable middle; a ZK proof of the replay is the best
  version, and this design is ready for it without changing what is
  committed.
- **A filed run must have ended**: `phase === "lost"`. The twelve-minute cap
  ends a run with `outgrew-the-kitchen` and is filed like any other.
- **Pause policy (ranked)**: the simulation is tick-based and pauses on a
  hidden tab or a dialog exactly as in practice; a pause changes no tick. The
  only clock is the ticket: issued → attest within `TICKET_SECONDS` (40 min:
  12 of play, the rest for idling on the title and the wallet). There is no
  wall-clock check of play speed; see §9.
- **Determinism**: ECMAScript leaves `Math.sin/cos/atan2/exp/log/hypot/pow`
  and `**` *implementation-approximated* — each engine (and sometimes each
  platform's maths library) may differ in the last bit — so the rules no
  longer call them. `lib/game/detmath.ts` is fdlibm 5.3 translated to
  TypeScript out of exactly specified operations (`+ − × ÷`, `Math.sqrt`,
  `floor`, `trunc`, `abs`, integer and typed-array bit access); whole
  powers are left-to-right products, `hypot` is `√(x²+y²)`. Every
  conforming engine therefore computes the same bits, and every carried
  quantity is still rounded to 1e-4 (`quantize`). ESLint refuses
  `Math.sin`-and-friends and `**` anywhere in `lib/game/`
  (`eslint.config.mjs`), and `tests/detmath.test.mjs` pins each function's
  exact bits over 20,000 inputs. The swap changed no outcome: an 82-shift
  corpus (every bot, every inherited trait, about four hours of play)
  replays to the same whole state at every ten-second checkpoint before
  and after, so `GAME_VERSION` stayed 9 and the frozen fixtures stand
  (D183). Chromium (V8) and workerd (V8) agree tick
  for tick (`tests/verifier.test.mjs`, the e2e). Any other browser is
  checked with `scripts/engine-check.mjs`, which builds a self-contained page
  that replays 38 shifts in that browser and compares every checkpoint, the
  signed numbers and the maths digests with Node's. A divergence would still
  fail closed (`invalid_trace` / `run_not_over`: an honest run the player
  cannot file), and the client refuses to sign numbers that differ from the
  shift it showed, so it can never file wrong ones.

## 4. The signed result (EIP-712)

Domain: `name "Do Not Feed It"`, `version "1"`, `chainId 43111`,
`verifyingContract` = the registry. Field order is the typehash; do not reorder.

```
RunResult(
  bytes32 runId, bytes32 gameVersion, address player,
  uint64 score, uint32 durationTicks, uint32 totalFeeds,
  uint32 btcFed, uint32 ethFed, uint32 hemiFed,
  uint32 bestCombo, uint32 frenzies, uint32 sizeCenti,
  uint8 ending, uint8 cause,
  bytes32 seed, bytes32 traceHash, bytes32 snapshotHash, uint64 deadline)
VerifierAttestation(bytes32 resultHash)
```

| Field | From | Notes |
| --- | --- | --- |
| runId | ticket | `bytes32`, server-random; one-time on chain |
| gameVersion | `gameVersionId(GAME_VERSION)` | must equal `activeGameVersion` |
| player | the wallet | attestation is requested *after* the wallet connects, so the verifier signs the address |
| score | `state.score` | |
| durationTicks | `state.tick` | uptime = ticks / 60 |
| totalFeeds | `state.totalFeeds` | equals btc+eth+hemi (checked on chain) |
| btcFed / ethFed / hemiFed | `state.servings.metal / .balloon / .pepper` | the diet |
| bestCombo / frenzies | `state.bestCombo / state.frenzies` | |
| sizeCenti | `round(state.size × 100)` | |
| ending | `state.ending` 0–3 | the wallet tier on the report |
| cause | 0 empty-belly · 1 kitchen-destroyed · 2 outgrew-the-kitchen | |
| seed | `bytes32(uint256(seed))` | |
| traceHash | §3 | |
| snapshotHash | ticket | §7 |
| deadline | verifier: `now + 20 min` | contract: `now ≤ deadline ≤ now + 30 min` |

The verifier signs `VerifierAttestation(resultHash)` where `resultHash` is the
full domain-bound digest of the RunResult (as V0 did). Shared constructors:
`lib/chain/types.ts` `resultTypedData`, `attestationTypedData`, `feedRegistryAbi`.

## 5. The contract — `contracts/FeedRegistry.sol` v1

OpenZeppelin EIP712 + Ownable2Step + Pausable (as V0). Solidity 0.8.28, paris.

- `constructor(address owner, address verifier, bytes32 gameVersion, uint64 epochSeconds)`;
  `GENESIS = block.timestamp` (immutable), `EPOCH_SECONDS` (immutable, ≥ 1 hour).
- `submitResult(RunResult calldata r, bytes playerSig, bytes verifierSig)`
  (`whenNotPaused`; anyone may send — a relayer cannot change a signed field):
  - replay: `!usedRunIds[r.runId]`, `r.runId != 0`, `r.player != 0`;
  - version: `r.gameVersion == activeGameVersion`;
  - window: `block.timestamp ≤ r.deadline ≤ block.timestamp + SIGNATURE_WINDOW (30 min)`;
  - bounds: `durationTicks ≤ 43_200`, `durationTicks ≥ 1`,
    `totalFeeds ≤ durationTicks / 15 + 1`, `btc + eth + hemi == totalFeeds`,
    `bestCombo ≤ totalFeeds`, `frenzies ≤ totalFeeds / 5 + 1`,
    `sizeCenti ≤ 1_000`, `ending ≤ 3`, `cause ≤ 2`,
    `score ≤ uint64(durationTicks) × 2_000` (loose: the theoretical maximum per
    tick is far lower; `test/FeedRegistry.ts` derives the real ceiling from
    TUNING and asserts it is under the bound);
  - signatures: player over the result digest; verifier over the attestation;
  - effects: `usedRunIds[runId] = true`; `bestScore[player] = max`;
    `bestUptime[player] = max(durationTicks)`; `runs[player] += 1`;
    `filings[epoch][player] += 1`, and only while that count is at most
    `PILE_FILINGS_PER_EPOCH` (3): `epochDiet[epoch].{btc,eth,hemi,runs} += …`;
    `allTime.{…} += …` (D184);
  - `emit ResultRecorded(runId indexed, player indexed, gameVersion indexed,
    score, durationTicks, btcFed, ethFed, hemiFed, bestCombo, frenzies,
    sizeCenti, ending, cause, epoch, snapshotHash, traceHash)` for every
    filing, then `emit PileFed(runId indexed, player indexed, epoch indexed,
    btcFed, ethFed, hemiFed)` for the filings that fed the pile.
- Views: `currentEpoch()`, `epochOf(uint64 timestamp)`, `diet(uint64 epoch)
  → (btc, eth, hemi, runs)`, `allTimeDiet()`, `dominant(uint64 epoch) → uint8`
  (0 none, 1 btc, 2 eth, 3 hemi; ties → lower index wins, documented),
  `filingsIn(uint64 epoch, address player) → uint32` (every filing, fed or
  not), `PILE_FILINGS_PER_EPOCH() → 3`.
- Owner: `pause`, `unpause`, `setVerifier`, `setGameVersion`. No upgradeability,
  no funds held, no token, no approvals (contest conduct rule).
- Errors: `InvalidResult()`, `InvalidSignature()`, `DuplicateRun()`,
  `WrongVersion()`, `Expired()`.

Tests (`test/FeedRegistry.ts`, Hardhat + viem, run with `npm run test:contract:js`
when a solc binary cannot be downloaded): happy path by relayer and by player;
duplicate; forged player, forged verifier, wrong chain, wrong contract; every
bound at its edge (±1); version rotation accepts new and rejects old; pause;
epoch accounting across an epoch boundary (`networkHelpers.time.increase`);
`dominant` tie rule; the TUNING-derived score ceiling.

## 6. The Worker — `worker/chain.ts`

Enabled only when `DNFI_CONTRACT_ADDRESS`, `DNFI_VERIFIER_PRIVATE_KEY`,
`DNFI_DEPLOY_BLOCK` and the `DB` binding are all present and well-formed;
otherwise every route but `config` is 503 and `config` says why (as the
scaffold did). All responses `Cache-Control: no-store`; both POST routes
require `Content-Type: application/json` (415 otherwise).

| Route | Body → response | Rules |
| --- | --- | --- |
| `GET /api/chain/config` | → `{ enabled, chainId, contractAddress, explorerUrl, rpcUrl, gameVersion, gameVersionId, epochSeconds, ticketSeconds }` | `explorerUrl` is Hemi's explorer only when `chainId` is 43111, else `null`; `rpcUrl` is `DNFI_PUBLIC_RPC_URL` (default Hemi's public RPC), never the indexer's `HEMI_RPC_URL` |
| `POST /api/chain/ticket` | `{}` → `{ runId, seed, issuedAt, expiresAt, epoch, sourceEpoch, inherited, snapshotHash, snapshot: { btc, eth, hemi, runs, dominant } }` | rate limit 30/min/bucket (`dnfiRateLimits`); seed `uint32`; `expiresAt = issuedAt + TICKET_SECONDS`; `sourceEpoch` / `inherited` / `snapshot` by the §10.1 rule on the piles cached in D1 — see §7 |
| `POST /api/chain/attest` | `{ runId, player, commands, endTick }` → `{ result: RunResult (bigints as decimal strings), verifierSignature, typedData }` | rate limit 10/min/bucket; body ≤ 256 KB; `player` must pass viem `isAddress(…, { strict: true })` (EIP-55 on a mixed-case address) and is normalised; ticket must exist and be unexpired; replay with the **row's** `inherited`; `phase === "lost"` and `state.tick === endTick`; `payloadHash = keccak256(runId ‖ traceHash ‖ endTick)` (no player): same payload + same player → the stored signature (idempotent; re-dated and re-signed under two minutes from its deadline), same payload + another player → 409 `player_conflict` naming the bound wallet (a run belongs to the wallet of its first attestation: a leaked run id and its public trace cannot be filed under another name), a different payload on an attested ticket → 409; the first attestation extends the row's `expires_at` to at least `attested_at + 2 × SIGNATURE_WINDOW` |
| `GET /api/chain/trace?runId=0x…` | → `{ runId, gameVersionId, chainId, contractAddress, seed, inherited, trait, epoch, sourceEpoch, snapshot: { epoch, sourceEpoch, btc, eth, hemi, runs }, snapshotHash, endTick, commands, traceHash, trace: 0x…, attested: RunResultJson, storedAt }` | rate limit 60/min/bucket; 404 until the run is attested; `Cache-Control: public, max-age=300` (the record is immutable); the first attestation is the one kept — the chain has the rest |
| `GET /api/chain/world` | → `{ gameVersionId, epoch, epochSeconds, genesis, sourceEpoch, inherited, pile: { current, previous, allTime }, top: [Entry], epochs: [{ epoch, btc, eth, hemi, runs, dominant, sourceEpoch, inherited, top: [Entry] }], updatedAt, cursor, stale: bool }`, Entry = `{ player, score, durationTicks, btcFed, ethFed, hemiFed, bestCombo, sizeCenti, ending, epoch, runId, txHash, blockNumber }` | `top` is the all-time board (25, one row per player, their best); `epochs` is the ledger page's strip (§8): the current epoch first (even before anyone filed in it), then up to seven more recent epochs with runs, newest first, each with its pile, the coin it passes on (`dominant`), what its own creature came in with (`inherited` from `sourceEpoch`, by §10.1 — `null` for both when that look-back reaches past the epochs the snapshot keeps, so "unknown" is never shown as "nothing") and its own board (10, one row per player); `genesis` is the contract's `GENESIS` (null until first read); `runId` links the row to `GET /api/chain/trace`. | served from `dnfiLeaderboardSnapshots`; refreshed at most every 20 s, under a 30 s lease on the row claimed by a conditional `UPDATE` (one refresh at a time across every isolate), by scanning `ResultRecorded` (the boards) and `PileFed` (the piles) logs from the cursor to `head − DNFI_CONFIRMATIONS` (default 16) in bounded batches (≤ 2,000 blocks per `eth_getLogs`, ≤ 20,000 per refresh), with the RPC fallbacks; on RPC failure, or without the lease, serve the cached snapshot with `stale: true` and its age |

Error shape: `{ error: { code, message } }` with codes `disabled`,
`rate_limited`, `bad_request`, `unknown_ticket`, `expired_ticket`,
`invalid_trace` (replay threw, or ended before `endTick`), `run_not_over`,
`out_of_bounds` (the replay's result is outside the contract's bounds; a
rules bug, not a retry), `payload_conflict`, `player_conflict`,
`unavailable`. Never log a
signature, a private key or a request body.

The snapshot is a JSON document with a `version` (now 2: per-epoch boards,
`runId` in every entry). A row of an older version is served as an empty,
stale world flagged `outdated`; the next refresh to take the lease resets the
row (`cursor = −1`) and re-indexes from `DNFI_DEPLOY_BLOCK`, so a deploy that
changes the shape needs no manual step and never folds new events into an old
shape. Re-indexing is the same scan as always, bounded per refresh, so a
long-lived contract catches up over a few refreshes.

Rate-limit buckets: an IPv4 address as is, an IPv6 address by its /64, an
IPv4-mapped IPv6 as the IPv4.

The verifier signs with viem's `privateKeyToAccount(...).signTypedData`. CPU:
3–7 µs a tick in Node and workerd (measured), so a full
twelve-minute replay is about 150–300 ms — within a Workers paid plan, far
outside a free plan's 10 ms. Set `limits.cpu_ms` explicitly at deploy. The
contract's bounds are mirrored in `worker/verifier.ts` from the same rules
constants the contract's comments name (`ARENA.maxTicks`,
`ARENA.frenzyCooldownTicks`, `TUNING.crateCoins`, `TUNING.crateGapMin`,
`TUNING.frenzyAt`; the size and score ceilings are the contract's own
numbers) and must equal the contract's — `tests/verifier.test.mjs` checks the
edges against `lib/game/arcade.ts`, `test/FeedRegistry.ts` against the
registry.

D1: keep `dnfi_run_tickets`, `dnfi_rate_limits`; tickets carry `game_version`,
`epoch`, `snapshot_hash`, `source_epoch`, `inherited` (set at issue; §10.3),
`player` and `result_json` (set at attest and **retained**: the stored result
is what an idempotent repeat returns, and what a re-sign rebuilds from);
`dnfi_leaderboard_snapshots` is keyed by `chain_id ‖ contract ‖ game_version`
and carries `refresh_lease_until` (migrations `drizzle/0001_dnfi_chain_v1.sql`,
`drizzle/0002_dnfi_chain_v2.sql`). The indexer's cursor is the last block
fully scanned, at most `DNFI_CONFIRMATIONS` behind the head; a reorg deeper
than that below the cursor is handled by the documented rewind (`?rewind=N`
is **not** exposed; the owner re-runs from the deploy block by clearing the
row). Env beyond the bindings: `DNFI_CHAIN_ID` (default 43111),
`DNFI_DEPLOY_BLOCK` (required), `DNFI_CONFIRMATIONS` (default 16; the local
Hardhat e2e sets 0), `DNFI_PUBLIC_RPC_URL`, `HEMI_RPC_URL` and
`HEMI_RPC_FALLBACKS` (the indexer's), `DNFI_GENESIS` / `DNFI_EPOCH_SECONDS`
(optional, for epoch-correct tickets before the first scan).

## 7. The pile, the epoch and the snapshot

- **Epoch** = `(block.timestamp − GENESIS) / EPOCH_SECONDS`, `EPOCH_SECONDS =
  86_400` at deploy (one UTC-ish day from the deploy minute). The Worker
  computes the same from `config` and the server clock; the contract's view is
  the reference when they disagree.
- **The pile** for an epoch is the sum of `btcFed / ethFed / hemiFed` over the
  filings that fed it: each wallet's first `PILE_FILINGS_PER_EPOCH` (3) in the
  epoch, in the order the contract executed them (D184). The contract emits
  `PileFed` for exactly those and the indexer sums only `PileFed`, so it never
  re-derives the cap and always equals `diet(epoch)`. A later filing is
  recorded, ranked, counts in `runs(player)` and `filingsIn`, and adds
  nothing. One wallet is not one human: the cap bounds what one wallet can do
  to the next creature, not what one person can. The title line is `communityDietLine` on the *current* epoch's
  pile when it has runs, else the previous epoch's, else nothing (the stub's
  rule: null → no line). Window label: "this epoch" / "last epoch". The
  indexer keeps the last `KEPT_EPOCHS` (= `SNAPSHOT_LOOKBACK` + 1 = 9) epochs
  with runs as their own piles and boards, and everything in `allTime`; the
  extra epoch is so the oldest card on the ledger page usually still knows
  what it inherited.
- **Snapshot**: the ticket carries `snapshotHash = keccak256(abi.encodePacked(
  "dnfi/snapshot/2", uint64 epoch, uint64 sourceEpoch, uint8 dominant,
  uint64 btc, uint64 eth, uint64 hemi))` — the ticket's own epoch, the epoch
  it inherits from and that epoch's pile as the server saw it (§10.1;
  `lib/chain/types.ts` `snapshotHashOf`). Nothing inherited: `sourceEpoch = 0`
  and zeros. The contract records it unchecked; anyone can recompute it from
  `diet(e)` and see which world a filed shift was played in.

## 8. The client — `lib/chain/` and `app/components/Ledger.tsx`

- `lib/chain/types.ts`: constants, typed-data constructors, ABI, `gameVersionId`,
  `RunResult` JSON codec (bigint ↔ string). Shared with the Worker and tests.
- `lib/chain/trace.ts`: `encodeTrace`, `traceHash`, `MAX_TRACE_BYTES`. Shared.
- `lib/chain/wallet.ts`: EIP-6963 discovery with `window.ethereum` fallback;
  `connect()`, `ensureChain()` (`wallet_switchEthereumChain`, then
  `wallet_addEthereumChain` with the public RPC and explorer), viem
  `createWalletClient({ transport: custom(provider) })`, `signResult`,
  `submit` (`writeContract submitResult`), `waitForReceipt`, `readBestScore`
  and `readUsedRunId` via a viem public client on `HEMI_RPC_URL`. No private
  keys in the browser, ever.
- `lib/chain/api.ts`: `fetchConfig`, `requestTicket`, `attest`, `fetchWorld`,
  each with a timeout and typed errors (the Worker's codes, `out_of_bounds`
  included). `explorerUrl: null` in the config means no explorer links.
- `lib/chain/ledger.ts`: the state machine. **Nothing the verifier returns is
  signed as-is**: the result must match the ticket (`runId`, `seed`,
  `snapshotHash`), the trace (`traceHash`, `durationTicks`), the wallet
  (`player`), the rules (`gameVersion`) *and the numbers on the report* —
  `score`, `btcFed/ethFed/hemiFed`, `totalFeeds`, `bestCombo`, `frenzies`,
  `sizeCenti`, `ending`, `cause`, taken from the page's own final
  `ArcadeState` (`playedNumbers`). Any difference is `mismatch:<field>` and
  nothing is signed. The `deadline` is judged against the clock read when the
  answer arrived; outside the window the page blames its own clock (`clock`),
  not the verifier.
- `app/components/Ledger.tsx`: the panel on the epoch report. States:
  `off` (chain disabled or practice shift: one grey line "Practice shift. Not
  filed.") · `ready` (button "File this shift on Hemi") · `connecting` ·
  `attesting` ("Replaying your shift…") · `signing` ("Sign it in your wallet.")
  · `sending` · `confirming` ("Pending on Hemi"; a mined receipt counts only
  if it carries the registry's `ResultRecorded` for this run — a replacement
  or cancel mined under the same nonce is `failed: replaced`, unless
  `usedRunIds` says something else filed it) · `filed` ("FILED." · block ·
  explorer link · "Your best on Hemi: N" · the pile line, §10.4: the
  receipt's `PileFed` for this run says whether it fed the pile) · `failed`
  (plain reason, Retry, Skip). Each step before `send` is cancellable; a
  reload after `sending` can resume from the receipt by `txHash` kept in
  `sessionStorage` (validated on read). A `DuplicateRun()` refusal is checked
  against `usedRunIds(runId)`: true means `filed` with no transaction of its
  own ("This shift was already on Hemi ↗" — the registry's explorer page —
  and the best) instead of a Retry that can only fail again.
- The page: `start()` requests a ticket (a spare one is reused only if < 5 min
  old) with a 1.5 s timeout; on timeout or error the shift is practice (header
  label "LOCAL PRACTICE"; otherwise "HEMI MAINNET · SHIFT #n"). The epoch
  report passes `{ ticket, commands, endTick, played: view }` to the Ledger.
  The title's `dietLine` comes from `world.pile`; "TOP KEEPERS" lists the top
  five under the preflight strip.

- `app/ledger/page.tsx` — the ledger page (`/ledger`, linked as "The ledger ↗"
  beside TOP KEEPERS on the title): a dashboard of `GET /api/chain/world`,
  refreshed every 30 s while visible. The hero carries the all-time pile; the
  **epochs strip** is one card per listed epoch — dates (from `genesis`), a
  share bar and whole-percent shares that add up to 100 (largest remainder,
  ties to the earlier coin as the contract's `dominant`), the shift count,
  CAME IN WITH (the trait and "from epoch N", "nothing", or "—" when unknown)
  and PASSES ON (LEADING on the current epoch); the **board** switches
  between All time and any listed epoch (a card is also a switch), and opens
  on the current epoch when it has filings, else all time. Each row: rank,
  the address (explorer link), score, uptime, the coins fed, size, the epoch
  (all time only), and its proof — `Trace ↗` (`/api/chain/trace?runId=`) and
  `Tx ↗`. The footer says how fresh the snapshot is and that anyone can
  replay a row with `scripts/verify-filing.mjs`. Pure helpers in
  `lib/chain/ledgerView.ts`; copy in `LEDGER_PAGE` (`lib/render/lore.ts`).
  Under 720 px the uptime, size and epoch columns go; under 480 px the coins
  fed go too, so the proof links stay on screen.

Copy rules (`lib/render/lore.ts`): plain words wherever the player must act
("Connect wallet", "Sign", "Retry"); flavour only in status lines, and every
crypto word must be true of what is happening — FILED. because it was filed,
PENDING. because the transaction is pending, CONFIRMED. because it was. No
prices, no promises, "Not financial advice" stays the only disclaimer.

## 9. Known limits (write these in the README)

- No Bitcoin header is read for entropy and no finality endpoint is called.
  The seed is server-random per ticket, disclosed before play. A player can
  request more tickets and search for a favourable seed or optimise a trace
  before filing it; rate limits reduce volume without preventing seed search.
  If either Bitcoin feature is
  ever added: `getLastHeader` / `getTxConfirmations` are the reliable hVM
  calls on mainnet (`getHeaderN` is broken until the next hard fork; witness
  data is empty); a header seed needs the player's commitment well before
  the block (hVM lag, withholding, timestamps rolled up to two hours); a
  finality readout goes through the op-node endpoint on the public RPC, the
  TBC endpoint only once v2 lands (Office Hours, Oct 21).

- A bot that plays the real rules files a real score. There is no proof of
  humanity and the contest does not ask for one; per-IP rate limits cap the
  volume, not the skill.
- The verifier is a single server key. Compromise lets false results inside the
  bounds through until rotated.
- Hemi's public RPC is the only read path for the board; when it is down the
  board is stale and says so. Filing needs the player's wallet to reach Hemi.
- No gas sponsorship: the player pays. A relayer can be added later without a
  contract change (anyone may send).
- The pile counts a wallet's first three filings an epoch, not a person's:
  many wallets can still outvote one. Wallets are free and gas is a fraction
  of a cent, so the cap stops one wallet grinding shifts from owning the
  next creature; it does not stop a determined Sybil (D184).

## 10. Stage 2 — the inherited trait

The community's diet changes the creature everyone plays next. The rule, in
one line: **the creature inherits the dominant token of the last epoch anyone
fed it, as that token's mutation at level 1, from tick 0.** BTC → HODL jaws,
ETH → gas belly, HEMI → turbo breath. Nothing wears off, so a level-1 start
is simply a creature that already ate thirteen of that coin last night — the
rules' own words for it.

### 10.1 The rule (deterministic; the same accepted events always give the same creature)

- Let `E` be the ticket's epoch. The **source epoch** is the greatest `e < E`
  with `diet(e).runs > 0`, looking back at most `LOOKBACK = 8` epochs
  (the indexer caches that many; the contract holds all). No such epoch →
  nothing is inherited (`dominant = 0`, `inherited = null`).
- `dominant(e)` is the contract's rule: the largest of btc / eth / hemi; a tie
  goes to the earlier token (btc, eth, hemi); all zero → none (a pile of
  zero-feed runs inherits nothing).
- The **current** epoch's pile never changes a running or pending shift
  (D19): a ticket is issued against completed epochs only.
- The ticket's `snapshotHash` commits to it:
  `keccak256("dnfi/snapshot/2" ‖ u64 epoch ‖ u64 sourceEpoch ‖ u8 dominant ‖ u64 btc ‖ u64 eth ‖ u64 hemi)`
  (`sourceEpoch = 0` and zeros when nothing is inherited). The contract records
  it; anyone can recompute it from `diet(e)` and check which world a filed
  shift was played in.

### 10.2 The rules — `lib/game/arcade.ts`, GAME_VERSION 10 (7 when this section was written; 8 added the inherited trait, 9 the belly clock, 10 the craving's pull and its half serving for any other coin)

- `createArcade(seed, inherited: Ingredient | null = null)` and
  `replayArcade(seed, commands, endTick, inherited = null)`. With `inherited`:
  `mutations[inherited] = 1`, `state.inherited = inherited`, and the first
  storm / first flame are scheduled as they are on a real level-up
  (`junkAt = utensilFirst`, `flameAt = flameFirst`) so the trait shows itself
  a legible moment after the shift starts. `servings` stay 0 (the diet is what
  *this* shift fed, so an inherited level feeds nothing), `mutationEvents`
  stays 0, and the next level lands at the normal threshold (36 servings),
  because a level never goes away and `levelFor(0) = 0 < 1`.
- A replay with `inherited = null` is bit-identical to version 6; the three
  frozen traces keep their numbers, and three new frozen traces (one per
  inherited trait) pin the inherited start. `tests/arcade.test.mjs` proves:
  level 1 from tick 0, zero servings, no mutation event, the chip's level,
  level 2 at the normal threshold, and replay determinism with each trait.
- `scripts/loop-bots.mjs --inherited metal|balloon|pepper` runs the pacing
  gates with the trait on; the
  pass/fail against the stage-6 gates is reported, not retuned, in this stage.

### 10.3 The server

- The ticket row stores `source_epoch` (nullable: null = nothing inherited)
  and `inherited` (0 none, 1 btc, 2 eth, 3 hemi) next to `snapshot_hash`
  (migration `0002`); `POST /api/chain/ticket` returns `sourceEpoch`
  (`number | null`), `inherited` (0–3) and the source pile in `snapshot`
  (zeros and `dominant: 0` when nothing is inherited). The rule runs on the
  piles the indexer cached (`sourceEpochOf(epoch, piles)`, then `dominantOf`
  on the source pile), never on the RPC: a ticket issues even with Hemi down.
- `verifyRun` takes `inherited` from the **ticket row**
  (`inheritedOf(row.inherited ?? 0)`), never from the request; the client
  cannot choose the world it played in. A trace recorded under another trait
  fails the replay (`invalid_trace` or `run_not_over`).
- `GET /api/chain/world` returns `inherited` and `sourceEpoch` for the current
  epoch (the title's prediction; the ticket is the authority for a shift).
- `gameVersionId(GAME_VERSION)` — 10 today — is what the deployed registry's
  `activeGameVersion` must be; results filed under an older number (none exist
  off a local node) would be `WrongVersion`.

### 10.4 The client

- `start()` passes `inheritedOf(ticket.inherited)` to `createArcade`. A
  practice shift (no ticket) inherits nothing; the dev hook
  `__dnfi.play.start(seed, inherited = null)` can start a practice shift with
  a trait for a capture. `decodeTicket`/`decodeWorld` read `inherited` (0–3;
  missing or malformed → 0) and `sourceEpoch` (whole number or null)
  leniently.
- Title, under the diet line (`<InheritedLine>`, copy `INHERITED.line` in
  lib/render/lore.ts): two captions, *LAST EPOCH: 61% BTC.* and *TONIGHT IT
  HAS HODL JAWS.* (GAS BELLY / TURBO BREATH), each ≤ 30 characters, uppercase,
  full stop; one line where they fit, wrapping only between them. The trait
  is `inheritedOf(world.inherited)`; the share is `pile.previous`'s largest
  share when `world.sourceEpoch === world.epoch − 1` (the only source pile the
  world carries), else the first caption is *LAST EPOCH: BTC ON TOP.* — the
  lore's double-meaning rule holds (it does have them: the chip is lit and the
  jaws pull cutlery from tick 0). Nothing inherited: no line. The line is a
  prediction; the ticket is the authority for the shift.
- The trait chip for an inherited level reads **INHERITED** under the name
  (`INHERITED.tag`) while `mutations[f] === 1 && state.inherited === f`, so a
  judge sees why it already has it; the second level replaces it with ×2.
- The report's Ledger, once filed: *Filed into epoch 12’s pile: 21 BTC · 23
  ETH · 21 HEMI.* (`LEDGER.lines.pile`, from the attested result's
  `btcFed/ethFed/hemiFed` and the event's `epoch`, D180) on its own line under
  the filed row — the verified contribution and the epoch it can affect —
  when the receipt carries this run's `PileFed`. Past the wallet's three:
  *Epoch 12’s pile takes three shifts a wallet; yours are in. This one counts
  for the board.* (`LEDGER.lines.pileFull`). Without a receipt of its own
  (`DuplicateRun`, filed elsewhere): *This shift: 21 BTC · 23 ETH · 21 HEMI.*,
  claiming no pile. Not shown after a resume (the numbers are not
  remembered, the transaction is).
- The whitepaper (help) gets a fourth step (`INHERITED.help`): *What everyone
  fed it, it keeps.* — the community pile, last epoch's coin as tonight's
  level-one trait from the first tick, filing optional (one transaction from
  the report, gas paid by you, practice never touches the chain).
- TOP KEEPERS rows are unchanged: one line each.
- **When the pile closes** (D185). The client takes it from the world's
  `genesis` and `epochSeconds` (`epochSpan(...).to`, lib/chain/ledgerView.ts:
  `GENESIS + (epoch + 1) × EPOCH_SECONDS`; nothing until GENESIS is known), and
  the title says it after the diet line, in its sentence case: *The community
  fed it 54% BTC this epoch. The pile closes in 6h 12m.* (*This epoch’s pile
  closes in…* when the diet line names last epoch); with no diet line, as the
  inherited line's third caption, *PILE CLOSES IN 6H 12M.* Whole minutes,
  rounded up, every 30 s; gone once it has closed, and the title fetches the
  world again once. Not on the HUD (pillar 6).

## 11. Deployment

The current [live game](https://do-not-feed-it.pages.dev) runs in practice mode
on Cloudflare Pages, with [the ledger page](https://do-not-feed-it.pages.dev/ledger)
showing that filing is disabled. Its production database and verifier are
prepared, but no registry address or deployment block is configured.
See [the practice deployment instructions](../README.md#deploy-the-practice-game)
for Pages builds and uploads. Hemi contract deployment remains a separate step.

The database migrations and production-only verifier secret are now prepared.
For deployment from the Mac holding the wallet key, use the
[mainnet deployment handoff](HEMI_DEPLOYMENT_HANDOFF.md). No registry address is
configured yet, so the public game remains in practice mode.

The rest of this section describes the future onchain deployment.

These commands are an operator guide. Publishing this repository does not
deploy a contract or a site. Use Node.js and npm versions supported by
`package.json`, a funded Hemi Mainnet deployer and a Cloudflare Workers paid
plan. Replay verification needs more CPU than the free plan supplies.

### Deploy and verify FeedRegistry

Install from the lockfile and run the checks before selecting the commit whose
rules will be deployed:

```sh
npm ci
npm run check
cp .env.example .env
```

In the ignored `.env`, set `HEMI_RPC_URL`, `HEMI_DEPLOYER_PRIVATE_KEY` and
`DNFI_VERIFIER_ADDRESS`. Use a separate verifier key from the deployer key;
`DNFI_VERIFIER_ADDRESS` is its public address. Set `DNFI_OWNER` if a different
account should control pause, key rotation and rules version. Keep the deployer
key outside the Worker. `DNFI_EPOCH_SECONDS` defaults to 86400.

Hardhat's configuration reads process environment or its keystore; the explicit
`--env-file` below loads `.env` for both the config and the deployment script:

```sh
node --env-file=.env node_modules/hardhat/dist/src/cli.js compile --build-profile production
node --env-file=.env node_modules/hardhat/dist/src/cli.js run scripts/deploy-registry.ts --network hemi --no-compile
```

The second command sends a real deployment transaction. Save its contract
address, deployment block, `GENESIS`, epoch length, verifier address, game
version and transaction hash. Confirm that the read-back values match. Run the
Blockscout verify command printed by the script with the same environment
(replace its `npx hardhat` prefix with
`node --env-file=.env node_modules/hardhat/dist/src/cli.js`). Keep the production
compiler profile and constructor arguments exactly as printed. Public source
verification is a separate step from deploying successfully.

### Configure D1 and the Worker

Authenticate to Cloudflare and create a dedicated database:

```sh
npx wrangler login
npx wrangler d1 create do-not-feed-it
cp wrangler.example.jsonc wrangler.production.jsonc
```

Edit `wrangler.production.jsonc`: replace `account_id` and `database_id` with
your own values and use the database name returned by Wrangler. Choose an
unused Worker name if `do-not-feed-it` already exists in your account. The
`DB` binding name must stay `DB`; `migrations_dir` points at the committed
`drizzle/` SQL files. Set these non-secret `vars` from the deployment receipt
and read-back values:

- `DNFI_CONTRACT_ADDRESS`: the deployed registry address.
- `DNFI_DEPLOY_BLOCK`: its deployment block, not the current head.
- `DNFI_GENESIS` and `DNFI_EPOCH_SECONDS`: the contract's exact immutable values.
- `DNFI_CHAIN_ID`: 43111 for Hemi Mainnet.

Apply all four SQL migrations to that remote database, in filename order, with
Wrangler's migration tracker. Do not recreate a database to upgrade an existing
deployment; retain the run traces and let the migration tracker apply only new
files.

```sh
npx wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc
npx wrangler secret put DNFI_VERIFIER_PRIVATE_KEY --config wrangler.production.jsonc
```

The secret command prompts for the verifier's private key. Its address must be
the registry's `verifier()`. Use `wrangler secret put HEMI_RPC_URL` (and
`HEMI_RPC_FALLBACKS`, if needed) with the same `--config` for keyed indexer RPC
endpoints; the default is Hemi's public endpoint. `DNFI_PUBLIC_RPC_URL` is sent
to browsers and must never contain a private RPC credential. No private key
belongs in `vars`, source, a public URL or a client-prefixed environment name.

For local chain development, copy `.dev.vars.example` to `.dev.vars`, fill the
settings and select the same configuration for both migrations and development:

```sh
npx wrangler d1 migrations apply DB --local --config wrangler.production.jsonc
DNFI_WRANGLER_CONFIG=wrangler.production.jsonc npm run dev
```

These commands use a local database for that binding; they do not apply remote
migrations. Practice requires neither the chain settings nor populated tables;
the end-to-end harness creates and migrates its own local DB automatically.

### Build, inspect and publish

Set the intended public origin before building so link previews contain an
absolute social-card URL:

```sh
DNFI_WRANGLER_CONFIG=wrangler.production.jsonc DNFI_SITE_URL=https://YOUR_GAME_ORIGIN npm run build
npx wrangler deploy --dry-run --config dist/server/wrangler.json
```

`vite.config.ts` uses the explicit `DNFI_WRANGLER_CONFIG` path instead of its
local placeholder DB configuration. Without that variable, the build is for
local review and retains a dummy database ID; do not deploy that output. Keep
`wrangler.production.jsonc` beside the template so its relative entrypoint and
migration paths resolve correctly. The Cloudflare Vite plugin generates
`dist/server/wrangler.json` with the compiled entrypoint and client assets;
deploy that generated config, not the TypeScript source entrypoint. Inspect it
to confirm the intended Worker name, real DB binding, Hemi contract vars,
`nodejs_compat`, client assets and `limits.cpu_ms` (30000 in the template).
The dry run packages the upload without publishing it.

When those settings and the build are correct, publish:

```sh
npx wrangler deploy --config dist/server/wrangler.json
```

On the public origin, confirm `/api/chain/config` returns `enabled: true` with
the intended chain, contract and rules version. Open `/api/chain/world` and
`/ledger`; a newly deployed chain may be empty until confirmed events are
indexed. Play a complete shift, file it with a test wallet, confirm the receipt
on Hemi Explorer, and replay it with `scripts/verify-filing.mjs` from the same
commit. Check the resulting `/api/chain/trace?runId=…` link and the leaderboard.
Keep backups of D1: the trace records are the public replay evidence, even
though boards can be rebuilt from chain logs.

Only after those public checks pass, add the verified contract address to the
README and update its deployment status and source commit. Keep the live play
URL unless the hosting origin changes.
The contest submission and any screenshots should refer to that same public
build. If the chain remains disabled, the site is practice only and should be
described that way.
