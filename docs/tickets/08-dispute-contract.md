# 08: Disputes in the contract: raise and arbitrator resolution

**What to build:** Contract support for raising a dispute (crediting expired reviews first, then freezing all remaining Pending/Submitted milestones) and for the project's snapshot arbitrator resolving it with the fee. Also the admin setters (default arbitrator, fee bps with a 10% cap, pause creation) with events. Contract and tests only; no UI.

**Blocked by:** 06

**Status:** ready-for-human

- [x] A table-driven accounting test: fee rounding, 0%/100% freelancer share, a share larger than (frozen − fee) reverts, multiple projects at once
- [x] Tests: only the client or freelancer can raise; only the snapshot arbitrator can resolve; resolving succeeds at arbitrationDeadline − 1 and reverts at exactly arbitrationDeadline; a second resolve reverts; milestone actions revert while Disputed; `NothingToDispute` when everything is settled
- [x] Tests: a dispute at reviewDeadline − 1 freezes that submitted milestone; at exactly reviewDeadline it is credited to the freelancer first
- [x] Isolation tests: approved milestones and every existing withdrawable balance are unchanged by raising and resolving a dispute; the freelancer can withdraw earlier earnings while the dispute is open; with two projects sharing the same client, freelancer and arbitrator, disputing and resolving one leaves the other's record and frozen amount unchanged
- [x] Admin changes don't affect existing projects; pause blocks only `createProject`; Ownable2Step transfer
- [x] Security review with `code-review` before the ticket is closed

## Comments

**2026-10-26 (agent):** implemented; waiting for an independent review.

- **Contract:**
  - `raiseDispute(projectId, reason)`: the client or freelancer of an Active project, with a reason of 1–1000 bytes (kept in the event only).
    - First it credits every Submitted milestone whose review window has ended (ADR 0003; this helper is now shared with `forfeit`).
    - Then it freezes what is left: it records `raisedBy`, `raisedAt`, `frozenAmount`, `frozenPendingAmount` and `frozenSubmittedAmount`, and the project becomes Disputed.
    - With nothing left to freeze it reverts with `NothingToDispute`, and the revert also undoes the credits.
    - The frozen milestones keep their status and stay counted in `pendingAmount`/`submittedAmount` while Disputed.
  - `resolveDispute(projectId, freelancerShare)`: only the snapshot arbitrator, only while Disputed, only while `now < raisedAt + 30 days`.
    - fee = ⌊frozen × feeBps / 10 000⌋, using the fee rate copied into the project at creation. `freelancerShare` must be ≤ frozen − fee, and the client gets the rest.
    - The status becomes Resolved before anything is credited. The frozen milestones become Resolved, `pendingAmount` and `submittedAmount` drop to 0, and `frozenAmount` remains as the record of what was paid out.
    - Zero credits are skipped.
    - `DisputeResolved` is emitted after the credits, as `ProjectForfeited` is.
  - `CreditReason` gains `ArbitrationFee` and `DisputeSettlement`; the second is meant for ticket 09 too.
  - Errors: `NotProjectParty`, `NotArbitrator`, `InvalidReason`, `NothingToDispute`, `NotDisputed`, `ArbitrationPeriodEnded`, `ShareTooLarge`.
  - Admin:
    - `setDefaultArbitrator` (rejects the zero address) and `setArbitrationFeeBps` (≤ 1000), with `DefaultArbitratorChanged` and `ArbitrationFeeChanged` events.
    - OpenZeppelin `Pausable` (`pause`/`unpause`) gates only `createProject`.
- **Compiler:**
  - Without the optimizer the contract no longer fits the 24 KB limit (25.6 KB).
  - The `default` profile now uses the same optimizer as `production` (200 runs), so tests run the bytecode that gets deployed. The optimized runtime is 15.3 KB.
- **Tests:**
  - 35 new tests in `contracts/test/TrustLanceEscrow.disputes.ts`, written test-first, for 145 contract tests at 100% line and statement coverage. They cover:
    - wrong callers and every non-Active state;
    - the reviewDeadline − 1 / reviewDeadline and arbitrationDeadline − 1 / arbitrationDeadline boundaries;
    - double resolution;
    - all milestone actions and forfeit reverting while Disputed;
    - a 7-row accounting table (rounding, 0% and 100% shares, the 10% cap, odd wei);
    - four disputes open at once;
    - isolation between projects sharing all three parties, with snapshots taken before the raise and before the resolve;
    - a dispute after an overdue refund;
    - withdrawals during a dispute;
    - a contract client that rejects ETH and a contract arbitrator that re-enters `withdraw`;
    - the admin setters, pause, and the two-step admin transfer.
  - `EscrowPartyMock` gained `raiseDispute`/`resolveDispute` pass-throughs.
- **Web (only what the new ABI forces; the dispute UI is ticket 10):**
  - Timeline descriptions for `DisputeRaised` (who raised it, the frozen amount, the reason, the arbitrator's last second) and `DisputeResolved` (the split, shown as ending the project).
  - The new credit reasons.
  - A plain-language message for every new error. `ExpectedPause` is admin-only and excluded.
  - 124 web tests.
- **Live check** on the local node: one project with an expired review credited at raise time, then resolved (2.5 ETH to the freelancer, 2.45 ETH to the client, 0.05 ETH fee); one project left Disputed. The timelines read correctly and no actions are offered.
- **Reviews:**
  - Neither review found a contract bug.
  - Fixed after review:
    - the shared expired-review helper;
    - a malicious-actor test;
    - a test that disputes a project with an earlier refund;
    - a pre-raise isolation snapshot;
    - a multi-project accounting test;
    - `DisputeResolved` shown as ending the project;
    - neutral `ProjectNotActive` wording.
- **Limits and deviations:**
  - Until ticket 09 adds `settleExpiredDispute`, a dispute whose arbitrator never acts stays frozen (invariant 9). Don't deploy to Sepolia before ticket 09.
  - `DisputeResolved` indexes the project and arbitrator only (three topics at most). The client and freelancer are indexed on the `BalanceCredited` events.
  - The project page's escrow card doesn't yet show frozen or dispute-settled amounts; that is ticket 10.
  - The fuzz/invariant suite and the remaining attacker contracts are ticket 11.
- **Still open:** the real Pinata upload (tickets 04–05) and the Sepolia timeline run (ticket 07, after ticket 13) have not been done.
