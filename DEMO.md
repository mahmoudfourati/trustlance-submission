# Running the TrustLance demo

This guide runs the TrustLance web app on your own computer against the contract **already deployed and verified on Sepolia**. You don't need to deploy anything, hold a private key in a file, or run a blockchain node. Everything uses **Sepolia test ETH only**.

| | |
| --- | --- |
| Network | Ethereum Sepolia, chain id `11155111` |
| Contract | [`0xE387D1Eb6880B2A02EC14b49f90B0e63d1638789`](https://sepolia.etherscan.io/address/0xE387D1Eb6880B2A02EC14b49f90B0e63d1638789#code) (verified source) |
| Address used by the app | `web/src/contracts/generated/deployments.ts` (committed) |

## 1. Requirements

- **Node.js 22.13 or newer** and Git.
- A desktop browser with **MetaMask**, to send transactions. Browsing projects read-only needs no wallet.
- For transactions: **two MetaMask accounts** (a client and a freelancer) with a little Sepolia ETH each. About 0.01 ETH per account is plenty: the demo projects use 0.001 ETH milestones. Get it from a Sepolia faucet, for example Google Cloud's Web3 faucet. The client must not be the arbitrator account (`0x5351…6815`), which the contract refuses as a client.

## 2. Install

```bash
git clone https://github.com/mahmoudfourati/trustlance.git
cd trustlance
npm install
```

The contract ABI and the Sepolia address are committed, so the web app needs no compile or deployment step.

## 3. Point the app at Sepolia

Create `web/.env.local` (git-ignored) from the template:

```bash
cp web/.env.example web/.env.local
```

In `web/.env.local`, change one line:

```ini
VITE_DEFAULT_CHAIN_ID=11155111
```

This makes the app show Sepolia when no wallet is connected. A wallet connected to Sepolia always uses Sepolia. The template's `VITE_SEPOLIA_RPC_URL` (a public, keyless Tenderly endpoint that keeps the full event-log history) is used for reads; leave it as it is.

## 4. Start the app

```bash
npm run dev
```

Open http://localhost:5173.

## 5. What to look at

**Without a wallet (read-only):**

- http://localhost:5173/projects/1 is "TrustLance Sepolia Demo": 2 milestones, both delivered, approved and withdrawn on 2026-11-07.
- http://localhost:5173/projects/2 is "Demo Project", a single-milestone project completed the same way.
- Each project page has an **Activity** timeline read from the contract's event logs, with Etherscan links for every transaction. The hashes are also listed in [docs/deployment.md § 8](docs/deployment.md#8-recorded-sepolia-deployment-and-demo-run).

**With MetaMask on Sepolia:**

1. Connect. If MetaMask is on another network, use **Switch to Sepolia** (the app adds the network if needed).
2. As the **client**, open **New project**, enter the freelancer's address and one or two small milestones (for example 0.001 ETH), and fund it. MetaMask asks you to confirm the exact milestone total.
3. Switch MetaMask to the **freelancer** account. The project appears on the dashboard under the offers; **Accept** it.
4. **Submitting a deliverable needs a Pinata credential** (see the next section). Without one, the upload is refused with `not-configured`; everything else keeps working.
5. As the client, open the submitted milestone, download it (and decrypt it, if a passphrase was set) and **Approve**, or **Request revision**.
6. As the freelancer, open **Balances** and **Withdraw all**.

Other paths, such as cancelling or declining an offer, refunding an overdue milestone, forfeiting or raising a dispute, are in the project page whenever they're valid.

## 6. Uploading new deliverables (optional Pinata credential)

Deliverables are stored on IPFS through Pinata. The browser never sees the Pinata key: it asks the app's upload proxy (`/api/upload-url`, served by `npm run dev`) for a short-lived signed upload URL, and the proxy checks on-chain that the wallet is the freelancer of an Active project with that milestone open.

**The repository contains no Pinata credential.** To upload new files, configure your own:

1. Create a free Pinata account, then **API Keys → New key** with the `org:files:write` scope, and copy the JWT.
2. In `web/.env.local`, set these two server-only variables. Never prefix them with `VITE_`, which would publish them in the page.

   ```ini
   PINATA_JWT=<your Pinata JWT>
   UPLOAD_PROXY_RPC_URL_11155111=https://sepolia.gateway.tenderly.co
   ```

3. Restart `npm run dev`.

Reading **existing** deliverables needs no credential: the app downloads them through public IPFS gateways, as long as the files stay pinned. Public gateways rate-limit; setting `VITE_PINATA_GATEWAY` to a dedicated gateway host helps. More detail: [docs/upload-proxy.md](docs/upload-proxy.md).

## 7. Check the deployment yourself

These need no wallet and no secret. They only read from the chain:

```bash
npm run check:sepolia
```

It checks the chain id, the deployed bytecode against the committed Ignition artifact, the deployment receipt and block, the admin, arbitrator and fee, the pause state, and the address the web app uses. The Etherscan link it prints shows the verified source.

## 8. Features that need time travel: the local chain

On Sepolia, disputes take up to 30 days to expire and deadlines are days long. To see every path quickly, use the local Hardhat chain, where time can be moved:

```bash
npm run test:e2e        # Playwright: 12 browser scenarios on a fresh local chain (needs Google Chrome; see docs/e2e.md)
npm test                # contract tests (Solidity fuzz/invariants + TypeScript) and web unit tests
```

To click through locally instead, see [Local setup in the README](README.md#local-setup).

## Hosting (optional, not set up)

The app is ready for Vercel (`web/vercel.json`, and `web/api/upload-url.ts` as a serverless function), and [docs/deployment.md § 6](docs/deployment.md#6-host-on-vercel-optional-not-set-up) describes how. **No hosted instance exists**: the demo runs locally as described above.

## Troubleshooting

- **Without a wallet, the app shows "Hardhat Local" and loads nothing.** `VITE_DEFAULT_CHAIN_ID=11155111` is missing from `web/.env.local`; restart `npm run dev` after changing it.
- **Timeline error mentioning pruned history.** The read RPC doesn't keep old logs. Keep `VITE_SEPOLIA_RPC_URL=https://sepolia.gateway.tenderly.co`.
- **Upload says `not-configured`.** `PINATA_JWT` isn't set (section 6). **`unsupported-chain`:** `UPLOAD_PROXY_RPC_URL_11155111` is missing.
- **MetaMask "insufficient funds".** The account needs more Sepolia ETH.
- **Download fails with HTTP 429.** A public IPFS gateway is rate-limiting; retry, or set `VITE_PINATA_GATEWAY`.
