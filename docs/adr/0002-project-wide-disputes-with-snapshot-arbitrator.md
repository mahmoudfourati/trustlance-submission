# Project-wide disputes, a per-project arbitrator snapshot and a timeout fallback

A dispute freezes every milestone of the project that isn't yet approved, and the project ends when the dispute is settled. Approved milestones, earlier refunds and every account's withdrawable balance (from this or any other project) are never frozen, debited or redistributed. Withdrawals keep working during disputes. The arbitrator address and the arbitration fee are copied into the project at creation, so the admin changing either only affects future projects.

The arbitrator can resolve until one second before the arbitration deadline (raisedAt + 30 days). From the deadline itself, either party can trigger expired-dispute settlement instead: pending milestones are refunded to the client, the total of submitted milestones is split 50/50 (odd wei to the client), and no fee is charged. The two windows don't overlap. Both paths need status Disputed and set it to Resolved before crediting, so a dispute pays out exactly once and touches no other project.

## Considered Options

- **Per-milestone disputes**: keeps undisputed milestones moving, but needs per-milestone dispute state, fees and deadlines, multiplying the transitions to test. In practice a disputed relationship rarely continues.
- **Global arbitrator role checked at resolution time**: simpler, but the admin could swap the arbitrator mid-dispute.
- **Other timeout fallbacks** (all to client, flat 50/50): rejected because "all to client" rewards a client who disputes just to stall, and a flat split ignores whether work was ever delivered.

## Consequences

- The arbitrator is trusted with frozen funds: it can give any split of them (after the fee) to either party, including colluding with one side. It cannot touch approved funds, other projects, or more than the fee for itself.
- A raised dispute cannot be withdrawn; a party that wants out must wait for resolution or the fallback.
