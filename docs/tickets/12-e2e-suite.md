# 12: End-to-end browser suite

**What to build:** A Playwright suite against a local Hardhat node with a test-only EIP-1193 provider forwarding to unlocked accounts. It covers: create → accept → submit (encrypted) → approve → withdraw; revision; overdue refund; dispute resolution; expired settlement; unsupported-network prompt.

**Blocked by:** 10

**Status:** ready-for-human

- [x] One command starts the node, deploys, serves the app and proxy (Pinata swapped for a local test pinning store) and runs the suite
- [x] No mocked chain data: every assertion reads state produced by real transactions

## Comments

**2026-10-28 (agent):** implemented; waiting for an independent review. Details in `docs/e2e.md`.

- **Command:** `npm run test:e2e` from the repo root. It compiles, then Playwright starts a fresh Hardhat node (8546), the local pinning store (8547) and the dev server in test-wallet mode (5174); global setup deploys the escrow to the generated address; the suite runs and everything stops. Result: 12 passed in about 1 minute, five times in a row.
- **Scenarios (12):** create → accept → encrypted submit → client download and decrypt (wrong, then right passphrase; exact bytes) → approve → completion → withdraw; two revisions then auto-approval at D − 1 / D; overdue refund at D − 1 / D and withdrawal; cancel; decline; forfeit; arbitrator resolution with the preview compared with `DisputeResolved` and every `BalanceCredited` to the wei; expired settlement at D − 1 / D (resolution checked on-chain at D − 1 and D too); unsupported network; stale-tab double approval; duplicate submission refused by the proxy; isolation between projects and accounts. Also wallet switching (`accountsChanged`) and a rejected wallet prompt.
- **Real chain, mocked IPFS:** every scenario uses real transactions on the node; amounts, statuses, events and ETH balances (including gas) are read from it. Only Pinata is replaced, by the local pinning store (real CIDs, Pinata's limits), behind the real upload proxy.
- **Real Pinata:** `npm run test:e2e:pinata` (opt-in, skipped without `PINATA_JWT`) passed twice on 2026-10-28 against real Pinata: browser upload, on-chain submit, gateway read, decryption and hash check. Reads go through `VITE_PINATA_GATEWAY` or `gateway.pinata.cloud`, because `ipfs.io` and `dweb.link` answered 429 during the first attempt.
- **Bug found and fixed:** on an unsupported network the project page still offered transaction buttons (accept, approve, dispute…), which would have signed on the wallet's actual network. `ProjectPage` now hands the account to its actions only when the wallet can transact; the robustness scenario covers it.
- **Dev-only seams:** test-wallet hooks (`?testChain`, `switchAccount`, `rejectNextTransaction`), the gateway override and the local pinning signer, all limited to `vite --mode testwallet`; the production bundle contains none of them (checked).
- **Reviews:** standards/security found no hard violation (secrets, seam gating, localhost binding, contracts untouched all confirmed); fixed the pinning-store swap to test-wallet mode only and shared helpers. Spec review: fixed absence checks that could pass before the wallet loaded (`openAs` now waits for the connected account), exact button names, specific error texts, innermost-box scoping, on-chain arbitrator checks at D − 1 / D, a revision request refused at D, and the dashboard's Completed status.
- **Left as is:** approval at D is accepted on-chain by design (spec, as built in ticket 05), so only the revision request is probed at D; forfeit's per-milestone D − 1 / D boundary and late submission at D are covered by the contract suites, not here; MetaMask's own UI is not exercised (the test wallet replaces it). CI needs Chrome or `E2E_BROWSER_CHANNEL=` with `npx playwright install chromium`.
