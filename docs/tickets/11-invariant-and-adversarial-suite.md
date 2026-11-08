# 11: Invariant, fuzz and adversarial test suite

**What to build:** Solidity invariant/fuzz tests with a handler that randomizes actions across several projects, actors and time jumps and asserts every spec invariant. Also extra malicious-actor tests: contract parties, forced ETH, re-entrancy through every crediting path. Coverage report.

**Blocked by:** 09

**Status:** ready-for-human

- [x] All 13 spec invariants have assertions and pass over the configured number of runs (the handler includes revision requests, time jumps landing exactly on deadlines, and withdrawals during disputes)
- [x] Line and branch coverage of the escrow contract reported, with any uncovered branch explained
- [x] A whole-contract `code-review` pass with findings fixed or recorded as accepted risks

## Comments

- **Built:** Solidity suites in `contracts/test/solidity/`, with the write-up in `docs/security.md`:
  - `TrustLanceEscrow.adversarial.t.sol`: 15 tests with attacker contracts (`Attackers.sol`). They cover:
    - re-entrancy through every crediting path and through `withdraw`;
    - parties that revert or burn gas;
    - forced ETH and plain transfers;
    - repeated actions and the full role matrix;
    - cross-project isolation;
    - gas on 20 milestones, and no gas growth with more projects or users;
    - fee overflow at impossible amounts.
  - `TrustLanceEscrow.invariant.t.sol` with `EscrowHandler.sol`: the stateful campaign.
    - The handler predicts every call from the spec's state tables and checks the per-call rules.
    - Four invariant functions, plus `afterInvariant` for liveness (invariant 9).
    - The mapping from invariants 1–13 to assertions is in `docs/security.md`.
  - `TrustLanceEscrow.fuzz.t.sol`: 5 stateless fuzz tests:
    - resolution and expired-settlement splits;
    - review deadline at D − 1 and D;
    - same-block resolution against settlement;
    - late submission against overdue refund.
  - Test profiles in `hardhat.config.ts`: `default` (fuzz 256, invariants 64 × 200, fixed seed) and `deep` (fuzz 10 000, invariants 1 000 × 500, run with `npm run test:deep -w @trustlance/contracts`).
- **Results:**
  - `npm run check` passes: 188 contract tests (24 Solidity, 164 mocha) and 148 web tests.
  - The deep campaign passed: 24 tests in 1 061 s, which is 2 million handler calls and 50 000 fuzz cases.
  - Coverage of `TrustLanceEscrow.sol`: 100% lines (308/308) and 100% statements. Hardhat 3 doesn't measure branches, so they were checked by hand (every custom error and both sides of every bound are tested; details in `docs/security.md`). No branch is known to be uncovered.
- **Mutation check:** 16 injected bugs, all detected by the final suites; the contract was restored byte-for-byte. The first round missed two, and both gaps are now closed:
  - a revision counter that never increments;
  - a share cap that ignores the fee.
- **Vulnerabilities:** none found. `TrustLanceEscrow.sol` is unchanged.
- **Harness bugs found and fixed:**
  - The first green invariant run was almost vacuous: shift-derived seeds were 0 for small fuzz inputs, and a pause stalled every creation. The handler now hashes its seeds and favours actions that can make progress.
  - The invariant setUp needed a higher test gas limit (50 M).
- **Reviews:**
  - *Standards:* fixed CONTEXT.md vocabulary ("owner", "payout") and stale comments; gave two bare `expectRevert()` calls their exact reasons; replaced enum magic numbers with names; added a non-vacuity assertion.
  - *Spec:* added a check that a project's parties and terms never change (invariant 4), a no-growth gas test (invariant 8), re-entry into decline and auto-approval, and malformed `createProject` inputs; recorded the fee overflow as an accepted risk.
  - *Judgement calls left as they are:* small duplicated helpers between the handler and the test bases, and the table-plus-switch re-entry test.
- **Accepted risks** (detail in `docs/security.md`):
  - forced ETH stays locked;
  - a party that can't receive ETH locks only its own balance;
  - arbitrator trust;
  - the admin can pause and renounce (new projects only);
  - `resolveDispute` reverts above about 10⁷⁴ wei frozen, while settlement still works;
  - the late-submission/refund race;
  - timestamp skew;
  - unbounded view arrays.
- **Not proven:** fuzzing samples inputs and found no counterexample. It is not a formal proof, and the handler's predictions were written from the spec by the same team.
- **Still open:** the real Pinata upload (tickets 04–05) and the Sepolia timeline run (ticket 07, after ticket 13) have not been done.
