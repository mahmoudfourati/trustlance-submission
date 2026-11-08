# 09: Expired-dispute settlement

**What to build:** From exactly 30 days after a dispute is raised, either party settles it if the arbitrator hasn't: frozen pending milestones are refunded to the client, frozen submitted milestones are split 50/50 (odd wei to the client), no fee is charged, and approved milestones and existing balances are untouched. Contract and tests only.

**Blocked by:** 08

**Status:** ready-for-human

- [x] Boundary tests: at arbitrationDeadline − 1, settle reverts and resolve works; at exactly arbitrationDeadline, the reverse
- [x] Race tests: resolve and settle mined in the same block (automine off) at each boundary, so exactly one succeeds; any second settlement of either kind reverts with `NotDisputed`
- [x] Outsiders and the arbitrator can't trigger it; the credits sum to exactly the frozen amount; a second disputed project with the same parties is unchanged
- [x] Odd-wei split test; a test that the arbitrator's balance is unchanged
- [x] Security review with `code-review` before the ticket is closed

## Comments

**2026-10-26 (agent):** implemented; waiting for an independent review.

- **Contract:** `settleExpiredDispute(projectId)`.
  - Guards, in order: the project must be Disputed (otherwise `NotDisputed`), the caller must be its client or freelancer (otherwise `NotProjectParty`), and `now ≥ raisedAt + 30 days` (otherwise `ArbitrationPeriodOpen(deadline)`).
  - Payouts: `frozenPendingAmount + (frozenSubmittedAmount − ⌊frozenSubmittedAmount / 2⌋)` to the client and `⌊frozenSubmittedAmount / 2⌋` to the freelancer. No fee; the two amounts always add up to `frozenAmount`.
  - The project is Resolved, and its frozen milestones too, before anything is credited. Zero amounts aren't credited, and both credits use `CreditReason.DisputeSettlement`.
  - `ExpiredDisputeSettled(projectId, settledBy, freelancerAmount, clientAmount)` is emitted after the credits.
  - `resolveDispute` now shares `_disputedProject`, `_arbitrationDeadline` and `_payOutDispute` with it. Its behaviour is unchanged, and all ticket 08 tests still pass.
  - The optimized runtime is 15.6 KB.
- **Who can settle:**
  - Only the client or freelancer, per this ticket ("Outsiders and the arbitrator can't trigger it"), the spec's state table, CONTEXT.md and ADR 0002.
  - The implementation request asked for permissionless settlement; the repository documents were followed instead.
  - Settlement still works while project creation is paused.
- **Tests:**
  - 19 new tests in `contracts/test/TrustLanceEscrow.settlement.ts`, written test-first, for 164 contract tests at 100% line and statement coverage. They cover:
    - the D − 1 / D boundaries for both settle and resolve;
    - same-block races (automine off) at D − 1 and at D in both orders, plus two settlements in one block. The losing transaction's custom error is read from its trace, so an unrelated revert can't pass as a lost race;
    - a second settlement of either kind reverting with `NotDisputed`;
    - outsiders, the arbitrator and the admin rejected;
    - a 6-row fallback table: pending only, an even split, odd wei, 1 wei, several submissions added before halving, ETH-sized amounts;
    - the arbitrator's balance unchanged;
    - approvals, earlier refunds and existing balances unchanged;
    - a second disputed project with the same parties unchanged;
    - a contract client that rejects ETH and then re-enters `withdraw`.
- **Web (only what the new ABI forces; the dispute UI is ticket 10):** a timeline description for `ExpiredDisputeSettled` that ends the project, and a message for `ArbitrationPeriodOpen`. 125 web tests.
- **Live check** on the local node: 1 ETH approved, then a dispute over 2 ETH + 1 wei submitted and 3 ETH pending, settled by the freelancer at exactly the deadline. The freelancer was credited 1 ETH from the settlement, 2 ETH in total; the client got 4 ETH + 1 wei. The timeline shows the settlement.
- **Reviews:**
  - Neither review found a bug.
  - Fixed after review:
    - the client amount is computed literally from `frozenPendingAmount`;
    - the arbitration deadline comes from one helper;
    - the race tests check the losing error and the order the transactions were mined in;
    - a test for settling while paused;
    - code style in `errors.ts`.
- **Deferred:** the Solidity fuzz/invariant suite and the remaining attacker contracts (ticket 11), and the dispute UI with the settle action (ticket 10). The timeline shows amounts to 4 decimals, so the odd wei isn't visible there.
- **Still open:** the real Pinata upload (tickets 04–05) and the Sepolia timeline run (ticket 07, after ticket 13) have not been done.
