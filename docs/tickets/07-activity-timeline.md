# 07: On-chain activity timeline

**What to build:** Each project page shows a timeline built from the contract's event logs (from the deployment block, filtered by project id), with readable descriptions, timestamps, actors and explorer links. It updates live after new transactions.

**Blocked by:** 06

**Status:** ready-for-human

- [x] Every event type in the spec renders with a readable description
- [ ] Works on local and Sepolia (handles RPC log-range limits by paging). Local and paging are done; the Sepolia run waits for the deployment in ticket 13 (see comments).
- [x] Events newer than the confirmation threshold are marked unconfirmed

## Comments

**2026-10-26 (agent):** implemented; waiting for an independent review.

- **Logs:**
  - `web/src/lib/logs.ts` holds `fetchInPages`. It scans from the deployment block to the latest block in pages of the chain's `maxLogRange`: 1,000,000 on local, 10,000 on Sepolia. When the RPC rejects a range, it halves the page size.
  - Rate-limit errors, pruned history and other errors are rethrown, not retried with smaller pages.
  - Dashboard titles (`loadProjectTexts`) use the same paging.
- **Timeline:**
  - `getProjectDetail` reads one project's logs once. Those logs give the titles, the revision notes and the timeline.
  - There are two scans: `[any, projectId]` and `[BalanceCredited, any, projectId]`. Decoded events whose `projectId` isn't this project are dropped, which covers an account topic that happens to equal the id.
  - Block timestamps and transaction senders are cached per hash. The cached value is the request itself, so events from one transaction share a single call.
  - `web/src/lib/timeline.ts` describes all 12 project events. A test checks this list against every ABI event with a `projectId` input, so ticket 08's dispute events will fail it until they get descriptions.
  - Both `ProjectCompleted` and `ProjectForfeited` mark the project as Completed.
  - Events are sorted by block, then log index, with duplicates removed.
  - An event is confirmed once `latest − block + 1 ≥ confirmations`. That threshold is 1 on local and 5 on Sepolia.
- **UI:**
  - The "Activity" card on the project page lists each event with its description, details (manifest CID with review deadline, revision note with new delivery deadline, forfeit split), time, sender and role, block, and a transaction link (a plain hash on local), plus an "unconfirmed" badge when needed.
  - The page refetches every 15 s and is also invalidated after each confirmed transaction.
  - If a background refresh fails, the last data stays on screen with a warning, rather than being replaced by an error page.
- **Sepolia RPC:**
  - A read-only probe showed that publicnode only serves about the last 10k blocks of logs ("pruned history unavailable"). The default read RPC is now `sepolia.gateway.tenderly.co`, which served a 150k-block history in 10k pages.
  - Tenderly returned partial results for a single 150k-block range, with no error. That is why `maxLogRange` stays at 10k.
  - Override with `VITE_SEPOLIA_RPC_URL`. The URL must keep full log history back to the deployment block.
- **Tests:**
  - 20 new web unit tests in `logs.test.ts` and `timeline.test.ts`, written test-first, for 123 web tests in total. They cover paging with no gaps, halving, rethrows and rate limits, every description, ordering, deduplication, the confirmation threshold and actor roles.
  - The contract is unchanged: 110 tests, 100% coverage.
- **Live check:** on the local node with the test wallet, four seeded projects and one extra:
  - full lifecycle with a revision and an auto-approval sent by a third party;
  - forfeit;
  - decline;
  - cancel;
  - no events from other projects appear;
  - an external accept showed up within about 7 s;
  - stopping the node showed the stale-data warning;
  - no horizontal overflow at 375 px.
- **Deviations and limits:**
  - Dispute events belong to ticket 08 and aren't in the ABI yet.
  - `Withdrawn` has no project id, so it isn't on project timelines.
  - Each refresh rescans the whole history. That is fine for a demo-sized history, but there is no incremental scan.
  - An RPC that silently truncates results can't be detected; the conservative page size is the only mitigation.
  - Contract views and the log scan can read one block apart for a moment.
- **Still open from tickets 04 and 05:** the real Pinata upload has not been run, because there is no JWT.

**2026-10-28 (ticket 13):** the Sepolia criterion is still open, because nothing is deployed to Sepolia yet (deployment needs the owner's keys; see ticket 13). Checks T1–T3 (confirmation badge, paged logs, dashboard titles) are in `docs/deployment.md` §7. The read RPC was re-probed: CORS works, and logs 200,000 blocks back are served.
