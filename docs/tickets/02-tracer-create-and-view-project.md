# 02: Tracer bullet: create a funded project and view it

**What to build:** A client connects MetaMask on the local Hardhat network, creates a project with milestones and funds it in the same transaction, and sees it on their dashboard and on a project page read from chain. This includes the contract's project record, platform config (constructor: admin, default arbitrator, fee bps), the creation bounds, the `ProjectCreated`/`MilestoneDefined` events, the role-specific project-id views (`projectIdsAsClient/AsFreelancer/AsArbitrator`), the local Ignition deployment and the ABI/address export to the web app.

**Blocked by:** 01

**Status:** resolved

- [x] Contract tests: valid creation stores the snapshot arbitrator/fee and emits events; every bound violation and every `msg.value` that differs from the total reverts with a specific custom error; plain ETH transfers revert
- [x] Wallet connect, account/network display, unsupported-network prompt with switch
- [x] Create-project form validates client-side and shows the arbitrator and fee before signing
- [x] The transaction helper shows pending/confirmed/failed with decoded errors
- [x] The client dashboard lists the project, and the project page shows milestones and escrow from chain

## Comments

**2026-10-25, done.** Contract tests were written first (31 mocha tests: deployment, happy path with balance changes and exact event args, multi-project independence and `totalEscrow` == balance, 17 malformed-param cases, deposit off-by-one, overflow, plain-ETH reverts). Web: 25 vitest tests for form validation and error decoding. The full flow was checked in the browser against a local node with the dev test wallet: create, auto-navigate to the project page, dashboard listing, decoded reverts, unknown ids, read-only mode and 375 px layout.

Deviations: `projectIdsOf` became three role-specific views, `deploymentBlock` was added for log scans, and a dev-only test wallet was pulled forward from ticket 12. The spec is updated for all three. The pause guard on creation lands with ticket 08, and so does the test that a fee/arbitrator change does not affect existing projects (it needs the setters).
