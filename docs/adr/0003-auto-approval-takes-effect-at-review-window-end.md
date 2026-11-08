# Auto-approval takes effect when the review window ends, and revisions are capped

A milestone submitted at T counts as approved from exactly T + review window, even if nobody has yet sent the transaction that records it. Anyone may record it, and raising a dispute (or forfeiting) first records every such milestone as approved, so it is credited to the freelancer instead of frozen. A dispute raised before that second freezes the milestone, and it is never auto-approved. Without this rule, a client who stayed silent past the window could still freeze earned money by disputing before the freelancer claimed it.

All contract deadlines use the same half-open convention: the deadline second belongs to the expiry side (`now >= D`), and the window side ends one second before (`now < D`). At any timestamp exactly one side is valid.

A client may request at most 2 revisions per milestone. The count is never reset, and a revision request is the only path from Submitted back to Pending. After that, the client must approve, let auto-approval happen, or dispute.

## Consequences

- A revision request is only valid inside the review window. It extends the milestone's delivery deadline to at least now + review window, so the client can't send work back and then refund it as overdue.
- Without a dispute, payment for on-time work is decided by D₀ + 5 × review window at the latest (D₀ = original delivery deadline).
- Raising a dispute loops over the project's milestones. Milestones per project are capped (20), so the loop is bounded.
