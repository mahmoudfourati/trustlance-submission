# TrustLance

A decentralized freelance escrow on Ethereum L1: a client locks ETH for a set of milestones, a freelancer delivers against them, and an arbitrator settles disagreements.

## Roles

**Client**:
The account that creates and funds a project and approves its milestones.
_Avoid_: Buyer, employer, owner

**Freelancer**:
The account named by the client to deliver a project's milestones.
_Avoid_: Seller, worker, contractor

**Arbitrator**:
The account allowed to resolve disputes on a project, fixed when the project is created.
_Avoid_: Judge, moderator, mediator

**Admin**:
The account that configures the platform for future projects (default arbitrator, arbitration fee, pausing project creation). It has no power over escrowed funds.
_Avoid_: Owner, operator, platform

## Projects and milestones

**Project**:
One escrow agreement between one client and one freelancer, funded in full at creation and split into milestones.
_Avoid_: Job, contract, deal, gig

**Milestone**:
A fixed-price unit of work within a project, with its own amount and delivery period.
_Avoid_: Task, phase, deliverable

**Acceptance deadline**:
The time after which a freelancer can no longer accept a project.

**Delivery period**:
How long, counted from acceptance, the freelancer has to submit a milestone.
_Avoid_: Due date, ETA

**Overdue milestone**:
A milestone whose delivery period has passed without a submission.

**Submission**:
A freelancer's claim that a milestone is done, carrying a deliverable reference.

**Review window**:
The period after a submission during which the client may request a revision. It ends at the moment auto-approval takes effect.

**Revision request**:
A client sending a submitted milestone back to the freelancer for more work. A milestone can receive at most two.
_Avoid_: Rejection

**Approval**:
The client accepting a submitted milestone, which credits its amount to the freelancer.

**Auto-approval**:
Approval that takes effect because the review window ended without a client decision.

**Forfeit**:
The freelancer giving up every milestone not yet approved, which returns those funds to the client and ends the project.
_Avoid_: Quit, mutual cancellation

## Money

**Escrow**:
ETH held by the contract for milestones that are neither approved nor refunded.

**Withdrawable balance**:
ETH credited to an account that it can pull out of the contract at any time.
_Avoid_: Payout, pending payment

**Refund**:
Moving a milestone's escrow to the client's withdrawable balance.

**Arbitration fee**:
A percentage of frozen funds paid to the arbitrator when, and only when, the arbitrator resolves a dispute.

## Disputes

**Dispute**:
A project-wide freeze, raised by the client or freelancer, that hands every unapproved milestone to the arbitrator.
_Avoid_: Claim, complaint, case

**Frozen funds**:
The escrow of every milestone that is still pending, or submitted with its review window still running, when a dispute is raised. Never includes approved funds or withdrawable balances.

**Resolution**:
The arbitrator's split of frozen funds between client and freelancer, after the arbitration fee.
_Avoid_: Ruling, verdict

**Expired-dispute settlement**:
The fixed fallback split, triggered by either party, when the arbitrator hasn't resolved a dispute within the arbitration period.

**Arbitration period**:
How long the arbitrator has to resolve a dispute before either party can trigger expired-dispute settlement.

## Deliverables

**Deliverable**:
The file a freelancer submits for a milestone, stored on IPFS, never on-chain.

**Deliverable manifest**:
A small IPFS document describing a deliverable (file reference, name, size, hash, encryption details). Its CID is what a submission records on-chain.

**Passphrase encryption**:
Optional in-browser encryption of a deliverable with a passphrase the parties share off-chain.
