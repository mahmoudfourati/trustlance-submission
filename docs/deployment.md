# Sepolia deployment, hosting and demo checklist

This guide deploys `TrustLanceEscrow` to the Ethereum **Sepolia** test network (chain id `11155111`, Layer 1), verifies it on Etherscan, optionally hosts the web app and upload proxy on Vercel, and records the demo run. **Use Sepolia test ETH only.** Never deploy to mainnet and never reuse a key that holds real funds.

**Status (2026-11-07):** the contract is deployed and verified on Sepolia; see [the deployment record](#8-recorded-sepolia-deployment-and-demo-run). Don't redeploy it for the demo: [`DEMO.md`](../DEMO.md) runs the web app locally against this deployment. Steps 1–4 are kept as the reproducible record of how it was deployed. Vercel hosting (step 6) has **not** been set up.

Every step that needs a secret is done by you on your own machine or in the Vercel dashboard. Secrets go into the Hardhat keystore (encrypted, outside the repo) or the host's environment settings, never into files in the repo.

## 1. Accounts and test ETH

1. In MetaMask, create (or pick) **four accounts used only for this demo**: Admin/Deployer, Arbitrator, Client and Freelancer.
2. Enable test networks (MetaMask → network list → "Show test networks") and select **Sepolia**.
3. Get Sepolia ETH from a faucet, for example the Google Cloud Web3 faucet, the Alchemy or Infura Sepolia faucets, or a PoW faucet. Some faucets need a small mainnet balance or a login. Rough needs:
   - Deployer: about 0.05 ETH. The deployment used 3,505,947 gas on the local node; the price varies.
   - Client: about 0.05 ETH (two small projects of 0.01–0.02 ETH, plus gas).
   - Freelancer and Arbitrator: about 0.01 ETH each, for gas.

   You can fund one account and send test ETH to the others from MetaMask.
4. Export the **Deployer's** private key from MetaMask (Account details → Show private key) only to paste it into the keystore in step 2. Don't save it anywhere else.

## 2. Secrets in the Hardhat keystore

Run these inside `contracts/`. Each command asks for the value and, the first time, for a keystore password. The values are stored encrypted in your user profile, not in the repo.

```bash
cd contracts
npx hardhat keystore set SEPOLIA_RPC_URL       # e.g. https://sepolia.infura.io/v3/<key> or an Alchemy URL
npx hardhat keystore set SEPOLIA_PRIVATE_KEY   # the Deployer's key, 0x-prefixed
npx hardhat keystore set ETHERSCAN_API_KEY     # etherscan.io → API Keys (one key works for Sepolia)
npx hardhat keystore list                      # shows the names only
```

The deployer RPC can be any Sepolia endpoint. Event-log history only matters for the web app's read RPC (step 6).

## 3. Deployment parameters

```bash
cp ignition/parameters/sepolia.example.json ignition/parameters/sepolia.json
```

Edit `sepolia.json` with the public addresses (not keys) of the Admin and the Arbitrator:

```json
{ "TrustLanceEscrowModule": { "admin": "0x…Admin", "arbitrator": "0x…Arbitrator", "feeBps": 100 } }
```

Rules:

- `admin` and `arbitrator` are required, and neither falls back to the deployer. The Hardhat `sepolia` network needs only the one signing account (the Deployer); the Admin and the Arbitrator don't sign anything during deployment.
- The admin and the arbitrator must be different accounts. The deployment doesn't enforce this; `npm run check:sepolia` fails if they match.
- The arbitrator can't create projects, so the Client must be another account.
- `feeBps` is the arbitration fee in basis points: 100 is 1%, and the maximum is 1000.
- This file holds only public addresses. Commit it with the deployment record so the deployment is reproducible.

## 4. Deploy, verify and export

From the repo root:

```bash
npm run deploy:sepolia
```

This compiles the contract and runs Ignition on `--network sepolia`, which asks for the keystore password. Ignition shows the chain and the parameters and asks you to confirm, then sends one transaction. With `--verify`, it also verifies the source on Etherscan. Finally it exports the address to `web/src/contracts/generated/deployments.ts`.

If the network or Etherscan fails halfway, run the same command again. Ignition resumes from its journal in `contracts/ignition/deployments/chain-11155111/`. Verification alone can be retried with `npm run verify:sepolia -w @trustlance/contracts`.

Then check the deployment. This is read-only and needs no secrets:

```bash
npm run check:sepolia
```

It reads the artifact Ignition deployed from its own record, so no compile is needed. Against the chain it compares:

- the chain id and the code size (under 24,576 bytes);
- the bytecode, against the compiled artifact with immutables masked;
- the deployment receipt and `deploymentBlock()`;
- the admin (`owner()`), default arbitrator and fee, against the parameters Ignition used;
- that creation isn't paused;
- the address exported to the web app.

`npm run check:local -w @trustlance/contracts` does the same for a local `deploy:local`.

It prints the Etherscan links for the contract and the deployment transaction. Open the contract link and confirm the "Contract" tab shows a green check (source verified).

`export-web.ts` writes every `chain-*` deployment it finds, so if you also deployed locally, `deployments.ts` keeps the `31337` entry next to Sepolia. That is expected: the end-to-end suite relies on it, and it is harmless in production.

Commit the deployment record:

- `contracts/ignition/deployments/chain-11155111/` (public: addresses, transaction hashes, build info);
- `contracts/ignition/parameters/sepolia.json`;
- the regenerated `web/src/contracts/generated/deployments.ts`.

Review the diff first. It contains no keys, because Ignition never writes the private key.

**Deployment block.** The web app reads it from the contract (`deploymentBlock()`, an immutable set in the constructor). The timeline's log scan starts there, so no extra export is needed.

## 5. Upload proxy settings (server-only)

Create a Pinata API key with the `org:files:write` scope (Pinata → API Keys) and copy its JWT. If you have a dedicated gateway, note its host (for example `example.mypinata.cloud`). Under Gateways → your gateway → settings, allow your Vercel domain as an origin if it restricts origins. Otherwise reads use `gateway.pinata.cloud` or the public gateways, which rate-limit.

## 6. Host on Vercel (optional, not set up)

This is an option for a public URL, not part of the submitted deployment: no Vercel project exists for TrustLance. The app can be run locally instead ([`DEMO.md`](../DEMO.md)).

1. In Vercel, choose "Add New → Project" and import the GitHub repository.
2. Set **Root Directory** to `web`. Vercel detects Vite: build `npm run build`, output `dist`. `web/vercel.json` sends every non-`/api` path to the single-page app, and `web/api/upload-url.ts` becomes the `/api/upload-url` function.
3. Under Settings → Environment Variables (Production), add:

| Name | Value | Notes |
| --- | --- | --- |
| `PINATA_JWT` | your Pinata JWT | **Secret.** Server-only; never add a `VITE_` copy |
| `UPLOAD_PROXY_RPC_URL_11155111` | a Sepolia RPC URL | Server-only; used to check that the uploader is the freelancer |
| `VITE_DEFAULT_CHAIN_ID` | `11155111` | Public |
| `VITE_SEPOLIA_RPC_URL` | an RPC with **full event-log history** (default `https://sepolia.gateway.tenderly.co`) | Public, bundled into the page, so use a keyless URL or a key restricted to your domain |
| `VITE_PINATA_GATEWAY` | your gateway host, or `gateway.pinata.cloud` | Public |

4. Deploy, then open the site. The header should connect MetaMask. On another network the app shows "Switch to Sepolia", which switches MetaMask (or adds the network).
5. Check the proxy without uploading anything:

   ```bash
   curl -s -X POST -H 'content-type: application/json' -d '{}' https://<your-app>/api/upload-url
   ```

   The answer tells you the state:

   - HTTP 400 with code `invalid-request` means the function is deployed, configured, and rejecting an unsigned request. This is the expected answer.
   - HTTP 503 `not-configured` means `PINATA_JWT` is missing.
   - A 404 means the root directory or the `api/` folder is wrong.

   Authorization (a fresh wallet signature from the freelancer of an Active project, with that milestone Pending) is then exercised by the real upload in the demo below.

The production bundle contains no test wallet and no E2E stand-ins: they are compiled only under `vite --mode testwallet` in the dev server. The server-only variables are never read by browser code.

## 7. Demo checklist

Run it in the web app (local, or hosted if you set up step 6) with MetaMask on Sepolia, and record each transaction hash. Every transaction link in the app opens Sepolia Etherscan. Amounts are examples.

Project A, happy path (Client creates, Freelancer delivers):

| # | Account | Action | Expected | Tx hash / result |
| --- | --- | --- | --- | --- |
| A1 | Client | Connect wallet; on another network, use "Switch to Sepolia" | Header shows the account; no network warning | |
| A2 | Client | New project: 2 milestones (0.01 + 0.005 ETH), Freelancer's address | Redirect to `/projects/<id>`; escrow 0.015 ETH; Etherscan shows the value | |
| A3 | Freelancer | Dashboard → "Offers for you" → Accept project | Active; delivery periods started | |
| A4 | Freelancer | Milestone 1 → Upload and submit, with a passphrase | Upload succeeds; MetaMask signs the authorization, then the submit transaction | |
| A5 | Client | Milestone 1 → Open deliverable → passphrase → Decrypt and download | "Downloaded. The file matched the SHA-256…"; file identical | |
| A6 | Client | Approve milestone 1 | Freelancer's withdrawable balance is 0.01 ETH | |
| A7 | Freelancer | Submit milestone 2 (no passphrase); Client approves | Project Completed | |
| A8 | Freelancer | Balance → Withdraw all | Wallet up by 0.015 ETH minus gas; balance 0 | |
| A9 | Anyone | Project page → Activity | All events in order, "unconfirmed" until 5 blocks, Etherscan links work | |

Project B, dispute (arbitrator console). **Optional, not executed on Sepolia:** the submitted demo ran only project A's happy path (see § 8). The dispute flow is verified on the local chain by the contract tests and the end-to-end suite (`e2e/dispute.e2e.ts`); run these steps only if you want to show it on Sepolia as well.

| # | Account | Action | Expected | Tx hash / result |
| --- | --- | --- | --- | --- |
| B1 | Client | Create 1 milestone of 0.01 ETH; Freelancer accepts and submits | Submitted | |
| B2 | Client | Raise a dispute with a reason | Disputed; 0.01 ETH frozen | |
| B3 | Arbitrator | Arbitration → open the dispute → Resolve: freelancer share 0.006 ETH | Preview: fee 0.0001, freelancer 0.006, client 0.0039 ETH | |
| B4 | Arbitrator | Confirm | `DisputeResolved` on Etherscan with the previewed amounts; three balances credited | |
| B5 | Arbitrator, Client | Withdraw all | Fee and refund arrive | |

Ticket 07 (Sepolia timeline):

| # | Check | Expected | Result |
| --- | --- | --- | --- |
| T1 | Project A's timeline right after A8 | The newest events show "unconfirmed", then confirmed after about 1 minute (5 blocks) | |
| T2 | Timeline after the chain has moved more than 10,000 blocks past the deployment (about 33 hours), or with `maxLogRange` temporarily lowered | Every event still listed, read in pages of 10,000 blocks | |
| T3 | Dashboard titles | Project titles shown (read from logs) | |

Optional: the admin pauses project creation through Etherscan's "Write Contract" tab (`pause()`), connected with the Admin account. "Create and fund project" is then refused, while approve, dispute and withdraw still work. Unpause afterwards.

Record the results in `docs/tickets/13-sepolia-deployment.md` (and T1–T3 in `docs/tickets/07-activity-timeline.md`).

## 8. Recorded Sepolia deployment and demo run

Read back from the chain on 2026-11-07 with `npm run check:sepolia` (all checks passed) and the contract's event logs.

| | |
| --- | --- |
| Network | Sepolia, chain id `11155111` |
| Contract | [`0xE387D1Eb6880B2A02EC14b49f90B0e63d1638789`](https://sepolia.etherscan.io/address/0xE387D1Eb6880B2A02EC14b49f90B0e63d1638789#code) |
| Source verification | Etherscan "Source Code Verified" (Exact Match); [Sourcify](https://sourcify.dev/) `exact_match` for creation and runtime code |
| Deployment transaction | [`0xfdeaf316…a6460c`](https://sepolia.etherscan.io/tx/0xfdeaf3164d3c6fa5b00ef7bd0bf3541e40e60320e5bd9d9efb309b432ea6460c), block 12082738 (2026-11-07 09:20 UTC) |
| Admin (owner, deployer) | `0x6B849A42f245319720Bdf8Db67030e6E6695C74e` |
| Default arbitrator | `0x5351c2ecB4bD0Fd074441b4cAc400f5F9FD66815` |
| Arbitration fee | 100 bps (1%) |
| Code size | 15,600 of 24,576 bytes |
| Record in git | `contracts/ignition/deployments/chain-11155111/`, `contracts/ignition/parameters/sepolia.json`, `web/src/contracts/generated/deployments.ts` |

Demo run on 2026-11-07, client `0xA9f2e4b557C76fcb71Ff9C4cA75746081728ac0E`, freelancer `0x4033Fb6190463cc60FC91Dd1BD3fBb7778633c4E`:

| Step | Event(s) | Transaction |
| --- | --- | --- |
| Project 1 "TrustLance Sepolia Demo" created and funded: 2 milestones of 0.001 ETH | `ProjectCreated`, `MilestoneDefined` ×2 | [`0x65358920…3fe9e7`](https://sepolia.etherscan.io/tx/0x653589209571455dc884b4b188e173825e7109c6dbdcba1b6e131272143fe9e7) |
| Freelancer accepts | `ProjectAccepted` | [`0xe4e44369…fd5b2d`](https://sepolia.etherscan.io/tx/0xe4e44369c6e00be6c03c1f5a3c13bf5eaf3593a941f5c8993f0ea2fb84fd5b2d) |
| Milestone 1 submitted (manifest `bafkreiaprsl3eqinpd3eqp2ayu75qnecmj6fd2lvxe2zhqmlb63c3sngh4`) | `MilestoneSubmitted` | [`0x81eb61ae…a152`](https://sepolia.etherscan.io/tx/0x81eb61ae34cafe2f974de51e9e1ca7e70e9aaf806c11491ddeee4b5fd061a152) |
| Milestone 1 approved, 0.001 ETH credited | `MilestoneApproved`, `BalanceCredited` | [`0xe030247d…888185`](https://sepolia.etherscan.io/tx/0xe030247d6a7a272168bfdf96b73e1b1c34ffc51efaf36f6ab3200c55b5888185) |
| Milestone 2 submitted (manifest `bafkreiao3c5si26akwkh46phnxeye4oydacvpelbm34xzraiwqypql2hzy`) | `MilestoneSubmitted` | [`0xa66f45a0…2b24`](https://sepolia.etherscan.io/tx/0xa66f45a0d99826764d90c784c225600e7016379a0c0de669e9f23f27f3638b24) |
| Milestone 2 approved; project Completed | `MilestoneApproved`, `BalanceCredited`, `ProjectCompleted` | [`0x56c1a625…386499`](https://sepolia.etherscan.io/tx/0x56c1a6250fa81289593a0a0f7e7b3cd7f14256f7ce7f303fb2966ff969386499) |
| Freelancer withdraws 0.002 ETH | `Withdrawn` | [`0xd46e1d7d…7546`](https://sepolia.etherscan.io/tx/0xd46e1d7d815a110ce4e6f58388a2d102e555ec1ce3cf8f449d353297dbf47546) |
| Project 2 "Demo Project": 1 milestone of 0.001 ETH, created | `ProjectCreated`, `MilestoneDefined` | [`0xfedf2bda…ecced`](https://sepolia.etherscan.io/tx/0xfedf2bda1c5cbaf8e56535a99daff4b0e692233c995cbe658b696995506ecced) |
| Accepted | `ProjectAccepted` | [`0xc84b8558…5df1`](https://sepolia.etherscan.io/tx/0xc84b8558ab48fcdbd154cce3fd5fe3ed88ee26a95e12282c3ea9d343e1005df1) |
| Submitted (manifest `bafkreieo7f5lgknq2kygd7wflp6v6vbr7c6blsjytsnk4zfsc4gz35socm`) | `MilestoneSubmitted` | [`0x136f619e…caeda`](https://sepolia.etherscan.io/tx/0x136f619e69c72b0042c7f29d3c2bef86152f1629759809db106ca95fe22caeda) |
| Approved; project Completed | `MilestoneApproved`, `BalanceCredited`, `ProjectCompleted` | [`0x38105842…51ec`](https://sepolia.etherscan.io/tx/0x3810584256a0ea79f7a7015b03fa35fc8d50c9eb8c8f5c9cc234ddeb2b1c51ec) |
| Freelancer withdraws 0.001 ETH | `Withdrawn` | [`0xddaebfb3…8277`](https://sepolia.etherscan.io/tx/0xddaebfb37fb1fd53ab7e06406b4733b45e9cb06e80a1feecf0febafdf2dd8277) |

Not exercised on Sepolia: revisions, refunds, forfeit, disputes (the optional project B above) and the admin pause. Those paths are covered on the local chain by the contract tests and the Playwright suite ([`docs/e2e.md`](e2e.md)).

## Troubleshooting

- **`Error HHE7: Configuration Variable "SEPOLIA_RPC_URL" not found`** (or another name). That keystore entry is missing; nothing was sent. Run `npx hardhat keystore list` inside `contracts/`.
- **A module parameter "requires a value".** `admin` or `arbitrator` is missing from `sepolia.json`; nothing was sent.
- **`HHE708: Hardhat was set to use chain id "11155111", but connected to a chain with id "…"`.** `SEPOLIA_RPC_URL` points at another network (chain id 1 is Ethereum mainnet); nothing was sent. Do not add funds. Replace it with `npx hardhat keystore set SEPOLIA_RPC_URL --force` inside `contracts/`. If this left a `contracts/ignition/deployments/chain-<id>/` folder, delete it and don't commit it.
- **`gas required exceeds allowance (0)`.** The deployer has no ETH on the connected chain. `npm run diagnose:sepolia -w @trustlance/contracts` is read-only and reports the chain, the deployer's public address, its balance, the fees and the estimated cost, without printing any secret.
- **"insufficient funds".** The deployer needs more Sepolia ETH.
- **Verification failed.** Retry with `npm run verify:sepolia -w @trustlance/contracts`. The build settings (solc 0.8.34, optimizer 200 runs) are recorded in the deployment's build info.
- **Upload says `not-configured`.** `PINATA_JWT` is missing on Vercel; redeploy after adding it.
- **Upload says `unsupported-chain`.** `UPLOAD_PROXY_RPC_URL_11155111` is missing, or the deployed `deployments.ts` has no Sepolia address.
- **Timeline error "pruned history".** The read RPC doesn't keep old logs; use one that does.
- **Download fails, `ipfs.io` 429.** Set `VITE_PINATA_GATEWAY`.
