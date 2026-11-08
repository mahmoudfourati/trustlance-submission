# Spec: TrustLance decentralized freelance escrow

> Moved from `.scratch/trustlance/spec.md` for the submission. The NatSpec header of `TrustLanceEscrow.sol` still names the old path: the source is kept byte-identical to the version verified on Etherscan, because editing even a comment changes the compiled metadata hash.

**Status:** ready-for-agent

Vocabulary follows `CONTEXT.md`. Decisions recorded in `docs/adr/0001`–`0004`.

## Problem Statement

Freelancers and clients who don't know each other have no cheap way to trust each other with money. A freelancer risks delivering and never being paid; a client risks paying up front for work that never arrives. Centralized platforms solve this by holding the money, at the cost of high fees, opaque decisions, and a custodian who can freeze or lose funds. Users want the money held by rules everyone can read, released in stages as work is approved, with a neutral way out when the two sides disagree, and without either side being able to lock the other's money forever.

## Solution

TrustLance is a web app backed by one Ethereum smart contract. A client creates a project with up to 20 milestones, names a freelancer, and sends the full price in test ETH in the same transaction. The freelancer accepts (or declines), then submits each milestone with a deliverable uploaded to IPFS, optionally encrypted with a shared passphrase. The client approves or asks for a revision. If the client stays silent past the review window, the milestone counts as approved. Approved money goes to the freelancer's withdrawable balance, and either party pulls their balance out at any time.

Every way a project can stall has a defined exit: the client can cancel before acceptance, refund overdue milestones, or receive a forfeit from the freelancer, and either side can raise a dispute. A dispute freezes everything not yet approved. The project's arbitrator splits the frozen funds and takes a 1% fee, or, if the arbitrator does nothing for 30 days, a fixed fallback split applies. Every state change emits an event, and the app turns those events into an activity timeline. The app runs on a local Hardhat network for development and on Sepolia for the public demo.

## User Stories

### Wallet and network

1. As any user, I want to connect MetaMask, so that I can act with my Ethereum account.
2. As any user, I want to see my connected address and active network at all times, so that I know who I'm acting as and where.
3. As any user on an unsupported network, I want a clear prompt and a one-click switch to Sepolia (or the local Hardhat network in development), so that I don't send transactions to the wrong chain.
4. As any user, I want the app to react when I switch accounts or networks in MetaMask, so that what I see always matches my wallet.
5. As a visitor without a wallet, I want to browse a project by its link in read-only mode, so that I can check its status before installing MetaMask.
6. As any user, I want a clear message if MetaMask isn't installed, so that I know what to do next.

### Creating and funding

7. As a client, I want to create a project with a title, description, freelancer address and 1–20 milestones, so that the work and payment schedule are agreed up front.
8. As a client, I want to give each milestone a title, an ETH amount and a delivery period, so that each payment is tied to a clear piece of work.
9. As a client, I want to set an acceptance deadline, so that my money isn't tied up waiting for a freelancer who never responds.
10. As a client, I want to set the review window (default 7 days, 1–30 days), so that I have agreed time to check each submission.
11. As a client, I want the project funded in full in the same transaction that creates it, so that the freelancer can see the money is really there.
12. As a client, I want to see the arbitrator and arbitration fee that will apply before I sign, so that I know who settles disputes and what it costs.
13. As a client, I want the form to reject invalid input (my own address as freelancer, zero amounts, too many milestones, deadlines in the past) before I sign, so that I don't waste gas on a reverted transaction.
14. As a client, I want the contract to reject a payment that doesn't exactly equal the milestone total, so that no money is over- or under-escrowed.

### Acceptance and pre-acceptance exits

15. As a freelancer, I want to see projects that name me and are waiting for my answer, so that I can respond to offers.
16. As a freelancer, I want to accept a project before its acceptance deadline, so that my delivery periods start.
17. As a freelancer, I want to decline a project, so that the client gets their money back straight away.
18. As a client, I want to cancel a project any time before it is accepted, so that I can get my money back if plans change.
19. As a client, I want the project to become unacceptable after the acceptance deadline, so that I can always get a refund from an unanswered offer.

### Delivery and review

20. As a freelancer, I want to upload a deliverable file and submit a milestone in one flow, so that the client can review my work.
21. As a freelancer, I want to optionally encrypt the deliverable with a passphrase before it leaves my browser, so that only the client (who gets the passphrase from me) can read it.
22. As a freelancer, I want a clear warning when my deliverable will be public, so that I don't leak confidential work by accident.
23. As a freelancer, I want to submit milestones in any order, so that I'm not blocked by one slow piece of work.
24. As a client, I want to download a submitted deliverable and decrypt it with the passphrase, so that I can review it.
25. As a client, I want to see whether the file I downloaded matches the hash the freelancer committed to, so that I know it wasn't swapped.
26. As a client, I want to approve a submitted milestone, so that the freelancer is paid for it.
27. As a client, I want to request a revision with a note inside the review window, so that the freelancer can fix problems before I pay.
28. As a freelancer, I want a revision request to give me at least one more review window of delivery time, so that the client can't send work back and then refund it as overdue.
29. As a freelancer, I want to resubmit a milestone after a revision request, so that I can get it approved.
30. As a freelancer, I want the client limited to 2 revision requests per milestone, after which they can only approve, let it auto-approve, or dispute, so that revisions can't delay payment forever.
31. As a client, I want to see how many revision requests I have left on each milestone, so that I know when my next decision is final.
32. As a freelancer, I want a milestone submitted at time T to become approved at exactly T + review window if the client hasn't decided, so that a silent client can't hold my earned money.
33. As anyone, I want to record an auto-approval once its review window has ended, so that the freelancer's balance updates.
34. As a client or freelancer, I want the project to become Completed automatically once every milestone is approved or refunded, so that the status is never ambiguous.

### Overdue work and forfeit

35. As a client, I want to refund a milestone whose delivery period has passed with no submission, so that a disappearing freelancer doesn't lock my money.
36. As a freelancer, I want to still submit a late milestone as long as the client hasn't refunded it, so that late work can still be paid.
37. As a freelancer, I want to forfeit the rest of a project, so that I can leave a project I can't finish and return the client's unearned money.
38. As a freelancer who forfeits, I want milestones whose review window has already ended to stay mine, so that leaving doesn't cost me money I've already earned.

### Balances and withdrawals

39. As a freelancer, I want to see my withdrawable balance across all projects, so that I know what I can withdraw.
40. As a client, I want to see refunds credited to my withdrawable balance, so that I know what I can withdraw.
41. As any account with a balance, I want to withdraw it in one transaction, even while one of my projects is in dispute, so that I receive my ETH.
42. As any account, I want a second withdrawal (or a re-entrant call) to send nothing, so that money can never be paid twice.
43. As an arbitrator, I want arbitration fees credited to my withdrawable balance, so that I'm paid for resolutions.
44. As a client, I want to see per project how much is escrowed, approved, refunded and frozen, so that I understand where my money is.

### Disputes

45. As a client or freelancer on an active project, I want to raise a dispute with a reason, so that a neutral party settles a disagreement.
46. As a disputing party, I want milestones whose review window had already ended to be credited to the freelancer, not frozen, so that a dispute can't claw back earned money.
47. As a client or freelancer, I want all milestone actions blocked while a dispute is open, so that nobody changes the facts under the arbitrator.
48. As an arbitrator, I want a list of disputes assigned to me, with frozen amounts, deadlines and the evidence (deliverables, reason, timeline), so that I can decide fairly.
49. As an arbitrator, I want to choose how much of the frozen funds (after my fee) goes to the freelancer, with the rest to the client, so that I can settle any outcome.
50. As a client or freelancer, I want the arbitrator's fee to be at most the fee rate copied into the project at creation, so that I can't be overcharged.
51. As a client or freelancer, I want a dispute to be settled only once, so that frozen funds can never be paid out twice.
52. As a client or freelancer, I want to trigger expired-dispute settlement from 30 days after the dispute was raised, so that a missing arbitrator can't lock funds forever.
53. As a client, I want expired-dispute settlement to refund milestones that were never submitted, so that I don't pay for undelivered work.
54. As a freelancer, I want expired-dispute settlement to give me half of the submitted-but-unapproved milestones, so that delivered work isn't worth nothing when the arbitrator vanishes.
55. As a client or freelancer, I want approved milestones, and every balance already credited to anyone, never affected by a dispute or its settlement, so that settled money stays settled.
56. As an arbitrator, I want my power to resolve to end at the exact second expired-dispute settlement becomes possible, so that resolution and fallback can never both be valid.
57. As a party to another project, I want a dispute on one project to have no effect on mine, even when we share the same people or arbitrator, so that my funds are isolated.

### Admin

58. As the admin, I want to set the default arbitrator for new projects, so that disputes have a responsible party.
59. As the admin, I want to set the arbitration fee for new projects, capped at 10%, so that the fee can be configured without being abusive.
60. As the admin, I want to pause creation of new projects, so that I can stop new exposure if a bug is found, without blocking any existing project or withdrawal.
61. As the admin, I want admin transfer to need the new admin to accept, so that a typo can't lose admin control.
62. As a client or freelancer, I want to be sure the admin can't move escrowed funds or change existing projects, so that I only have to trust the arbitrator I agreed to.

### Dashboards, timeline and transactions

63. As a client, I want a dashboard of projects I created, grouped by status, so that I can see what needs my attention.
64. As a freelancer, I want a dashboard of projects that name me, grouped by status, so that I can see offers, work in progress and payments.
65. As any user, I want each project page to show status, milestone progress, deadlines, countdowns and revisions left, so that I know what happens next and when.
66. As any user, I want the actions I'm allowed to take to be the only ones shown, with disabled actions explained, so that I don't send transactions that will revert.
67. As any user, I want an activity timeline built from on-chain events, with timestamps and transaction links, so that the project history can be checked independently.
68. As any user, I want every transaction to show pending, confirmed and failed states, with the revert reason decoded into plain language, so that I know what happened.
69. As any user, I want the app to update after my transaction confirms, without a manual reload, so that what I see is current.
70. As any user, I want the layout to work on a phone, so that I can approve or check work anywhere.
71. As any user, I want IPFS fetch failures to show a retry and alternative gateways, so that a slow gateway isn't mistaken for missing work.

## Implementation Decisions

### Architecture

- Three deployable units in one npm-workspaces repository:
  1. **Contracts workspace**: Hardhat 3 project holding the single `TrustLanceEscrow` contract (Solidity, OpenZeppelin 5), its tests and an Ignition deployment module.
  2. **Web workspace**: React + Vite + TypeScript + Tailwind single-page app, talking to the chain through ethers v6 (`BrowserProvider` over MetaMask for writes, a read-only `JsonRpcProvider` when no wallet is connected).
  3. **Upload proxy**: one serverless function deployed with the web app (default host: Vercel). It is the only server-side code (ADR 0004).
- No database, indexer or subgraph. The frontend reads contract state through view functions and builds the timeline from event logs filtered by indexed project id, starting at the deployment block.
- ABI and deployed addresses (per chain id) are exported from the contracts workspace into the web workspace by a script after deployment, so the frontend never hand-copies an ABI.
- Library versions checked on 2026-10-25 (re-check the docs when installing): hardhat 3.21, hardhat-toolbox-mocha-ethers 4.0, hardhat-ignition 3.1, @openzeppelin/contracts 5.6, ethers 6.17, react 19.3, vite 8.3, tailwindcss 4.3, @playwright/test 1.64, pinata SDK 2.5. TypeScript 7.0 was just released; use the newest 5.x/6.x line if any tool in the chain doesn't yet support 7. Node 24 is installed locally (Hardhat 3 needs Node 22+).

### Contract module: `TrustLanceEscrow`

One contract, non-upgradeable, with `Ownable2Step` (admin), `ReentrancyGuard` and `Pausable` (pausing affects project creation only). It has no `receive`/`fallback`, so plain ETH transfers revert.

**Platform configuration (admin):** `defaultArbitrator`, `arbitrationFeeBps` (default 100 = 1%, max 1000), `paused`. The constructor sets all three. The setters affect future projects only.

**Project record:** client, freelancer, arbitrator (snapshot), feeBps (snapshot), status, createdAt, acceptanceDeadline, acceptedAt, reviewWindow, milestoneCount, running totals (`pendingAmount`, `submittedAmount`, `approvedAmount`, `refundedAmount`), and dispute data (raisedBy, raisedAt, frozenAmount, frozenSubmittedAmount, frozenPendingAmount). Title, description and milestone titles go in event data only, not storage.

**Milestone record:** amount, deliveryPeriod, deliveryDeadline (set at acceptance, may be extended by a revision request), status, submittedAt, reviewDeadline, revisionCount, deliverable manifest CID.

**Bounds:** 1–20 milestones; each amount > 0; deliveryPeriod from 1 hour to 365 days; reviewWindow from 1 day to 30 days; acceptanceDeadline > now and ≤ now + 90 days; CID 1–100 bytes; project and milestone titles 1–100 bytes (empty titles are rejected), description and notes ≤ 1000 bytes. Client, freelancer and arbitrator must be three different non-zero addresses. Constants: arbitration period 30 days, `MAX_REVISIONS` = 2 per milestone. A milestone total that would overflow `uint256` reverts with `MilestoneTotalOverflow(index)` instead of a panic. The contract exposes an immutable `deploymentBlock` so log scans start at deployment, not genesis.

**Time rule (half-open windows):** every deadline D is the first second at which its expiry takes effect. An action that belongs to the window needs `block.timestamp < D`; an action that belongs to expiry needs `block.timestamp >= D`. At every timestamp exactly one side is valid, with no overlap and no gap. A milestone submitted at T with a 7-day review window is therefore eligible for auto-approval at exactly T + 7 days, and the client's last second to request a revision is T + 7 days − 1. Post-merge Ethereum timestamps advance in 12-second slots and a block proposer can't pick them freely, so the boundary second is reliable to within one slot. The UI shows deadlines as "until <D − 1s>" or "from <D>" to match.

#### Project state machine

| From | Action (caller) | Guard | To |
|---|---|---|---|
| — | `createProject` (client) | not paused; bounds valid; `msg.value == Σ amounts` | Open |
| Open | `acceptProject` (freelancer) | now < acceptanceDeadline | Active (delivery deadlines = now + deliveryPeriod) |
| Open | `declineProject` (freelancer) | — | Cancelled (refund all to client) |
| Open | `cancelProject` (client) | any time before acceptance, including after the deadline | Cancelled (refund all to client) |
| Active | milestone actions (see below) | — | Active, or Completed when no milestone is Pending or Submitted |
| Active | `forfeit` (freelancer) | — | Completed after crediting expired reviews to the freelancer and refunding every other Pending/Submitted milestone |
| Active | `raiseDispute(reason)` (client or freelancer) | at least one milestone left to freeze after crediting expired reviews, otherwise revert `NothingToDispute` | Disputed (expired reviews credited to freelancer first) |
| Disputed | `resolveDispute(freelancerShare)` (project arbitrator) | now < arbitrationDeadline (= raisedAt + 30 days); share ≤ frozen − fee | Resolved |
| Disputed | `settleExpiredDispute` (client or freelancer) | now ≥ arbitrationDeadline | Resolved |

Completed, Cancelled and Resolved are terminal: every state-changing function reverts on a terminal project.

**Resolution vs expired settlement can't race.** At any timestamp exactly one of the two guards holds (half-open rule), and two transactions in the same block see the same timestamp. Both require status Disputed and set status Resolved before crediting anything, so a second settlement call in the same or a later block reverts with `NotDisputed`. Both read only the project's own frozen amounts and credit only that project's client, freelancer and (for resolution) arbitrator. The credits sum to exactly `frozenAmount`, and `totalEscrow` drops by exactly `frozenAmount`. No other project's record is read or written.

#### Milestone state machine (project must be Active)

| From | Action (caller) | Guard | To |
|---|---|---|---|
| Pending | `submitMilestone(cid)` (freelancer) | valid CID (late submission allowed while still Pending) | Submitted (reviewDeadline = now + reviewWindow) |
| Submitted | `approveMilestone` (client) | — | Approved (credit freelancer) |
| Submitted | `requestRevision(note)` (client) | now < reviewDeadline; revisionCount < `MAX_REVISIONS` | Pending (revisionCount += 1; deliveryDeadline = max(deliveryDeadline, now + reviewWindow)) |
| Submitted | `finalizeAutoApproval` (anyone) | now ≥ reviewDeadline | Approved (credit freelancer) |
| Pending | `refundOverdueMilestone` (client) | now ≥ deliveryDeadline | Refunded (credit client) |

Approved and Refunded are terminal per milestone. During a dispute milestones keep their status (Pending/Submitted) but every milestone action reverts. When a dispute settles, all frozen milestones become Resolved together.

**Revision limit.** `revisionCount` only ever goes up and is never reset by resubmission, by a new submission or by anything else. `requestRevision` is the only path from Submitted back to Pending: the freelancer can't withdraw a submission, and no other function resets a milestone. After the second revision request, the client's only options on the next submission are approve, auto-approval at the deadline, or a dispute (raised before the deadline).

**Auto-approval vs dispute.** A dispute raised at `now < reviewDeadline` freezes that Submitted milestone, so it is never auto-approved. A dispute raised at `now ≥ reviewDeadline` first credits that milestone to the freelancer (ADR 0003) and freezes only what's left. `forfeit` applies the same rule.

**Bounded payment time.** Without a dispute, a milestone the freelancer submits on time is approved, auto-approved or refunded no later than D₀ + 5R, where D₀ is the original delivery deadline and R the review window. The worst case is when the freelancer submits just before each deadline and the client revises in the last second of each review window: each revision then sets the deadline to about submission + 2R, so it moves by at most 2R. Two revisions give at most D₀ + 4R, and the last submission auto-approves R later. With the maximum R of 30 days, that's 150 days past D₀; with the default R of 7 days, 35 days. Every extra delay comes from the freelancer submitting late, and the client can end that with an overdue refund. At any moment of an Active project either party can raise a dispute, which ends within 30 days.

#### Accounting rules

- Payouts only credit `withdrawable[account]` and `totalWithdrawable` (ADR 0001). `withdraw()` is `nonReentrant` and follows checks-effects-interactions: read the balance, require it > 0, zero it, lower `totalWithdrawable`, then send with a low-level call and revert on failure. A failed send rolls back the whole transaction, so the balance stays intact for a retry.
- `totalEscrow` goes up by `msg.value` at creation and down by exactly each milestone amount when that milestone leaves escrow.
- **Pre-acceptance exits** (`declineProject`, `cancelProject`): every milestone becomes Refunded with one `MilestoneRefunded` each, the project becomes Cancelled, and the whole escrow is credited to the client in one `BalanceCredited` with reason `Refund`.
- **Resolution:** fee = ⌊frozen × feeBps / 10 000⌋ → arbitrator; freelancerShare → freelancer; frozen − fee − freelancerShare → client.
- **Expired-dispute settlement:** frozenPendingAmount → client; ⌊frozenSubmittedAmount / 2⌋ → freelancer; the rest of frozenSubmittedAmount → client; no fee.
- **What a dispute can touch:** only that project's frozen amount (its Pending and Submitted milestones when the dispute is raised, after expired reviews are credited). Approved milestones, earlier refunds, and every `withdrawable` balance are out of reach. Dispute functions only ever add to balances, and `withdraw` stays available to everyone while any dispute is open. Balances are one per account across all projects, so the tests check that a dispute on one project leaves another project shared by the same accounts unchanged.
- Events: `ProjectCreated`, `MilestoneDefined`, `ProjectAccepted`, `ProjectDeclined`, `ProjectCancelled`, `MilestoneSubmitted`, `RevisionRequested`, `MilestoneApproved(auto flag)`, `MilestoneRefunded`, `ProjectForfeited`, `ProjectCompleted`, `DisputeRaised`, `DisputeResolved`, `ExpiredDisputeSettled`, `BalanceCredited(account, projectId, amount, reason)`, `Withdrawn`, plus admin configuration events. Each event indexes the project id and the relevant accounts.

#### Security invariants (to be asserted by tests)

1. `address(this).balance ≥ totalEscrow + totalWithdrawable` after any sequence of calls (≥ because ETH can be forced in).
2. For every project, `Σ milestone amounts = pendingAmount + submittedAmount + approvedAmount + refundedAmount + settled dispute payouts + fee`, and escrow is 0 once the project is terminal. While Disputed, the frozen milestones are still counted in `pendingAmount`/`submittedAmount`; once Resolved those are 0 and `frozenAmount` equals the settled payouts plus the fee.
3. Each milestone's amount leaves escrow exactly once.
4. An Approved milestone is never refunded, frozen or reassigned. Neither a dispute nor a forfeit can lower a freelancer's credited total.
5. A dispute pays out exactly once: resolution and expired settlement exclude each other, and both need status Disputed.
6. Arbitration fee ≤ ⌊frozen × projectFeeBps / 10 000⌋ and is charged only by `resolveDispute`.
7. Only the client, freelancer or project arbitrator can make the transitions listed for them. The admin can't call any function that moves project funds.
8. No state-changing function loops over a growing collection. Loops only run over one project's milestones (≤ 20).
9. Every non-terminal project has an exit no single party can block forever: Open → client cancel; Active → overdue refund, auto-approval, forfeit or dispute; Disputed → resolution or expired settlement.
10. `withdrawable[account]` decreases only through `withdraw` by that account. Every other function, including all dispute paths, can only increase it.
11. For each milestone, `revisionCount ≤ MAX_REVISIONS` and it never decreases.
12. For every deadline, the window action and the expiry action are never both valid at the same timestamp, and at least one of them is (no gap).
13. Settling one project's dispute changes no other project's record, and changes the global totals by exactly that project's frozen amount.

### Arbitration trust assumptions (to appear in README and UI)

- The arbitrator can give frozen funds to either party in any proportion and can collude with one side. Parties should only fund projects whose arbitrator they accept, which is why the UI shows it before signing.
- The arbitrator cannot touch approved funds, pre-dispute refunds, other projects, or more than the snapshot fee.
- The arbitrator can delay a project by up to 30 days. After that, the fixed fallback applies.
- On Sepolia the admin and arbitrator are demo accounts controlled by the project team. That's acceptable only because only test ETH is used.

### IPFS and the upload proxy

- **Deliverable manifest** (JSON, pinned): schema version, original file name, MIME type, byte size, SHA-256 of the plaintext, file CID, and encryption block (`null`, or algorithm, PBKDF2 salt and iterations, IV). The on-chain submission records the manifest CID.
- **Encryption:** AES-256-GCM through WebCrypto, key from PBKDF2-SHA-256 (≥ 600 000 iterations), random salt and IV per file. The passphrase never leaves the browser and is never stored.
- **Proxy contract:** `POST` with address, project id, milestone index, an expiry and a signature over a fixed-format message. The proxy checks the signature is recent (≤ 5 min) and on-chain that the signer is the freelancer, the project is Active and the milestone is Pending. It then returns a Pinata signed upload URL (≤ 60 s lifetime, ≤ 50 MB). It holds the Pinata key in an environment variable, stores no files, and rate-limits per address on a best-effort basis.
- **Retrieval:** fetch from the configured Pinata gateway, falling back to public gateways. Verify the SHA-256 after decryption. Show distinct states for not found, timed out, wrong passphrase and hash mismatch.
- **As built (ticket 12):** a Playwright suite (`web/e2e/`, `docs/e2e.md`) drives the app in Chrome against a fresh local node with the dev-only test wallet and a local pinning store behind the real upload proxy, and checks every amount, status and event on-chain, including D − 1 / D for review, delivery and arbitration. The arbitrator preview equals the credited amounts to the wei. The project page is read-only when the wallet is on an unsupported network (fix found by the suite). Approval stays valid after the review deadline as built in ticket 05. The contract is unchanged.
- **As built (ticket 11):** the contract is unchanged. Its security evidence is in `docs/security.md`. The Solidity suites in `contracts/test/solidity/` are: adversarial tests with attacker contracts; a stateful invariant suite whose handler predicts every call from these state tables and asserts invariants 1–13; stateless fuzz tests for the dispute splits and the D − 1 / D races; and a 16-bug mutation check. Invariant 12 is read per deadline: review (revision vs auto-approval) and arbitration (resolution vs expired settlement) are exclusive and gap-free. Acceptance has only a window action, because cancel is always valid while Open. Delivery deliberately has an overlap from D, where late submission and overdue refund race and the first mined wins (Known edge cases). Test profiles `default` (fuzz 256, invariants 64 × 200) and `deep` (fuzz 10 000, invariants 1 000 × 500) raise the test gas limit to 50 M for the invariant setUp. Accepted risks: forced ETH stays locked; `resolveDispute` reverts if `frozen × feeBps` overflows (above about 10⁷⁴ wei), while expired settlement still works.
- **As built (ticket 10):** the dispute UI computes every amount in integer wei with the contract's formulas (`web/src/lib/disputes.ts`): the raise preview credits submissions whose review window has ended and freezes the rest; the resolution preview takes `fee = ⌊frozen × feeBps / 10 000⌋` and caps the freelancer's share at `frozen − fee`; the expired-dispute settlement preview halves the frozen submissions with the odd wei to the client. Amounts in the dispute panel are shown to the wei. The arbitrator console is `/arbitration`, built from `projectIdsAsArbitrator` with each dispute's reason from `DisputeRaised`; the evidence (deliverables and timeline) is on the project page it links to. The trust-assumptions note is in the UI (create project, dispute panel, console); the README copy comes with the README in ticket 13. Deadline states use the browser clock, like the rest of the UI; the contract decides with the block timestamp.
- **As built (ticket 09):** `settleExpiredDispute(projectId)`, client or freelancer only, from `raisedAt + 30 days`; otherwise `ArbitrationPeriodOpen(deadline)`. It credits `⌊frozenSubmittedAmount / 2⌋` to the freelancer and `frozenPendingAmount + (frozenSubmittedAmount − ⌊frozenSubmittedAmount / 2⌋)` to the client in one credit, both with reason `DisputeSettlement`, skipping zero amounts, then emits `ExpiredDisputeSettled(projectId, settledBy, freelancerAmount, clientAmount)`. Pausing doesn't block it.
- **As built (ticket 08):** `raiseDispute(projectId, reason)` (reason 1–1000 bytes, event only) and `resolveDispute(projectId, freelancerShare)`. Errors: `NotProjectParty`, `NotArbitrator`, `InvalidReason`, `NothingToDispute`, `NotDisputed`, `ArbitrationPeriodEnded(deadline)`, `ShareTooLarge(share, max)`. Events: `DisputeRaised(projectId, raisedBy, arbitrator, frozenAmount, arbitrationDeadline, reason)`, emitted after the credits for expired reviews, and `DisputeResolved(projectId, arbitrator, freelancerAmount, clientAmount, fee)`, emitted after the credits; zero credits are skipped. `CreditReason` gains `ArbitrationFee` and `DisputeSettlement`. Admin: `setDefaultArbitrator`, `setArbitrationFeeBps`, `pause`/`unpause` (OpenZeppelin `Pausable`, gating `createProject` only), with `DefaultArbitratorChanged` and `ArbitrationFeeChanged` events. The compiler's default profile enables the optimizer (200 runs), as production does, because the unoptimized contract exceeds 24 KB.
- **As built (ticket 07):** the timeline reads one project's logs in two paged scans (`[any, projectId]` and `[BalanceCredited, any, projectId]`) from the deployment block, keeps only decoded events whose `projectId` matches, and orders them by block and log index. `Withdrawn` carries no project id, so it isn't on project timelines. Confirmation thresholds: 1 block locally, 5 on Sepolia. The Sepolia read RPC must keep full log history: publicnode prunes logs older than about 10k blocks, so the default is `sepolia.gateway.tenderly.co`, scanned in 10k-block pages. Dispute events join the timeline in ticket 08.
- **As built (ticket 06):** `refundOverdueMilestone(projectId, index)` reverts with `DeliveryWindowOpen(deliveryDeadline)` before the deadline. `forfeit` emits `ProjectForfeited(projectId, client, freelancer, creditedAmount, refundedAmount)` instead of `ProjectCompleted` (one event per transition), after the per-milestone `MilestoneApproved`/`MilestoneRefunded` events and the credits; the client's refunds share one `BalanceCredited`. A refund that completes the project emits `ProjectCompleted`. The timeline (ticket 07) must treat both `ProjectCompleted` and `ProjectForfeited` as "became Completed".
- **As built (ticket 05):** milestone functions take `(projectId, index)`; `submitMilestone` stores the manifest CID in the milestone record and `requestRevision`'s note lives only in the `RevisionRequested` event. `finalizeAutoApproval` is callable by anyone, including the client, and the UI offers only it once a review window has ended. The client can still call `approveMilestone` after the deadline (recorded with `automatic = false`). Errors: `ProjectNotActive`, `UnknownMilestone`, `MilestoneNotPending`, `MilestoneNotSubmitted`, `InvalidCid`, `NoteTooLong`, `ReviewWindowClosed`, `ReviewWindowOpen`, `RevisionLimitReached`. Deliverable file names from manifests are stripped of control and bidi characters before display or download.
- **As built (ticket 04):** the proxy returns two signed URLs per request, one for the file (≤ 50 MB) and one for the manifest (≤ 16 KB, JSON only), both valid 60 s, because Pinata doesn't document whether a signed URL can be reused. The signed message binds chain id, escrow address, project, milestone index, account and expiry (`web/src/lib/uploadMessage.ts`). Manifests must use 600 000 to 2 000 000 PBKDF2 iterations, and the encryption block adds a `keyCheck` (hex, from the second half of a 512-bit PBKDF2 output) so a wrong passphrase is told apart from altered ciphertext. The browser signs a 2-minute expiry; the proxy accepts up to 5 minutes. A gateway that serves bytes failing the hash check is skipped and the next one tried; reads are capped at the expected size. Details and error codes: `docs/upload-proxy.md`.

### Frontend

- Pages: landing/connect; client dashboard; freelancer dashboard; arbitrator console (disputes assigned to the connected account); create project; project detail (summary, money breakdown, milestones with actions, deliverables, dispute panel, timeline); balances & withdraw.
- Dashboards come from the role-specific views `projectIdsAsClient`, `projectIdsAsFreelancer` and `projectIdsAsArbitrator` (append-only arrays, written at creation, never looped in a write path). Details come from per-project views. The timeline comes from logs.
- A single transaction helper handles send → pending → confirmed/failed, decodes custom errors into messages, and refreshes the affected queries.
- Dev-only test wallet: in `vite --mode testwallet` (dev builds only), an injected provider forwards requests to the local Hardhat node's unlocked accounts so flows can be driven without MetaMask. It is never included in a production build.
- Network gating: supported chain ids are 31337 (local) and 11155111 (Sepolia). Anything else shows a switch prompt.
- Visual style: clean SaaS dashboard, responsive down to 360 px, light and dark themes.

### Deployment and secrets

- Ignition module deploys `TrustLanceEscrow` with constructor arguments (admin, default arbitrator, fee bps). It is verified on Etherscan with hardhat-verify.
- The Sepolia RPC URL, deployer key and Etherscan key are stored with Hardhat's keystore / configuration variables. The Pinata JWT lives only in the proxy host's environment. `.env*` files and keystores are git-ignored, and committed `*.example` files show the expected names.

## Testing Decisions

- **Good tests** drive the system only through its public surface (contract external functions and events, the proxy's HTTP endpoint, and the browser UI) and assert observable results: balances, statuses, events, reverts, rendered state. They never read private storage or mock the contract.
- **Seam 1, contract (primary):** TypeScript mocha + ethers tests on Hardhat's in-process network, with time travel from network helpers. Every state-machine row gets a happy-path test and tests for each failed guard: wrong caller, wrong state, bound violations, wrong `msg.value`, and every deadline tested at D − 1 (window action succeeds, expiry action reverts) and at exactly D (the reverse). Required scenarios:
  - third revision request reverts; submit → revise → resubmit → revise → resubmit then only approve, auto-approval or dispute work; the revision count survives resubmission;
  - payment-time bound: with a client revising at the last second each time, the milestone is auto-approvable no later than D₀ + 5R;
  - dispute at reviewDeadline − 1 freezes the milestone; dispute at reviewDeadline credits it first;
  - freelancer balances from earlier approvals, on this and other projects, are unchanged and withdrawable during and after a dispute;
  - two disputed projects sharing the same client, freelancer and arbitrator: settling one leaves the other's record, frozen amount and the parties' other credits unchanged;
  - resolve and settle-expired submitted in the same block at D − 1 and at D: exactly one succeeds, and a second settlement of either kind reverts.
- **Contract adversarial and invariant tests:** Malicious-actor tests use attacker contracts: a re-entrant withdrawer, a receiver that reverts, a contract client or freelancer, and a forced-ETH sender. Invariants 1–13 are checked by Solidity fuzz/invariant tests (Hardhat 3's built-in Solidity test runner) with a handler that randomizes action sequences across several projects. Arbitration accounting gets a table-driven test of fee rounding, 0% / 100% shares, odd-wei splits and fallback splits before any dispute UI is built.
- **Seam 2, upload proxy:** handler tests with the Pinata client and chain reader injected. They cover a bad signature, an expired message, a non-freelancer, a non-Active project and a non-Pending milestone. One manual smoke test against real Pinata.
- **Seam 3, end-to-end:** Playwright against a local Hardhat node with the deployed contract. A test-only EIP-1193 provider is injected and forwards to the node's unlocked accounts, so the chain and data are real and only the MetaMask popup is skipped. Covers the full happy path, revision, overdue refund, dispute resolution and expired settlement. Before the demo, a short manual MetaMask checklist on Sepolia covers the real wallet.
- Commands for compile, test, coverage and e2e must pass before any ticket is marked done. Test results are reported only from real runs.
- There is no prior art in the repo yet; ticket 01 sets up the patterns.

## Out of Scope

- Layer 2s, bridges, ERC-20 payments, tokens or NFTs of any kind, and mainnet deployment.
- Open job marketplace, bidding or freelancer discovery: the client names the freelancer.
- Changing a project after creation (adding milestones, topping up, changing amounts or freelancer).
- Partial approvals of a milestone, tips, or price renegotiation.
- Withdrawing a raised dispute, multi-arbitrator panels, appeals, or arbitrator reputation.
- In-app messaging. Passphrase exchange and discussion happen off-chain.
- Indexer/subgraph, user accounts, email notifications.
- Contract upgradeability.

## Further Notes

- **Known edge cases to keep visible:**
  - Overdue refund vs late submission is a race: whichever transaction is mined first wins. This is accepted and explained in the UI.
  - A client gets at most 2 revision requests per milestone. Each gives the freelancer at least one more review window, and the freelancer can dispute at any time.
  - A client who disagrees with a third submission must dispute before its review deadline. Doing nothing means auto-approval.
  - The freelancer can raise a dispute while some milestones are still being worked on. That freezes the whole project. This is accepted per ADR 0002.
  - If MetaMask is pointed at a reorg-prone network, the timeline may briefly show events that later disappear. On Sepolia, wait for confirmations before showing an event as final.
- A contract client or freelancer that can't receive ETH can still never block anyone else, because each party withdraws separately.
- Gas: titles and descriptions are emitted, not stored. The milestone cap keeps the dispute and forfeit loops cheap.
