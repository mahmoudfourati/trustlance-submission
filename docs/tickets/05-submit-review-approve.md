# 05: Submit, review, approve and auto-approve milestones

**What to build:** A freelancer uploads a deliverable and submits a milestone in one flow. The client downloads and decrypts it, then approves it or requests a revision inside the review window (at most 2 per milestone). Anyone can record an auto-approval from exactly submission time + review window. The project becomes Completed when no milestone is Pending or Submitted.

**Blocked by:** 04

**Status:** ready-for-human

- [x] Contract tests for every milestone state-machine row in the spec except overdue refunds. At reviewDeadline − 1, a revision succeeds and auto-approval reverts; at exactly reviewDeadline, the reverse
- [x] A revision request extends the delivery deadline to at least now + review window (test proves the client can't refund straight away). The extension was tested here; the refund half was completed in ticket 06 (`TrustLanceEscrow.exits.ts`)
- [x] Revision limit: a third request reverts with a dedicated error; the count survives resubmission; after two revisions only approve, auto-approval or dispute are possible
- [x] Payment-time bound test: with the client revising in the last second each time, auto-approval is possible no later than D₀ + 5R
- [x] Approving credits the freelancer's balance; completion fires exactly once
- [x] The milestone UI shows status, countdowns, revisions left, deliverable download with passphrase prompt, a public-file warning, approve/revise actions and the auto-approve action

## Comments

**2026-10-26 (agent):** implemented; waiting for an independent review.

- Contract:
  - `submitMilestone(projectId, index, cid)`, `approveMilestone`, `requestRevision(projectId, index, note)` and `finalizeAutoApproval` (callable by anyone).
  - Completion fires when nothing is left Pending or Submitted.
  - New project totals: `submittedAmount` and `approvedAmount`.
  - New milestone fields: `revisionCount`, `submittedAt`, `reviewDeadline` and `deliverableCid`.
  - New credit reason `Approval`, plus the events `MilestoneSubmitted`, `RevisionRequested`, `MilestoneApproved(automatic)` and `ProjectCompleted`.
- Tests: written test-first in `contracts/test/TrustLanceEscrow.review.ts`, 33 of them. The contract now has 89 tests and 100% line coverage.
- Deferred:
  - The "client can't refund straight away" assertion needs `refundOverdueMilestone`, so it moves to ticket 06.
  - "After two revisions only approve, auto-approval or dispute": dispute arrives in ticket 08. Approve and auto-approval are tested.
- Web:
  - `MilestoneRow` shows status, countdowns, revisions left and the latest revision note (read from logs).
  - Approve (with confirmation), revise (with a note) and record auto-approval.
  - `SubmitDeliverable` runs the whole flow: sign the authorization, optionally encrypt, upload, submit the CID. It warns when the file will be public, and always warns that the manifest metadata is public.
  - `DeliverableDownload` asks for the passphrase, then decrypts and checks the hash. The file name is sanitized against bidi and path tricks.
  - `milestoneActions` mirrors the contract's guards and has unit tests.
- Checked live against the local node with the test wallet: revise, approve, the revision-limit state, auto-approval after moving the chain clock, and the Completed state. Submit got as far as the proxy and its `not-configured` answer.
- **Not verified:** a full upload and submit through the UI. It needs a Pinata JWT, like ticket 04's smoke test.
  - **2026-10-28:** the real Pinata path itself (upload, gateway read-back, decryption, hash check) passed in ticket 04's smoke test, which runs from Node and does no on-chain submit. Submitting through `SubmitDeliverable` and downloading through `DeliverableDownload` in the browser are still to be verified, in ticket 12.
  - **2026-10-28, ticket 12:** verified. The end-to-end suite submits and downloads in the browser against the local pinning store on every run, and the opt-in `npm run test:e2e:pinata` did the same against real Pinata (passed twice; see `docs/e2e.md`).
