# One non-upgradeable escrow contract with pull payments

All projects live in a single `TrustLanceEscrow` contract, keyed by project id, rather than one contract per project from a factory. Every payout (approval, refund, resolution, arbitration fee) only credits a withdrawable balance; ETH leaves the contract solely through a per-account `withdraw`. The contract has no proxy and no upgrade path, and the admin has no function that moves escrow.

## Considered Options

- **Factory + per-project contracts**: isolates balances, but multiplies deployment gas, makes global accounting invariants harder to test, and adds a second contract to audit.
- **Push payments on approval**: one fewer transaction for the freelancer, but a reverting or re-entering recipient could block or corrupt state transitions.
- **Upgradeable proxy**: would let us fix bugs after Sepolia deployment, but gives the admin the power to rewrite escrow logic, which breaks the trust model. A bug fix is a redeploy; existing projects finish on the old contract.

## Consequences

- One accounting invariant covers every project: contract balance ≥ total escrow + total withdrawable balances.
- Project creation and funding happen in one transaction (`msg.value` must equal the sum of milestone amounts exactly), so there is no "created but unfunded" state.
