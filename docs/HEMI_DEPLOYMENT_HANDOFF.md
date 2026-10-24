# FeedRegistry deployment and Pages activation

The live game is [do-not-feed-it.pages.dev](https://do-not-feed-it.pages.dev).
FeedRegistry was deployed on Hemi Mainnet on October 24, 2026 and has an exact
creation and runtime match on [Sourcify](https://repo.sourcify.dev/43111/0x909995303dBC651da54b1ab0FF75024E907039c2).
It is also [verified on Routescan](https://routescan.io/address/0x909995303dBC651da54b1ab0FF75024E907039c2?chainid=43111).
Its Cloudflare production database and server verifier are active. Hemi Mainnet
filing was enabled on October 24, 2026. The
[version 10 activation record](../deployments/game-version-10.json) identifies
the deployed game rules and completed validation; a real funded-wallet filing
and mined game receipt remain an operator follow-up.

## Completed deployment

| Detail | Value |
| --- | --- |
| Registry | `0x909995303dBC651da54b1ab0FF75024E907039c2` |
| Transaction | [`0xefdd948512507711515e98ae6693e144bf98bc47d1bff4b12f15be0e0343c920`](https://explorer.hemi.xyz/tx/0xefdd948512507711515e98ae6693e144bf98bc47d1bff4b12f15be0e0343c920) |
| Deployment block | `5582556` |
| GENESIS | `1792857383` (`2026-10-24T15:56:23Z`) |
| Owner / deployer | `0x98978246D8Be2343c0e4C73812c4e1f0B83A20F2` |
| Total transaction fee | `0.000025046673772234 ETH`, including the L1 data fee |
| Public receipt | [`deployments/hemi-43111.json`](../deployments/hemi-43111.json) |

The transaction input matches the compiled production artifact. Owner,
verifier, rules version, epoch, genesis and EIP-712 domain were independently
read back through Hemi's RPC. The contract is unpaused. Hemi Explorer source
publication remains pending: this Mac's connection cannot complete its TLS
handshake, and Sourcify's automatic Blockscout submission received a Cloudflare
403 challenge. Sourcify verification itself completed with exact matches.

When Hemi Explorer is reachable, source publication needs no wallet key:

```sh
HEMI_RPC_URL=https://rpc.hemi.network/rpc \
npx hardhat verify blockscout --config hardhat.verify.config.ts --network hemi \
  --build-profile production --contract contracts/FeedRegistry.sol:FeedRegistry -- \
  0x909995303dBC651da54b1ab0FF75024E907039c2 \
  0x98978246D8Be2343c0e4C73812c4e1f0B83A20F2 \
  0x89B89E32F34b50D3aD1cC7D77D288C8DF4d7e965 \
  0xbd5cb9462bfe8b7ac0ff0c908581c4548415cee73305e800c238acff185fc2f4 86400
```

**Do not run another contract deployment for this installation.** The existing
Pages site is active with this registry. Use the README's Pages commands for
later site deployments, subject to the rules-version freeze below.

Keep the deployment wallet key on the Mac where it already lives. The server
verifier is a separate key, stored as an encrypted production Pages secret.

## Pages activation and validation — October 24, 2026

The production origin is [do-not-feed-it.pages.dev](https://do-not-feed-it.pages.dev).
The activation deployment is
[`ee4546ca.do-not-feed-it.pages.dev`](https://ee4546ca.do-not-feed-it.pages.dev),
built from gameplay commit `c0439ec705ffb5f62ae0d0bb7a0ce4c1d63ba590`.
The [public activation record](../deployments/game-version-10.json) contains
the rules-file SHA-256 hashes and validation counts. The contract deployment
receipt remains unchanged, including its original source commit
`ffd444f9b20f180e7ed7c64b617f7f7653fca217`.

Live checks confirmed enabled configuration on chain `43111`, version `10`, a
fresh indexed world, the ledger and a new browser ticket showing Hemi Mainnet.
Gameplay passed seven live browser checks without page errors. A moderate bot
played a public ticket for 31,282 ticks with 928 commands and scored 775,396;
every returned attestation metric matched local replay. The verifier signature
matches the address read from the deployed registry. Its
[persisted public trace](https://do-not-feed-it.pages.dev/api/chain/trace?runId=0x2e5210a04043999508e5743c737eb273304d4d922554eb2c041a154b7dac8d01)
passed all ten independent `verify-filing.mjs --no-chain` checks.

An `eth_call` simulation of `submitResult` accepted both the player and
verifier signatures. **No game transaction was sent.** `usedRunIds` remained
false before and after the simulation; it did not create a filing or receipt.
The test player was ephemeral and unfunded, and its key and signature were
not retained.

**Remaining operator check:** play a new live shift and choose **File this
shift** with your funded wallet. Filing is optional and pays Hemi network gas.
Confirm the successful receipt and `ResultRecorded` event, then run
the verifier from the frozen version 10 commit:

```sh
node --experimental-strip-types scripts/verify-filing.mjs \
  --site https://do-not-feed-it.pages.dev --rpc https://rpc.hemi.network/rpc \
  --tx <transaction hash>
```

A real funded-wallet filing, mined game receipt and replay against that
onchain event have not yet been tested.

Version 10 is frozen at the activation commit above. The three balance commits
`a4e7109`, `44e88cc` and `c0439ec` preceded public filing activation; RPC logs
confirmed zero `ResultRecorded` events before activation. Every future change
that affects a run's outcome **must increase `GAME_VERSION`** and have the
contract owner rotate `activeGameVersion` before filings use the new rules.
Keep the version 10 source available for replay.

## Version 11 (PRESS E) activation

Version 11 makes a PRESS E hit a recorded command that tops a hungry belly up to 75%.
No shift was filed under version 10, so nothing is lost by moving on. Activate
it from the merged commit, in this order:

1. Rotate the registry (owner key, on the Mac that holds it). A dry run first:

   ```sh
   DNFI_CONTRACT_ADDRESS=0x909995303dBC651da54b1ab0FF75024E907039c2 DNFI_DRY_RUN=1 \
     npx hardhat run scripts/set-game-version.ts --network hemi
   DNFI_CONTRACT_ADDRESS=0x909995303dBC651da54b1ab0FF75024E907039c2 \
     npx hardhat run scripts/set-game-version.ts --network hemi
   ```

   It refuses unless the unlocked account is the owner, and reads the new
   `activeGameVersion` back (`gameVersionId(11)` =
   `0x2cc3ff22f4a6d4ba3321e3e2d4a896d246108366ac43b4fb249c8ba706724cd5`).
2. Redeploy Pages from the same commit with the README's Pages commands.
3. Play a live shift, press E on a sign, file it, and check the receipt and
   `verify-filing.mjs` replay as above. Record version 11 the way
   `deployments/game-version-10.json` records version 10.

Between steps 1 and 2 the live site still signs version 10 results, which the
registry now refuses (`WrongVersion`); keep the gap short.

## Deployment parameters

| Parameter | Value |
| --- | --- |
| Network | Hemi Mainnet, chain `43111` |
| Gas currency | ETH on Hemi |
| Owner | The deploying wallet, unless `DNFI_OWNER` is explicitly set |
| Verifier address | `0x89B89E32F34b50D3aD1cC7D77D288C8DF4d7e965` |
| Game version | `10` |
| Version hash | `0xbd5cb9462bfe8b7ac0ff0c908581c4548415cee73305e800c238acff185fc2f4` |
| Epoch length | `86400` seconds |
| Compiler | Solidity `0.8.28`, Paris, via IR, optimizer 200 runs |

The owner can pause filing, rotate the verifier and change the accepted rules
version. Use a wallet you intend to retain control of. The verifier account
does not need funds. The deployment wallet needs ETH on Hemi to pay gas; this
contract holds no funds and requires no token approvals.

## Reference: deploying a replacement or separate registry

Use Node.js 22.13 or later and this repository's current `main`. For a fresh
checkout:

```sh
git clone https://github.com/dimitryB/do-not-feed-it-submission.git
cd do-not-feed-it-submission
npm ci
npm run contract:compile
npm run test:contract
```

If this repository is already checked out there, update it with `git pull`
instead of cloning again, then run the npm commands above.

If the production Hardhat keystore does not already contain
`HEMI_DEPLOYER_PRIVATE_KEY`, import the deployment key using its hidden local
prompt:

```sh
npx hardhat keystore set HEMI_DEPLOYER_PRIVATE_KEY
```

Do not add the key to source, a shell command, a public environment file or
chat. If it is already configured in the production keystore, skip this step.

The following command sends the real mainnet deployment transaction. It uses
the keystore's deployment account as owner and reads back the deployed values:

```sh
HEMI_RPC_URL=https://rpc.hemi.network/rpc \
DNFI_VERIFIER_ADDRESS=0x89B89E32F34b50D3aD1cC7D77D288C8DF4d7e965 \
DNFI_EPOCH_SECONDS=86400 \
npx hardhat run scripts/deploy-registry.ts --network hemi --build-profile production --no-compile
```

If `DNFI_OWNER` is already exported in that shell, it overrides the deploying
wallet as owner; check it before running. The script prints the deployer,
owner, verifier and version before sending the transaction.

For an account check, set `DNFI_EXPECTED_DEPLOYER` to the public address of the
wallet you intend to unlock. The script refuses a different account before
sending. Set `DNFI_DEPLOY_DRY_RUN=1` to estimate deployment gas and print the
parameters without broadcasting or creating a deployment record.

## Return the public deployment details

Send the resulting **FeedRegistry address and deployment transaction hash**.
The output also contains the deployment block, `GENESIS`, gas used and the
exact Blockscout source-verification command. No private key is needed to
finish the server configuration.

The script also saves a public deployment journal to
`deployments/hemi-43111.json`: the account and nonce before broadcast, the
transaction hash immediately after broadcast, then the receipt and verified
constructor values. It refuses to overwrite that file, so a failed RPC or
interrupted terminal cannot silently cause a second deployment. A record in
`prepared` or `broadcast` state must be checked on chain before any retry.

If the script prints a transaction hash and then fails, check that transaction
before running another deployment; it may already have succeeded.

For this installation, the contract and Pages activation are complete.
Remaining work is Hemi Explorer source publication and the real funded-wallet
filing, receipt and onchain replay check described above. Local and preview
Pages environments remain unbound practice.
