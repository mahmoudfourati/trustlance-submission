# TrustLance

A university project: a decentralized freelance escrow on Ethereum L1 (local Hardhat network for development, Sepolia for the demo). Test ETH only, never real funds.

- Domain vocabulary: `CONTEXT.md`. Use its terms in code, UI and tickets.
- Decisions: `docs/adr/`. Full spec, state machines and invariants: `docs/spec.md`. Tickets: `docs/tickets/`.
- Sepolia deployment (live, verified): `0xE387D1Eb6880B2A02EC14b49f90B0e63d1638789`, record in `contracts/ignition/deployments/chain-11155111/`. Don't redeploy. Keep `contracts/contracts/TrustLanceEscrow.sol` byte-identical to the verified source (comments included): any edit changes the metadata hash.

## Architecture

npm workspaces, three deployable parts:

- **Contracts** (Hardhat 3, Solidity, OpenZeppelin 5): one non-upgradeable `TrustLanceEscrow` contract holds every project. It uses pull payments, is deployed with Ignition, and keeps secrets in the Hardhat keystore.
- **Web** (React, Vite, TypeScript, Tailwind, ethers v6, MetaMask). Reads come from contract views; the activity timeline comes from event logs. No indexer, no database, no mock chain data.
- **Upload proxy**: the only server code. One serverless function that issues short-lived Pinata signed upload URLs to verified freelancers (ADR 0004).

Out of bounds: L2s, bridges, tokens/NFTs, extra backend services, upgradeable proxies.

## Commands

Run from the repo root (Node ≥ 22.13):

- `npm install`: install all workspaces
- `npm run compile`: compile contracts (`hardhat build`)
- `npm test`: contract tests (Solidity + mocha), then web unit tests (vitest)
- `npm run test:coverage`: tests with Solidity coverage
- `npm run test:deep -w @trustlance/contracts`: the long fuzz and invariant campaign (`deep` test profile); see `docs/security.md`
- `npm run typecheck`: compile, then typecheck contracts and web
- `npm run lint`: oxlint on the web app
- `npm run chain`: local Hardhat node at http://127.0.0.1:8545
- `npm run deploy:local`: deploy to the running local node with Ignition and export the ABI and address to `web/src/contracts/generated/`
- `npm run dev`: web dev server at http://localhost:5173 (`npm run dev -w @trustlance/web -- --mode testwallet` starts it with the dev-only test wallet that signs with local node accounts; `?testAccount=N` picks the account, default 2)
- `npm run build`: production web build
- Upload proxy: served by `npm run dev` at `/api/upload-url`; needs `PINATA_JWT` in `web/.env.local` (copy `web/.env.example`). `npm run smoke:upload -w @trustlance/web` runs the manual smoke test against real Pinata. See `docs/upload-proxy.md`.
- `npm run test:e2e`: Playwright end-to-end suite (fresh node on 8546, local pinning store, dev server on 5174; needs Chrome, see `docs/e2e.md`). `npm run test:e2e:pinata` is the opt-in real-Pinata browser test (skipped without `PINATA_JWT`)
- `npm run check`: all of the above in order except the end-to-end suites; run it, and `npm run test:e2e`, before marking a ticket done
- Secrets: `npx hardhat keystore set SEPOLIA_RPC_URL` (and `SEPOLIA_PRIVATE_KEY`, `ETHERSCAN_API_KEY`), run inside `contracts/`
- `npm run deploy:sepolia`: Ignition deploy to Sepolia with `contracts/ignition/parameters/sepolia.json`, Etherscan verification and export to the web app; `npm run check:sepolia` re-checks the deployment read-only (no secrets). `npm run diagnose:sepolia -w @trustlance/contracts` is a read-only pre-deployment check of the keystore deployer and RPC. The `sepolia` network is locked to chain id 11155111. See `docs/deployment.md`

Toolchain (installed 2026-10-25): hardhat 3.21, hardhat-toolbox-mocha-ethers 4.0, solc 0.8.34, ethers 6.17, react 19.3, vite 8.3, tailwindcss 4.3, oxlint 1.89, Playwright 1.64 (added 2026-10-28). TypeScript is 6.0, not 7.0, because both the Hardhat and Vite templates still pin `~6.0.3`.

Accepted audit finding: `npm audit` reports 13 "high" issues, all from one advisory in the `zod@3` that Hardhat depends on (GHSA-mrhx-c7xc-m3w5, memory exhaustion on oversized input). It only validates our own config at dev time, and forcing zod 4 would break Hardhat. Re-check when Hardhat upgrades.

Hardhat generates `contracts/CLAUDE.md`, `contracts/AGENTS.md` and `hardhat` skills locally; they are gitignored. Load the `hardhat` skill before writing contract tests.

## Security rules (contract)

- Checks-effects-interactions everywhere. `withdraw` is `nonReentrant` and is the only function that sends ETH.
- Every payout credits a withdrawable balance; nothing pushes ETH.
- `createProject` requires `msg.value` to equal the milestone total exactly. There's no `receive`/`fallback`.
- Each function checks the caller's role and the project and milestone state, as in the spec's state-machine tables.
- Deadlines are half-open: a window action needs `block.timestamp < D`, an expiry action needs `block.timestamp >= D`. Test both sides at D − 1 and at D.
- Approved milestones and withdrawable balances are final: no refund, dispute or forfeit path may touch them, and only `withdraw` lowers a balance.
- At most 2 revision requests per milestone; the counter is never reset.
- A dispute pays out once: arbitrator resolution while `now < raisedAt + 30 days`, expired settlement from then on.
- Loops only over one project's milestones (max 20), never over projects or users.
- The admin only changes settings for future projects and pausing of new projects. It never touches escrow.
- Every invariant listed in the spec has a test. Add malicious-actor and boundary tests (at D − 1 and at exactly D) for each new path.
- No private keys, RPC keys or the Pinata JWT in the repo. Use the Hardhat keystore and host environment variables, and commit only `*.example` files.

## Conventions

- One ticket at a time, test-first (`tdd`) for contract logic. Run compile and tests after each relevant change, and never report tests as passing unless they really ran.
- Custom errors, not revert strings. One event per state transition.
- Small commits after a ticket is verified, then `git push` to `origin/main` (https://github.com/mahmoudfourati/trustlance). Never force-push or rewrite history.

## Tickets and domain docs

- Tickets are markdown files in `docs/tickets/NN-<slug>.md`: a `Status:` line, an acceptance checklist and dated comments. The spec is `docs/spec.md`.
- Single-context domain docs: one `CONTEXT.md` and `docs/adr/` at the repo root.

## Engineering skills workflow

Proactively use the installed Skills For Real Engineers plugin throughout TrustLance development.

Follow this workflow:

1. Architecture and requirements: use `grill-with-docs` and `to-spec`.
2. Planning: use `to-tickets` before implementation.
3. Implementation: use `implement` and apply `tdd` for smart-contract logic, especially escrow, withdrawals, refunds and disputes.
4. Verification: use `code-review` after security-sensitive changes and before completing each major milestone.
5. Debugging: use `diagnosing-bugs` for nontrivial failures.
6. Architecture decisions: use `domain-modeling` when establishing or changing important concepts and rules.

Do not skip specification, testing or review for security-sensitive features.

Use these skills proactively when relevant, without needing explicit instructions for every invocation. If a named skill is unavailable, report that and use an equivalent workflow.

At the end of each implementation ticket, summarize the changes, tests executed, outstanding risks and next ticket.
