# End-to-end browser suite (ticket 12)

Playwright drives the real web app in Chrome against a real local chain. Every amount, status and event a test checks is read back from the node after real transactions; nothing on the chain side is mocked. Only two things are stand-ins, both test-only:

- **The wallet.** The dev-only test wallet (`web/src/lib/testWallet.ts`, active only under `vite --mode testwallet`) replaces MetaMask and forwards requests to the node, which signs with its unlocked accounts.
- **Pinata.** A local pinning store (`web/e2e/pinningStore.ts`) replaces it. It signs single-file upload URLs with the same size, MIME and expiry limits, stores uploads under real CIDv1 (raw, sha2-256) identifiers, and serves them back as an IPFS gateway.

The upload proxy itself is the real one, including its signature, role and milestone checks and its rate limit.

## Commands

From the repo root:

```bash
npm run test:e2e
```

This compiles the contracts and starts a fresh Hardhat node on port 8546, the local pinning store on 8547 and the dev server on 5174. It then deploys the escrow (global setup), runs the suite and stops everything. These ports are separate from `npm run chain` (8545) and `npm run dev` (5173). Nothing reuses a running server, so a run never touches a development chain and fails fast if a port is taken.

```bash
npm run test:e2e:pinata
```

This is the opt-in real-Pinata test (see below).

- **Browser:** the installed Google Chrome by default (`channel: 'chrome'`), so no browser download is needed. On a machine without Chrome, such as CI, run `npx playwright install chromium` once and set `E2E_BROWSER_CHANNEL=` (empty) to use Playwright's Chromium.
- **Failure diagnostics:** a failing test keeps a trace (DOM snapshots, console, network) and a screenshot under `web/test-results/`. There's also an HTML report in `web/playwright-report/`; open it with `npx playwright show-report` inside `web/`. All of these are gitignored.

## How it stays deterministic

- **Fresh deployment.** Each run starts a new node, and global setup deploys the escrow from account 0 with the same settings as `contracts/ignition/parameters/local.json` (admin 0, arbitrator 1, 1% fee). On a fresh node that lands on the address already in `web/src/contracts/generated/deployments.ts`, and the setup fails if it doesn't. No tracked file changes.
- **Snapshot per test.** Every test runs between `evm_snapshot` and `evm_revert` (an automatic fixture), so tests can't see each other's projects, balances or time travel. The revert also resets the node's clock offset. Tests run serially on one worker.
- **Exact timing.** Deadlines are tested with `evm_setNextBlockTimestamp`, so a transaction is mined at exactly D − 1 or D. The browser clock is set to the same second with Playwright's clock (`page.clock.setFixedTime`), so the app's deadline states match the contract's.
  - Uploads happen before any time travel, because the upload proxy checks signatures against real time.
- **No sleeps.** Waits are on visible app state, such as the transaction confirmation text, never fixed delays.
- **Accessible locators.** Selectors use roles, labels and exact names; milestone rows are found by their "N. Title" line. `openAs` waits until the header shows the account as connected, so a check that a button is absent can't pass before the wallet has loaded.
- **No public network.** The suite needs no RPC provider and no IPFS gateway.

## Scenarios

| File | What it covers |
| --- | --- |
| `happyPath.e2e.ts` | Create and fund through the form; accept; encrypted submission (the store only ever receives ciphertext); client download with a wrong then the right passphrase, and the exact original bytes; approve; second milestone, public; completion; withdraw. It checks the client's and freelancer's ETH balances to the wei including gas, the escrow balance, the credits, the event sequence and the timeline. |
| `revision.e2e.ts` | Two revision requests with notes (counter, status, note shown to the freelancer), then the request button disabled. Auto-approval at the review deadline: at D − 1 the UI offers approval only and the contract refuses auto-approval (`ReviewWindowOpen`); at D a revision request is refused (`ReviewWindowClosed`) and auto-approval is recorded from the UI in a block mined at exactly D. Approval itself has no deadline by design (spec, as built in ticket 05). |
| `exits.e2e.ts` | Overdue refund: at D − 1 there's no button and the contract refuses (`DeliveryWindowOpen`); at D the refund is mined at exactly D and withdrawn to the wei. Also: cancel of an open offer (and which party sees which action), decline, and forfeit with an approved, an earned (review ended) and an undelivered milestone. |
| `dispute.e2e.ts` | Arbitrator resolution: raise-dispute preview, slider, an exact share typed with odd wei, the preview read back from the page and compared with the `DisputeResolved` event and every `BalanceCredited` to the wei (the 1% fee rounds down). Also wallet switching (`accountsChanged`), a rejected wallet prompt that changes nothing, the outcome panel, and the arbitrator withdrawing the fee. Expired settlement: on-chain, the arbitrator can resolve at D − 1 and is refused at D (`ArbitrationPeriodEnded`), each checked in a throwaway snapshot; in the UI, at D − 1 resolve is still open and settle is disabled and refused (`ArbitrationPeriodOpen`); at D resolve is disabled and settlement is mined at exactly D with the fallback split (odd wei to the client, no fee). |
| `robustness.e2e.ts` | Unsupported network: read-only pages, no transaction buttons, then the switch prompt. A stale second tab approving again: the transaction fails and nothing is credited twice. A duplicate submission from a second tab: refused by the proxy, with one on-chain submission. Projects stay separate on the dashboards, and nobody but the parties gets actions. |

The direct-contract helpers in `web/e2e/chain.ts` (`createProjectDirect`, `sendAs`) only set up state that another scenario already drives through the UI, such as an approved milestone before a dispute.

## Dev-only seams

These exist only for this suite and are inactive in a production build.

- `web/src/lib/testWallet.ts`:
  - `?testAccount=N` picks the local account.
  - `?testChain=<id>` makes the wallet report another network until the app asks to switch.
  - `window.testWallet.switchAccount(i)` emits `accountsChanged`.
  - `window.testWallet.rejectNextTransaction()` fails the next transaction with code 4001.
- `web/src/lib/ipfsGateways.ts`: `VITE_E2E_IPFS_GATEWAY` replaces the gateway list. It only applies under `--mode testwallet` in the dev server; production builds compile it out.
- `web/server/devMiddleware.ts`: `E2E_PINNING_STORE_URL` swaps Pinata for the local store (`web/server/localPinningSigner.ts`). Only the Vite dev server reads it; the Vercel function (`web/api/upload-url.ts`) always uses Pinata.

## Real Pinata (opt-in)

`npm run test:e2e:pinata` (config `web/playwright.pinata.config.ts`, test `web/e2e/pinata.real.e2e.ts`) runs the same stack without the local store. The proxy uses the `PINATA_JWT` from `web/.env.local` or the environment. The flow:

1. The freelancer uploads an encrypted file from the browser and submits its manifest CID on-chain.
2. The client opens it through a gateway, decrypts it and gets the exact bytes.

The JWT is only checked for presence. The dev server reads it as usual; it never reaches the browser, the test or the logs. Without a JWT the test is skipped and nothing starts.

The app reads deliverables from `VITE_PINATA_GATEWAY` first, then `ipfs.io` and `dweb.link`. Those public gateways often answer with HTTP 429 and no CORS headers, which the browser reports as a network error. So when no dedicated gateway is configured, this test reads through Pinata's shared gateway, `gateway.pinata.cloud`; override it with `E2E_PINATA_GATEWAY`. Each run pins a small encrypted file and its manifest in your Pinata account.

| Date | Result | Manifest CID |
| --- | --- | --- |
| 2026-10-28 | Passed: 1/1 (29.9 s), after the review fixes. Same flow. | `bafkreig2wbcdru3x6ji3re67emkwehaa6pxbwyhv2abuhngf2si7w3x72m` |
| 2026-10-28 | Passed: 1/1. Encrypted upload, on-chain submit, read through `gateway.pinata.cloud`, decryption and SHA-256 check in the browser (21.6 s). | `bafkreiayc6erhjrjr4jx76hjzcsm2mwcfhc5bado3qte2sqwrbwedjnkgu` |
| 2026-10-28 | Failed at the read: `ipfs.io` and `dweb.link` returned 429 for 3 minutes. The upload and on-chain submit had succeeded. This led to the gateway setting above. | `bafkreic7othdu76ibx4yttr2rrtjfq7qd2pe7lvafi3iwahchlnpo7bbe4` |

## What this suite does not cover

- **MetaMask itself.** The test wallet replaces the extension, so its popups, its network-switch dialog and its gas UI are not exercised.
- **Sepolia.** Ticket 07's Sepolia timeline check waits for the ticket 13 deployment.
- **Uploads after time travel.** These are not tested, because the proxy checks real time (see above).
