# Public source release review

Reviewed October 23, 2026. This review covers the source snapshot published in
`dimitryB/do-not-feed-it-submission`; it does not certify a deployed service or
contest eligibility. The existing private development repository is separate.

## Scope and outcome

Reviewed gameplay and replay determinism, browser input and lifecycle handling,
wallet filing, Worker request validation and rate limits, D1 races and
persistence, indexer freshness, Solidity signatures and bounds, dependencies,
deployment configuration, documentation, asset attribution, and the files
selected for the initial Git commit. No unresolved critical or high code
findings in the game or server code were identified in this review. A remaining
upstream advisory in development tooling is described below. Publishing the
source does not deploy the site or spend funds on Hemi.

## Findings addressed before publication

| Finding | Resolution |
| --- | --- |
| The initial dependency audit reported 32 affected packages: 1 critical, 14 high, 8 moderate and 9 low. | Updated Next.js, Vite, Cloudflare tooling and compatible transitive packages. Removed unused `drizzle-kit`. Added scoped patches for `vinext`'s image parser, Miniflare's image/HTTP dependencies and solc's temporary-file helper. The production audit is clean; the final full audit exposes the development-only Zod advisory described below. |
| Releasing a shot and pressing the hatch during the same rules tick could accept both inputs, although replay requires strictly increasing command ticks. | Inputs now apply and enter the trace atomically, admitting at most one accepted command per tick. Rejected inputs cannot mutate live state. |
| The Launch button lacked keyboard/assistive activation; releasing outside the button or interrupting play could leave charging active. | Added Space charging, Enter and virtual-click activation, pointer capture, and charge cancellation on pause, blur and pointer cancellation. |
| A bounded indexer refresh could report a partial history as fresh. | Catch-up status now persists with the snapshot and survives cached/leased responses until scanning reaches the confirmed head. |
| `verify-filing --tx` trusted any contract emitting a matching event and could ignore the supplied registry. | Verification now binds the emitter to the expected registry, rejects ambiguous runs, checks RPC chain identity and verifies the trace, seed, rules and inherited snapshot bindings. |
| The source had only a local placeholder D1 configuration and incomplete deployment instructions. | Added an explicit production-config opt-in, a Wrangler template and contract/D1/Worker deployment instructions. Checked the generated upload with a dry run. |
| Documentation linked omitted development notes and overstated resistance to seed searching. | Replaced stale references, explained disclosed seeds and ticket limits honestly, and marked live deployment as pending. |
| Node's production preview supplies no Worker environment; chain configuration reads errored instead of reporting practice mode, and the page requested disabled world data. | The Worker entrypoint now gives the chain router an empty configuration when bindings are absent. The page reads world data only after configuration enables the chain. |
| The local integration harness could leave a generated backup behind when no original environment file existed. | Epoch rewrites no longer back up generated test variables; four isolated filesystem scenarios check original-file restoration and recovery-backup handling. |

The clean GitHub run also caught a production-only Zod advisory that the full
audit did not report. `abitype` now uses its supported Zod 4 peer at patched
version 4.6.6; tooling retains its compatible Zod 3 dependency. Both audit modes
are checked before publication, and the development-only findings are retained
in the report rather than hidden by the initial deduplication behavior.

The deterministic simulation, game version, contract ABI and SQL migrations
were preserved. The Solidity compiler is pinned to 0.8.28 so the alternate
solc-js build cannot silently drift from Hardhat's configured compiler.

## Validation

- TypeScript and ESLint pass.
- All 166 application tests pass, including D1/API behavior, immutable replay
  fixtures, Node/workerd agreement and six genuine/adversarial filing CLI cases.
- All 31 Solidity contract tests pass using Hardhat's production compiler
  profile; the solc-js alternative also passes.
- Production builds pass with both the local configuration and an explicit
  dummy production configuration. Wrangler's upload dry run passes and retains
  the intended DB binding, compiled entrypoint, assets, chain variables and CPU
  budget. No live deployment was performed during the initial source review;
  the subsequent practice deployment is recorded below.
- Ten Chromium input/lifecycle checks pass, including keyboard launch,
  pointer release/cancellation, blur, pause, same-tick inputs and restart lock.
- Ten additional checks pass against the final production build without
  browser route adapters or a development bridge: real disabled-practice
  configuration, loaded art, normal controls/HUD, modal focus, pause/resume and
  ledger navigation. There are no browser errors or disabled world/ticket
  requests.
- The complete Chromium/Worker/D1/local-EVM integration passes: seven shifts,
  sixteen captures, no page errors. It covers filing, wallet cancellation,
  malformed and in-range tampered traces, duplicate filing, wrong-chain
  recovery, rate limiting/retry, the three-filings pile cap, ledger boards and
  next-epoch inheritance. Independent filing verification passes all 20 checks.
- The production dependency audit reports zero vulnerabilities. The full audit
  reports 12 high affected development packages from one upstream Zod advisory,
  with no critical, moderate or low findings after the updates.
- The production client bundle contains no development inspection hook,
  verifier-private-key setting or documented test private keys.

QA captures, local chain state and raw test logs stay in ignored local output.
GitHub Actions repeats types, lint, application/contract tests, production builds
for both Workers and Pages, and the production dependency audit from a clean
lockfile install. The
production audit blocks high/critical findings; the full tooling audit reports
the known upstream highs and blocks critical findings.

## Publication checks

The candidate files were scanned for credential blocks, common service tokens,
credential-bearing URLs, private registry URLs and local user paths. No real
credentials were detected. The Ethereum private keys present in tests and the
commented local example are Hardhat's well-known, public test keys; they must
never hold real funds. The lockfile uses the public npm registry.

The commit excludes `.env*` and `.dev.vars*` other than the documented examples,
local production configuration, `.wrangler/`, databases, dependencies, build
output, contract artifacts, logs and QA captures. The existing MIT license,
third-party notices, art provenance and quotation attribution are included.

## Remaining operational work and limits

**Development tooling advisory:**
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
affects Zod versions before 4.6.6 and concerns memory exhaustion from oversized
validation inputs. Hardhat and its plugins still require Zod 3, including the
current Hardhat 3.21.0 release checked during review. The installed tooling is
used for local contract tests, configuration and deployment; it is not part of
the browser or Worker bundle. There is no compatible upstream Zod 3 patch.
Forcing Zod 4 globally would break tooling APIs; npm's suggested Hardhat 2
downgrade would also require a contract-tooling migration. Preserve the tested
tooling, use trusted local configuration/inputs, and update when upstream ships
a compatible fix. This remains a disclosed development dependency risk.

Hemi Mainnet filing is enabled on the live Pages game. The remaining operator
check is a real funded-wallet filing, its mined game receipt and public replay
against the onchain event from the frozen version 10 commit. Activation checks
verified public attestation and trace replay plus a contract-call simulation;
they sent no game transaction. Hemi Explorer source publication also remains
pending as described in the contract deployment record below.
See [CHAIN.md, Deployment](CHAIN.md#11-deployment).

The verifier remains a trusted server key; owner rotation/pause is its recovery
mechanism. Deterministic replay permits bots, and wallets are not unique people.
Tickets disclose seeds before play; rate limits bound requests but do not
eliminate seed searching or Sybil participation. Tickets can use a cached world
during RPC/indexer delays. The confirmation buffer reduces reorg exposure;
deeper reorgs require operator recovery. D1 backups remain necessary for the
permanent public replay traces. Local-chain/browser checks do not establish
live Hemi RPC availability or production performance under load.

No official contest rule document was supplied with this snapshot, so this
review does not confirm eligibility, deadlines or permission requirements.

## Practice deployment follow-up

Deployed October 23, 2026 to [do-not-feed-it.pages.dev](https://do-not-feed-it.pages.dev)
with source commit `a7a3749dc18b46ace3b156def27b0cc215832619`.
At this deployment, the [ledger](https://do-not-feed-it.pages.dev/ledger)
reported disabled filing. That Pages Advanced Mode package preserved server
rendering and API routes and contained no D1 binding, verifier key or contract
settings.

All 11 live browser checks pass without request adapters or development hooks:
art, gameplay, input, pause/resume, modal focus, ledger navigation, social
metadata, and name-free URLs. No console, page or network errors, chain POSTs,
or disabled world reads occurred. All 24 live endpoint/security checks pass;
source, configuration, server-bundle and source-map probes return `404`.
The final public host and observed asset URLs contain no personal-name terms.
Contract deployment and live Hemi filing remained unperformed at that stage.

## Mainnet infrastructure preparation

Prepared a dedicated production D1 database, `do-not-feed-it-mainnet`, and
applied migrations `0000` through `0003`. A separate verifier signing key is
stored as an encrypted production Pages secret; its public address and the
operator commands are in [the deployment handoff](HEMI_DEPLOYMENT_HANDOFF.md).
Production has a 30,000 ms CPU budget; the operator confirmed Workers Paid.
Local and preview configurations remain unbound practice.

The registry address, deployment block and genesis were deliberately blank
at this preparation stage.
At that stage no mainnet transaction had been sent: the deployment wallet key
remained on the operator's other Mac. The completed contract deployment is
recorded below; the live site still awaited its configured Pages redeployment
at that point.

## Mac deployment readiness review — October 24, 2026

Confirmed Hemi's RPC chain ID is `43111`. The existing Proof of Patience
registry (`0xAd093A653B3D9d2612D79cDa5e7A730cf439A0F7`) reports owner
`0x98978246D8Be2343c0e4C73812c4e1f0B83A20F2`, matching its deployment
parameters. That account has enough Hemi ETH for the simulated FeedRegistry
deployment. The then-live game reported version 10 and the same version hash
and epoch length as the deployment handoff; filing remained disabled.

All 167 application tests and 31 production-profile contract tests pass, as do
TypeScript, ESLint and the production build. A local deployment of the updated
script reads back the constructor values and writes the public receipt.
Separate checks confirm that dry runs create no deployment record, a wrong
deployer is refused, and an existing record blocks a repeat deployment.

The deployment script now checks an optional expected account, estimates gas
and checks the balance, and saves a public journal before broadcast and after
each receipt/readback step. This addresses the risk of accidentally deploying
a second copy after an RPC failure. Corrected the outdated feed and score
bounds in `CHAIN.md`; the Solidity and authoritative game rules are unchanged.

The production dependency audit still reports zero vulnerabilities. The full
audit now reports 16 affected development packages (13 high, 3 moderate): the
existing Zod advisory plus three advisories affecting the tooling's Undici
7.29.1 dependency: [EventSource memory exhaustion](https://github.com/advisories/GHSA-4qv8-2p9j-2685),
[integrity-token parsing](https://github.com/advisories/GHSA-f72v-6w45-q472), and
[excessive content-encoding handling](https://github.com/advisories/GHSA-xjj6-f33q-929c).
Undici 7.30.1 is the reported fix. No dependency migration was performed while
the mainnet wallet prompt was active. These findings concern local tooling;
they do not change the contract bytecode or the production audit result.

## Completed mainnet contract deployment — October 24, 2026

FeedRegistry was deployed at
[`0x909995303dBC651da54b1ab0FF75024E907039c2`](https://explorer.hemi.xyz/address/0x909995303dBC651da54b1ab0FF75024E907039c2)
in block `5582556`, transaction
[`0xefdd948512507711515e98ae6693e144bf98bc47d1bff4b12f15be0e0343c920`](https://explorer.hemi.xyz/tx/0xefdd948512507711515e98ae6693e144bf98bc47d1bff4b12f15be0e0343c920).
The owner and deployer are the existing Proof of Patience owner above; the
verifier, version 10 and one-day epoch match the prepared server configuration.
The total fee, including L1 data, was `0.000025046673772234 ETH`.

Independent RPC checks confirmed the receipt, exact creation input, owner,
verifier, version, genesis, epoch length, EIP-712 domain and unpaused status.
[Sourcify](https://repo.sourcify.dev/43111/0x909995303dBC651da54b1ab0FF75024E907039c2)
reports exact creation and runtime matches;
[Routescan](https://routescan.io/address/0x909995303dBC651da54b1ab0FF75024E907039c2?chainid=43111)
reports successful source verification. Hemi Explorer publication remains
pending: its TLS connection failed on this Mac, and Sourcify's automatic
submission received a Cloudflare 403 challenge. The public compiler input
contains only the exact contract already published in this MIT repository and
OpenZeppelin 5.4.0 sources.

The public receipt and verification details are saved in
[`deployments/hemi-43111.json`](../deployments/hemi-43111.json). The production
Pages config now contains the verified contract address, deployment block and
genesis. No Pages deployment or real game filing was performed in this step;
the public deployment still ran in practice mode at that point. The later
Pages activation is recorded below. The handoff retains the wallet-free
Explorer verification command.

## Live Pages activation and version 10 freeze — October 24, 2026

Hemi Mainnet filing is enabled at
[do-not-feed-it.pages.dev](https://do-not-feed-it.pages.dev). The activation
deployment is
[`ee4546ca.do-not-feed-it.pages.dev`](https://ee4546ca.do-not-feed-it.pages.dev),
built from gameplay commit `c0439ec705ffb5f62ae0d0bb7a0ce4c1d63ba590`.
The [public activation manifest](../deployments/game-version-10.json) records
the exact rules-file hashes, production deployment, public trace and validation
counts. The original [contract receipt](../deployments/hemi-43111.json) remains
unchanged and preserves source commit
`ffd444f9b20f180e7ed7c64b617f7f7653fca217`.

All 167 application tests, 31 production-profile contract tests, TypeScript,
ESLint and Pages packaging pass; GitHub Actions for the activation source
commit is green. Seven live browser checks confirmed enabled chain `43111`,
version `10`, a fresh world and ledger, a new Hemi Mainnet ticket and normal
gameplay without page errors.

A public ticket was played by a moderate bot for 31,282 ticks using 928
commands, scoring 775,396. All attested metrics matched local replay and the
verifier signature matched the registry's actual verifier address. The
[persisted public trace](https://do-not-feed-it.pages.dev/api/chain/trace?runId=0x2e5210a04043999508e5743c737eb273304d4d922554eb2c041a154b7dac8d01)
passed ten independent `verify-filing.mjs --no-chain` checks. Six live
attestation checks passed. An `eth_call` simulation of `submitResult` accepted
both signatures, while `usedRunIds` stayed false before and after the call.
No game transaction was broadcast; the test player was ephemeral and unfunded,
and its private key and player signature were not retained.

**A real funded-wallet filing, mined game receipt and replay against its
onchain event have not been tested.** The operator can complete that check by
playing a new shift and choosing **File this shift**, which is optional and
pays Hemi gas, then verifying the receipt and replay using the handoff.

Version 10 is frozen at the activation commit above. The three balance commits
`a4e7109`, `44e88cc` and `c0439ec` were applied before public filing activation;
RPC logs confirmed zero `ResultRecorded` events before activation. Every future
change that affects a run's outcome **must increase `GAME_VERSION`** and have
the contract owner rotate the accepted version before filing uses the new
rules. Local and preview environments remain unbound practice.

The activation artifact scan covered 24 files and found no source maps,
TypeScript, SQL, environment files, deployment configuration, private paths,
literal credentials or test keys. Dynamic API routes remain handled by the
reserved Worker bundle; only static assets bypass it. Hemi Explorer source
publication remains subject to the TLS/Cloudflare challenge limitation already
recorded above; Sourcify and Routescan verification remain complete.
