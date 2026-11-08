# 13: Sepolia deployment and hosted demo

**What to build:** Deploy and verify the contract on Sepolia with Ignition, using keystore secrets. Host the web app and upload proxy with production environment variables, and run the manual MetaMask checklist end to end with test ETH.

**Blocked by:** 11, 12

**Status:** ready-for-human (the deployment, hosting and demo run need the owner's wallet and credentials)

- [x] The contract is verified on Etherscan; address and deployment block are exported to the web app
- [x] No secret is in git (checked with a search of the full git history)
- [x] README: setup, commands, architecture, trust assumptions, known risks and demo accounts
- [ ] Manual checklist results recorded, including the transaction hashes of the demo flow

## Comments

**2026-10-28 (agent):** everything that needs no credentials is done; deployment, hosting and the demo run wait for the owner. This machine has no Hardhat keystore, Etherscan key or Vercel account, and the agent must not handle private keys. Nothing was deployed to Sepolia, so there is no address or transaction hash yet.

- **Deployment tooling:**
  - `npm run deploy:sepolia` runs Ignition with `--network sepolia --parameters ignition/parameters/sepolia.json --verify`, then exports the address to the web app. Secrets (`SEPOLIA_RPC_URL`, `SEPOLIA_PRIVATE_KEY`, `ETHERSCAN_API_KEY`) come only from the keystore. `hardhat.config.ts` gained `verify.etherscan.apiKey = configVariable("ETHERSCAN_API_KEY")`.
  - `sepolia.example.json` is the parameters template (admin, arbitrator, fee).
  - Without a keystore, the deploy stops with `HHE7 … SEPOLIA_RPC_URL not found` before sending anything (checked).
- **Deployment checker:** `npm run check:sepolia` is `contracts/scripts/check-deployment.ts`, read-only and needing no secrets. It checks:
  - the chain id, and the code size (15,600 of 24,576 bytes);
  - the bytecode against the artifact Ignition deployed (immutables masked);
  - the receipt and `deploymentBlock()`;
  - the owner, default arbitrator and fee against the journal, and that the admin and arbitrator differ;
  - that creation isn't paused, and the exported address.

  Exercised locally: everything passed on a fresh Ignition deployment, and the export check failed as it should when the journal and the export disagreed.
- **Deployment block:** not exported. The web app reads the `deploymentBlock()` immutable from the contract, which is equivalent and can't drift. Recorded here as a deviation from the criterion's wording.
- **Hosting:** `web/vercel.json` sends every non-`/api` path to the single-page app. `docs/deployment.md` lists the production variables, which split into server-only and public. A curl probe tells "configured" (400) from "missing JWT" (503).
- **Security checks:**
  - **Git history:** the full-history search (15 commits) found no JWT, private key, RPC key or tracked `.env`; only `web/.env.example` with two public, keyless RPC URLs.
  - **Production bundle:** contains no test-wallet or E2E hook and no server variable; browser code reads only `VITE_*`.
  - **Admin:** `whenNotPaused` is only on `createProject`, and the four `onlyOwner` functions change future-project settings or pause; both are tested.
  - **Read RPC:** the Sepolia read RPC (Tenderly) answers browser CORS and serves logs 200,000 blocks back.
- **Documentation:** a new `README.md` with an architecture diagram, technologies, roles, lifecycle, disputes, setup, commands, results, environment variables and secrets, demo and risks. Also a new `docs/deployment.md` (accounts and faucets, keystore, parameters, deploy and verify, check, Vercel, demo checklist, troubleshooting), and `docs/security.md` and `CLAUDE.md` updated.
- **Verification:** `npm run check` passed (188 contract and 148 web tests), `npm run test:e2e` passed 12/12, and `npm run test:e2e:pinata` passed against real Pinata (manifest `bafkreieio7b4ldrsxxhgywzymchrtkz4ylf22dbxgysr4d2x7fvgykbyq4`).
- **Reviews:**
  - Spec and standards/security found no security violation.
  - Fixed:
    - the README said "anyone" can settle an expired dispute (it is the client or freelancer);
    - an unverifiable GET claim in the proxy check (replaced by a POST probe);
    - the checker now reads the deployed artifact (no compile needed), parses the export, and stops cleanly when there is no code;
    - the admin's two-step transfer is now documented, and "payout" is reworded (CONTEXT.md).
  - Left as is: the proxy's built-in 31337 RPC default in production (it fails closed; documented); a wrong address typed into `sepolia.json` would pass the checker, which prints the addresses for a person to confirm.
- **Still open, for the owner** (steps in `docs/deployment.md`):
  1. Keystore secrets, the parameters file and Sepolia ETH for four demo accounts.
  2. `npm run deploy:sepolia`, then `npm run check:sepolia`; commit the deployment record. This unlocks criterion 1.
  3. Vercel project and production variables.
  4. The demo checklist (A1–A9, B1–B5) with transaction hashes, plus the demo account addresses in the README. This unlocks criteria 3 and 4.
  5. Ticket 07's T1–T3.

**2026-11-04 (agent):** fixed the owner's failed Sepolia deployment (`HHE10723: Requested account index '1' is greater than the total number of available accounts '1'`). The Ignition module defaulted `arbitrator` to `m.getAccount(1)`, and Ignition validates that index even when the parameter is set. `admin` and `arbitrator` are now required parameters with no account defaults, and `npm run deploy:local` passes the new `ignition/parameters/local.json` (accounts 0 and 1, 1% fee). The contract is unchanged. `contracts/test/ignition.deployment.ts` covers a one-signer chain, missing parameters and the local file. Sepolia has still not been deployed: the owner retries it.

**2026-11-05 (agent):** the owner's next attempt failed with `HHE10409: gas required exceeds allowance (0)`, and its record was in `ignition/deployments/chain-1/`: `SEPOLIA_RPC_URL` was on Ethereum mainnet. The journal stops before any send, so nothing was sent. The `sepolia` network is now locked with `chainId: 11155111`, so Hardhat refuses every request but a chain ID read on another chain (`HHE708`). `contracts/test/sepolia.chainGuard.ts` covers this with a fake chain 1 RPC, including a control showing a transaction does get through on Sepolia. `npm run diagnose:sepolia -w @trustlance/contracts` is a read-only check of the deployer, chain, fees and balance. Sepolia has still not been deployed: the owner retries it.

**2026-11-07 (agent, submission cleanup):** the owner deployed to Sepolia: `0xE387D1Eb6880B2A02EC14b49f90B0e63d1638789`, block 12082738. Checked read-only, without secrets: `npm run check:sepolia` passed every check; Etherscan shows "Source Code Verified" (Exact Match) and Sourcify reports `exact_match`. The deployment record, `sepolia.json` (public addresses only) and the Sepolia entry of `deployments.ts` are now committed. The event logs show two happy-path projects completed and withdrawn by a separate client and freelancer; the hashes are in `docs/deployment.md` § 8. Criterion 1 is ticked (the deployment block is still read from `deploymentBlock()`, as noted on 2026-10-28). Criterion 3 is ticked with the README rewrite and `DEMO.md`. Criterion 4 stays open: project B (dispute and arbitrator resolution), T1–T3 and the browser-only steps (decryption, timeline confirmations) were not recorded on Sepolia. Vercel hosting was not set up and is documented as optional.
