# Deploy FeedRegistry from the Mac holding the wallet key

The live game is [do-not-feed-it.pages.dev](https://do-not-feed-it.pages.dev).
Its Cloudflare production database and server verifier are prepared, but no
Hemi contract has been deployed yet. Filing stays disabled until the deployment
receipt is used to finish its configuration.

Keep the deployment wallet key on the Mac where it already lives. The server
verifier is a separate key, stored as an encrypted production Pages secret.

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

## On the other Mac

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

## Return the public deployment details

Send the resulting **FeedRegistry address and deployment transaction hash**.
The output also contains the deployment block, `GENESIS`, gas used and the
exact Blockscout source-verification command. No private key is needed to
finish the server configuration.

If the script prints a transaction hash and then fails, check that transaction
before running another deployment; it may already have succeeded.

The remaining steps are to verify the receipt and constructor values, publish
the source on Hemi Explorer, fill the production registry address/block/genesis,
redeploy Pages, verify an attestation and test a real filing and public replay.
The live game will remain in practice mode until those settings are installed.
