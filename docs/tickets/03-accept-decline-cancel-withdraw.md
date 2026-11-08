# 03: Acceptance, pre-acceptance exits and withdrawal

**What to build:** A freelancer sees offers that name them and accepts or declines. A client cancels before acceptance (also after the acceptance deadline). Refunds land in the client's withdrawable balance, and any account withdraws its balance through the pull-payment `withdraw`.

**Blocked by:** 02

**Status:** resolved

- [x] Contract tests for accept (succeeds at acceptanceDeadline − 1, reverts at exactly acceptanceDeadline), decline and cancel; wrong caller and wrong state revert
- [x] Accept sets every delivery deadline from the acceptance time
- [x] Withdraw follows CEI and is nonReentrant. Tests: a re-entrant attacker contract gets paid once; a reverting receiver keeps its balance; a second withdraw reverts; totals stay consistent
- [x] Freelancer dashboard with an offers section; accept/decline/cancel buttons shown only to the right role and state
- [x] Balances page shows the withdrawable balance and withdraws it

## Comments

**2026-10-26, done.** The contract tests were written first: 25 mocha tests in `TrustLanceEscrow.acceptance.ts`. They cover:

- Accept at D − 1 and at D.
- Decline and cancel at D − 1, at D and long after D.
- Every wrong caller and wrong state.
- Double exits.
- Refunding one project leaves other projects shared by the same parties untouched.
- `withdraw` against `EscrowPartyMock`, in two modes: a re-entrant attacker is paid once and its re-entry fails with `ReentrancyGuardReentrantCall`; a reverting receiver keeps its balance and its retry succeeds.

All 56 contract tests pass with 100% line coverage. On the web side, 31 vitest tests pass, including `availableActions`, which mirrors the contract's role and state guards.

The full flow was checked in the browser against a local node with the test wallet:

- Client creates a project (the Ticket 02 flow still works).
- Client cancels a project.
- Freelancer sees offers on the dashboard, then declines one and accepts another; delivery deadlines are shown after acceptance.
- Balance page withdraws 3 ETH, after which the contract holds exactly the remaining escrow.
- The layout fits at 375 px.

Decisions:

- A pre-acceptance exit marks every milestone Refunded and emits `MilestoneRefunded` per milestone, following CONTEXT's "Refund" definition and the one-event-per-transition rule. The spec has been updated.
- `BalanceCredited.reason` is the `CreditReason` enum; it has only `Refund` so far, and later tickets append values.
- Accept/decline/cancel buttons live on the project page. Dashboard offer cards link there.

Deferred: the fuzz/invariant suite (including invariant 10, that balances only decrease through `withdraw`) is ticket 11. The pause guard is ticket 08.
