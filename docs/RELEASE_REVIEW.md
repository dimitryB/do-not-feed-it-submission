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
findings were identified in this review. Publishing the source does not deploy
the site or spend funds on Hemi.

## Findings addressed before publication

| Finding | Resolution |
| --- | --- |
| The initial dependency audit reported 32 affected packages: 1 critical, 14 high, 8 moderate and 9 low. | Updated Next.js, Vite, Cloudflare tooling and compatible transitive packages. Removed unused `drizzle-kit`. Added scoped patches for `vinext`'s image parser, Miniflare's image/HTTP dependencies and solc's temporary-file helper. The final full npm audit reports zero vulnerabilities. |
| Releasing a shot and pressing the hatch during the same rules tick could accept both inputs, although replay requires strictly increasing command ticks. | Inputs now apply and enter the trace atomically, admitting at most one accepted command per tick. Rejected inputs cannot mutate live state. |
| The Launch button lacked keyboard/assistive activation; releasing outside the button or interrupting play could leave charging active. | Added Space charging, Enter and virtual-click activation, pointer capture, and charge cancellation on pause, blur and pointer cancellation. |
| A bounded indexer refresh could report a partial history as fresh. | Catch-up status now persists with the snapshot and survives cached/leased responses until scanning reaches the confirmed head. |
| `verify-filing --tx` trusted any contract emitting a matching event and could ignore the supplied registry. | Verification now binds the emitter to the expected registry, rejects ambiguous runs, checks RPC chain identity and verifies the trace, seed, rules and inherited snapshot bindings. |
| The source had only a local placeholder D1 configuration and incomplete deployment instructions. | Added an explicit production-config opt-in, a Wrangler template and contract/D1/Worker deployment instructions. Checked the generated upload with a dry run. |
| Documentation linked omitted development notes and overstated resistance to seed searching. | Replaced stale references, explained disclosed seeds and ticket limits honestly, and marked live deployment as pending. |
| Node's production preview supplies no Worker environment; chain configuration reads errored instead of reporting practice mode, and the page requested disabled world data. | The Worker entrypoint now gives the chain router an empty configuration when bindings are absent. The page reads world data only after configuration enables the chain. |
| The local integration harness could leave a generated backup behind when no original environment file existed. | Epoch rewrites no longer back up generated test variables; four isolated filesystem scenarios check original-file restoration and recovery-backup handling. |

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
  budget. No live deployment was performed.
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
- The full dependency audit reports zero vulnerabilities at review time.
- The production client bundle contains no development inspection hook,
  verifier-private-key setting or documented test private keys.

QA captures, local chain state and raw test logs stay in ignored local output.
GitHub Actions repeats types, lint, application/contract tests, production build
and the production dependency audit from a clean lockfile install.

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

The README play URL and Hemi registry address are intentionally pending. Before
submitting a live entry, deploy and verify the actual contract, configure and
migrate D1, set Worker secrets, publish the site and test a real filing/receipt
and public replay from the deployed commit. Then replace those placeholders.
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
