# 10: Dispute UI and arbitrator console

**What to build:** Clients and freelancers raise a dispute with a reason and see frozen amounts and the arbitration deadline. The arbitrator gets a console listing their disputes with evidence (deliverables, timeline) and resolves them with a split slider that shows the fee and both payouts. After the deadline, either party sees a settle-expired action with the exact payouts.

**Blocked by:** 07, 09

**Status:** ready-for-human

- [x] The UI only offers dispute actions to the right role and state, and shows the trust-assumptions note
- [x] Resolution preview amounts match what the contract credits (checked by an E2E test in 12)

## Comments

**2026-10-26 (agent):** implemented; waiting for an independent review.

- **Logic** (`web/src/lib/disputes.ts`, unit-tested first):
  - previews for raising, resolving and expired-dispute settlement, all in bigint wei with the contract's formulas;
  - the half-open arbitration deadline (`raisedAt + 30 days`);
  - which dispute actions each role may take;
  - share and reason validation;
  - the console's ordering.
- **UI:**
  - **Dispute panel on the project page.**
    - Raise: reason, then a confirmation with exact amounts credited and frozen.
    - Frozen amounts with the pending/submitted breakdown, the deadline state, and the expired-dispute settlement preview.
    - Resolve: a slider plus an exact ETH field, with the fee and both amounts shown to the wei, then a confirmation.
    - Settle expired dispute, with a confirmation.
    - The outcome once Resolved.
  - **Arbitrator console** at `/arbitration`, in sections: awaiting resolution (nearest deadline first), arbitration period ended, settled.
  - **Trust-assumptions note** on project creation, the dispute panel and the console.
  - Frozen milestones say they are frozen; the escrow card and the dashboard show frozen amounts.
- **Who sees which action:**
  - The client and freelancer can raise a dispute on an Active project. It is disabled when nothing is left to freeze.
  - The arbitrator can resolve until `deadline − 1`; it is disabled from `deadline`.
  - The client and freelancer can settle from `deadline`; it is disabled before.
  - The admin and other accounts get a read-only view.
- **Tests:** 148 web tests (23 new), 164 contract tests unchanged; `npm run check` passes.
- **Live checks on the local node** (test wallet, accounts 0–4):
  - **Raise:** the client raised a dispute over 2 ETH + 1 wei submitted and 3 ETH pending.
  - **Resolve:** the arbitrator resolved a 1.50000000000000034 ETH dispute at a 1% fee with an odd share. The fee (0.015000000000000003 ETH) and both amounts matched the contract's credits to the wei. Over-the-maximum and negative shares were blocked in the form.
  - **Stale form:** a resolve sent from a form opened before the deadline but mined after it was rejected on-chain with `ArbitrationPeriodEnded` and a readable message.
  - **Expired settlement:** at D − 1 the UI offers resolve only; at D it offers settlement only. The client settled one project and the freelancer another, each crediting 1 ETH / 4 ETH + 1 wei exactly; the arbitrator's balance was unchanged.
  - **Layout:** no horizontal scroll at 375 px, after a nav wrapping fix.
- **Reviews:** neither review found an amount error. Fixed after review:
  - CONTEXT.md vocabulary ("expired-dispute settlement", no "payout");
  - shared helpers for the fee rate, the party check, who raised the dispute and the maximum share;
  - the arbitration period text from one constant;
  - a busy guard on confirm buttons;
  - slider `aria-valuetext` and a live byte counter;
  - the expired section sorted.
- **Deviations:**
  - The evidence (deliverables, timeline) is on the project page, which every console card links to, not repeated on the console.
  - The criterion "checked by an E2E test in 12" is left for ticket 12; the preview is unit-tested and was checked live here.
    - **2026-10-28:** done in ticket 12: `web/e2e/dispute.e2e.ts` reads the preview and confirmation amounts from the page and matches them with `DisputeResolved` and every `BalanceCredited` to the wei.
  - A whitespace-only reason is rejected by the UI, though the contract would accept it.
  - The trust note goes into the README with ticket 13.
- **Limitations:**
  - Deadline states use the browser clock, so the UI can be off by the clock skew to the chain; the contract still decides.
  - Dates are shown to the minute, so "until D − 1" and "from D" can read the same.
- **Still open:** the real Pinata upload (tickets 04–05) and the Sepolia timeline run (ticket 07, after ticket 13) have not been done.
