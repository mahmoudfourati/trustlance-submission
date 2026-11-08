# 06: Overdue refunds and freelancer forfeit

**What to build:** A client refunds an overdue Pending milestone. A freelancer forfeits a project: expired reviews are credited to them first, then every other unapproved milestone is refunded and the project Completes.

**Blocked by:** 05

**Status:** ready-for-human

- [x] Tests: refund only from exactly the delivery deadline (reverts at deadline − 1) and only for Pending; a late submission before the refund blocks it
- [x] Test (carried over from ticket 05): right after a revision request made at the last second of the review window, an overdue refund reverts until the extended delivery deadline
- [x] Tests: forfeit never lowers the freelancer's credited total; submitted milestones whose review window ended are credited, not refunded
- [x] UI actions with confirmation dialogs that explain what each action costs

## Comments

**2026-10-26 (agent):** implemented; waiting for an independent review.

- **Contract:**
  - `refundOverdueMilestone(projectId, index)`: client only, on a Pending milestone of an Active project, from exactly `deliveryDeadline`. Before that it reverts with `DeliveryWindowOpen`.
  - `forfeit(projectId)`: freelancer only, on an Active project. Submitted milestones whose review window has ended are credited first; every other Pending or Submitted milestone is refunded with one shared client credit; the project becomes Completed.
  - `ProjectForfeited(projectId, client, freelancer, creditedAmount, refundedAmount)` is emitted instead of `ProjectCompleted`. A refund that settles the last open milestone emits `ProjectCompleted`.
  - Decline and cancel now share the per-milestone refund helper. Their behaviour is unchanged and their tests still pass.
- **Tests:** 21 new ones in `contracts/test/TrustLanceEscrow.exits.ts`, written test-first. That makes 110 contract tests, with 100% line coverage. They cover:
  - the D − 1 and D boundaries for refund, for forfeit around a review deadline, and for the extended delivery deadline (the ticket 05 carry-over);
  - a late submission blocking the refund, plus a same-block race where exactly one transaction wins;
  - wrong callers, wrong states, refunding twice and Approved milestones never being refunded;
  - forfeit never lowering the freelancer's credited total, with a second project between the same parties left untouched;
  - the bookkeeping and the contract-balance invariant after every path, and both parties withdrawing.
- **Web:**
  - Each milestone row offers the client a refund from the delivery deadline, with a confirmation that states the cost and explains the race with a late submission. Rows also say when a refund becomes possible.
  - The freelancer gets a forfeit action on Active projects. Its confirmation shows the credited and refunded split (`forfeitPreview`, unit-tested to mirror the contract).
  - The Completed banner now covers refunded and forfeited projects.
- **Live check** against the local node with the test wallet: an overdue refund, and a forfeit with one expired review credited, one in-review submission and one Pending milestone refunded.
- **Deferred:** attacker-contract tests for these paths go to ticket 11, and timeline display of `ProjectForfeited` to ticket 07.
- **Still open from tickets 04 and 05:** the real Pinata upload has not been run, because there is no JWT.
