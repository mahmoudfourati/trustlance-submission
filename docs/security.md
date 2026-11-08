# Contract security: tests, review and residual risks

How `TrustLanceEscrow` is tested against attackers, what the fuzz and invariant campaigns check, what a whole-contract review found, and which risks are accepted. Ticket 11. Passing tests and fuzz campaigns are evidence, not a formal proof: they show that no counterexample was found in the inputs that were tried.

## Running the suites

From `contracts/`:

- `npx hardhat test solidity`: adversarial, fuzz and invariant suites with the `default` profile, which `npm test` and `npm run check` also run. Fuzz: 256 runs per test. Invariants: 64 runs × depth 200 per invariant. Seed `0x7472757374`, so runs are reproducible. Takes about 30 s.
- `npm run test:deep`: the same suites with the `deep` profile. Fuzz: 10 000 runs per test. Invariants: 1 000 runs × depth 500 per invariant. On 2026-10-26 all 24 tests passed in 1 061 s, which is 2 million handler calls and 50 000 fuzz cases.
- `npm run test:coverage` (from the repo root): every contract test with coverage. Run `npx hardhat build --force` afterwards, so later runs don't use instrumented artifacts.

Both profiles raise the test `gasLimit` to 50 M. The invariant `setUp` deploys the escrow and the fuzz handler in one call, which is more than the default allows. This doesn't hide expensive escrow calls: `test_LoopsOnTwentyMilestonesStayCheap` and `test_GasDoesNotGrowWithProjectsOrUsers` bound them separately.

## What the suites cover

All three files are in `contracts/test/solidity/`.

### Adversarial tests (`TrustLanceEscrow.adversarial.t.sol`, 15 tests)

The attackers are `AttackerParty` (in `Attackers.sol`), a contract that plays client, freelancer or arbitrator and, when it receives ETH, accepts it, reverts, burns all gas or re-enters the escrow with any calldata, plus `ForceSender`, which forces ETH in with `selfdestruct`.

- **Re-entrancy.** An attacker re-enters from inside its own `withdraw`, through every path that credits a balance:
  - client paths: cancel, approve, overdue refund, raise dispute (crediting an expired review) and expired settlement;
  - freelancer paths: decline, auto-approval and forfeit;
  - arbitrator path: resolution;
  - and `withdraw` itself, which reverts with `ReentrancyGuardReentrantCall`.
  
  Every re-entrant call is an ordinary call. The attacker is paid exactly its balance once, and anything credited during the call stays withdrawable.
- **Hostile recipients.** With client, freelancer and arbitrator all rejecting ETH, every crediting path still succeeds. Each party's own withdrawal fails with `WithdrawalFailed` and keeps its balance, and once the party accepts ETH it can withdraw. A gas-burning recipient only fails its own withdrawal.
- **ETH that arrives without a call.** Forced ETH changes no account and can't be withdrawn. Plain transfers and unknown calldata are rejected.
- **Repeats and roles.** Every one-shot action reverts the second time. Every restricted function rejects every other account, including the admin on project functions and every party on admin functions. Admin changes leave existing projects untouched.
- **Isolation and gas.**
  - Two disputed projects with the same client, freelancer and arbitrator: settling one changes nothing in the other, and the totals move by exactly the frozen amount.
  - The loops on a 20-milestone project stay under 250 k gas: raiseDispute 90 077, resolveDispute 101 661, forfeit crediting 20 expired reviews 220 193.
  - Creating, approving, disputing and withdrawing cost no more after 50 more projects for the same parties and 50 more clients.

### Stateful invariant suite (`TrustLanceEscrow.invariant.t.sol` with `EscrowHandler.sol`)

The fuzzer calls random sequences of handler steps.

- **Projects and accounts.** Up to 24 projects per run (at most 4 live at once), between four accounts that act as both clients and freelancers, two arbitrators, the admin and an outsider.
- **Lifecycle steps.**
  - Every escrow function, mostly called by the authorized account and sometimes by any other account, sometimes with an invalid milestone index.
  - `createProject` sometimes breaks one creation bound or sends the wrong amount.
  - Resolution tries shares of 0, the maximum, one wei more, or random.
- **Environment steps.** Time jumps (random, or exactly D − 1, D or D + 1 of a live acceptance, delivery, review or arbitration deadline), boundary probes, forced ETH, and admin changes (fee, arbitrator, pause) from the admin or anyone else.
- **Withdrawals** by any account at any time, including while disputes are open.

Before each call the handler predicts from the spec's state tables whether the call must succeed, and records a violation if the contract disagrees. After each successful call it checks the per-call rules listed below.

| Spec invariant | Where it is asserted |
| --- | --- |
| 1 Balance covers the accounts | `invariant_1_*`: balance = totalEscrow + totalWithdrawable + forced ETH exactly; deposits − withdrawals = the two totals; per-account balances add up to totalWithdrawable |
| 2 Per-project conservation | `invariant_2_3_*`: amounts by milestone status match the project's totals; once Resolved, the frozen milestones equal `frozenAmount`; terminal projects hold no escrow. The handler checks that resolution and settlement credit exactly `frozenAmount` (payouts + fee) |
| 3 Leaves escrow once | `invariant_2_3_*`: credited per project = total − open; the handler checks that Approved, Refunded and Resolved milestones never change status |
| 4 Approved is final, earnings never drop | Handler: approved totals never fall; forfeit and dispute credit the freelancer exactly the submissions whose review window has ended; a project's parties, fee, windows and amounts never change |
| 5 One payout per dispute | `invariant_5_6_*`: at most one settlement, and only for a Resolved project; `testFuzz_ResolveAndSettleInTheSameBlock` |
| 6 Fee cap, resolution only | Handler: only resolution credits the arbitrator, exactly ⌊frozen × feeBps / 10 000⌋; `invariant_5_6_*` checks the cap; `testFuzz_ResolutionSplitsTheFrozenAmountExactly` |
| 7 Roles; the admin moves no funds | Handler: every call by a wrong account must revert; admin calls change no total, balance or project |
| 8 No loops over growing collections | `test_LoopsOnTwentyMilestonesStayCheap`, `test_GasDoesNotGrowWithProjectsOrUsers` |
| 9 Exits no single party can block | `afterInvariant`, after every run: from the state reached, first the client alone, then the freelancer alone, ends every project; then everyone withdraws and only forced ETH remains |
| 10 Balances fall only through their own `withdraw` | Handler: no other call lowers any balance; a withdrawal pays exactly the caller's balance and touches no other |
| 11 Revisions ≤ 2, never decrease | Handler: count never drops or exceeds 2, and each accepted request adds exactly one |
| 12 Window xor expiry | Handler `probeBoundary` (review and arbitration deadlines, from the same state); `testFuzz_ReviewDeadlineIsHalfOpen`, `testFuzz_ResolveAndSettleInTheSameBlock`, `testFuzz_DeliveryDeadlineRaceHasOneWinner` |
| 13 Settling one dispute touches no other project | Handler: no call changes another project's record, and the totals move by exactly the credited amount |

**Measured activity.** A green campaign proves little if the calls never succeed. With a throwaway probe that isn't committed, eight runs of the default shape (depth 200, different seeds) produced these successful calls / rejected calls:

| Action | Succeeded / rejected | Action | Succeeded / rejected |
| --- | --- | --- | --- |
| createProject | 37 / 42 | forfeit | 7 / 7 |
| acceptProject | 24 / 95 | raiseDispute | 9 / 14 |
| declineProject | 5 / 8 | resolveDispute | 3 / 72 |
| cancelProject | 7 / 11 | settleExpiredDispute | 6 / 61 |
| submitMilestone | 25 / 102 | withdraw | 14 / 79 |
| approveMilestone | 5 / 36 | finalizeAutoApproval | 1 / 73 |
| requestRevision | 6 / 115 | refundOverdueMilestone | 4 / 35 |

The same runs made 21 exact deadline landings and 20 boundary probes, with no violation. Every action succeeds somewhere, and every rejection matched the handler's prediction. Per invariant, the default campaign makes 8 times as many calls as this sample, and the deep one about 300 times as many.

How the handler was tuned:
- An early version was almost vacuous. Shifted seeds were 0 for small fuzz inputs, and a pause or expired offers stalled projects.
- It now draws its choices from hashed seeds and picks a project and milestone in the state an action needs four times out of five.
- Decline, cancel, forfeit and disputes are throttled, so projects live long enough to reach review and arbitration.
- `afterInvariant` asserts that every run created at least one project.

### Stateless fuzz tests (`TrustLanceEscrow.fuzz.t.sol`, 5 tests)

- Resolution split over random amounts, fee rates and shares.
- Expired settlement split.
- Review deadline at D − 1, D and a random time.
- Resolution against settlement in the same block, in both orders.
- Late submission against overdue refund in the same block, in both orders.

### Mutation check

To show the suites detect real bugs, 16 bugs were injected one at a time into `TrustLanceEscrow.sol`, and the Solidity suites ran against each. The contract was restored byte-for-byte afterwards. All 16 are detected:

| Injected bug | Detected by |
| --- | --- |
| Fee rounds up | invariants 5/6 and handler, resolution fuzz, re-entry test |
| Odd wei of the expired split to the freelancer | invariant 1 and handler, settlement fuzz, re-entry test |
| Revision limit off by one (3 allowed) | handler |
| Revision counter never incremented | handler, invariants 5/6 |
| Auto-approval allowed at D − 1 | handler, review-deadline fuzz |
| Revision allowed at D | handler, review-deadline fuzz |
| Acceptance allowed at D | handler |
| Overdue refund allowed at D − 1 | handler, delivery-race fuzz |
| Resolution allowed at the arbitration deadline | handler, same-block fuzz |
| Overdue refund without the client check | handler, role-matrix test |
| Expired settlement callable by anyone | handler, role-matrix test |
| Share cap ignores the fee | resolution fuzz (exact `ShareTooLarge`) |
| Resolution uses the current fee instead of the snapshot | invariants 5/6 and handler |
| `NothingToDispute` check removed | handler |
| Forfeit skips crediting expired reviews | handler, re-entry test |
| `withdraw` sends before updating state, without `nonReentrant` | all five re-entrancy tests |

The first round found two blind spots, both now closed:
- A revision counter that never increments: the handler predicted the limit from the on-chain count.
- A share cap that ignores the fee: its only effect is a different revert reason.

Two more mutants were caught by a single example test only, so they now also have handler or fuzz assertions: the odd wei going to the freelancer, and forfeit skipping expired reviews.

### Coverage

`npm run test:coverage` reports 100% line and 100% statement coverage of `TrustLanceEscrow.sol` (308 of 308 lines) across 164 mocha and 24 Solidity tests. Hardhat 3's coverage doesn't measure branches. They were checked by hand instead:
- Every custom error the contract can revert with is triggered by at least one test, and both sides of every two-sided bound are tested (deadline, window and period limits, empty and too-long strings, 0 and 21 milestones).
- The non-revert branches have explicit tests:
  - the delivery-deadline extension, both when it extends and when it keeps the later deadline (`review.ts`);
  - forfeit with nothing to refund and with nothing to credit (`exits.ts`);
  - zero-amount payouts (0% and 100% shares, fee 0) in the arbitration tables and the fuzz tests.

No branch is known to be uncovered.

## Whole-contract review

| Area | Finding |
| --- | --- |
| External calls | One: the ETH transfer in `withdraw`, which is `nonReentrant` and follows checks-effects-interactions. No other function calls out, so re-entering any of them from a withdrawal is an ordinary call with the state already updated. |
| Integer math | Solidity 0.8 checked arithmetic. Totals are guarded against overflow at creation (`MilestoneTotalOverflow`). Fee = ⌊frozen × feeBps / 10 000⌋ rounds down in the payer's favour, and the remainder goes to the client. Timestamps are `uint64`; adding windows of at most 365 days can't overflow. |
| Loops | Only over one project's milestones (at most 20). Measured gas is at most 220 k, and it doesn't grow with projects or users. |
| State transitions | Each function checks the project status, the milestone status, the caller and the half-open deadline, as in the spec tables. The status is written before any credit, so a dispute can't pay out twice. |
| Access control | Client, freelancer, arbitrator and admin checks on every transition. The admin (`Ownable2Step`) can only change the default arbitrator and fee for future projects and pause creation. |
| Events | One per transition, emitted with the state change. |
| Fees | Snapshotted per project at creation; capped at 10%. Charged only by resolution; expired settlement charges none. |
| Locked ETH | See the residual risks below. |

No vulnerability was found, so the contract is unchanged in this ticket. The two review agents' findings concerned the tests, and were fixed in the tests.

## Residual and accepted risks

- **Forced ETH stays locked.** ETH sent by `selfdestruct` (or as a block reward) isn't owned by any account and can't be withdrawn; there is deliberately no sweep function. It never affects any account (invariant 1 is `≥`).
- **A party that can't receive ETH locks only its own balance.** A contract client, freelancer or arbitrator whose `receive` reverts keeps its balance until it can accept ETH. Nobody else is affected.
- **Arbitrator trust.** The project's arbitrator decides the split of frozen funds, can favour or collude with one party, and can delay a project by up to 30 days. Approved funds, earlier refunds, other projects and anything beyond the snapshot fee are out of its reach (spec, "Arbitration trust assumptions").
- **Admin pause and renounce.** The admin can pause project creation indefinitely or renounce ownership while paused. That stops new projects only: existing projects, disputes and withdrawals keep working.
- **Fee overflow at impossible amounts.** `frozen × feeBps` overflows only above about 10⁷⁴ wei, far beyond all ETH in existence (about 10²⁶ wei). `resolveDispute` would then revert, but expired settlement still works (`test_HugeFrozenAmountStillSettles`).
- **Late submission against overdue refund.** From the delivery deadline on, both are valid and the first transaction mined wins. This is accepted in the spec and shown in the UI.
- **Timestamps.** Deadlines use `block.timestamp`, which a block producer can shift by a few seconds. The windows are hours to days long. The UI shows deadline states from the browser clock, while the contract decides by the block time.
- **Unbounded view arrays.** `projectIdsAs*` grows with every project naming an account, and anyone can create a project naming any freelancer. These are views only, never used in state-changing code, but a heavily spammed account could need a paged read in the UI.

## Limits of this evidence

- Fuzzing samples inputs; it doesn't enumerate them. The handler's amounts, windows and time jumps are bounded so that runs make progress, and very rare interleavings may never be generated.
- The handler's predictions are written from the spec, independently of the contract's code, but by the same team. A shared misreading of the spec would pass. The example-based mocha suite and the mutation check reduce this risk; they don't remove it.
- The adversarial suite covers the attacker shapes listed above, not every possible contract.
- Integration with real services was outside this ticket. Since then:
  - the real Pinata upload and submission (tickets 04–05) passed, both from Node (smoke test) and in the browser (ticket 12, `docs/e2e.md`);
  - the activity timeline on Sepolia (ticket 07) still needs the Sepolia deployment (ticket 13, `docs/deployment.md`).
