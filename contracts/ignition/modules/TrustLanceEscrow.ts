import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// The admin and arbitrator have no defaults, so a forgotten address stops the deployment instead of silently using
// the deployer. They can't default to `m.getAccount(n)` either: Ignition validates that account index even when the
// parameter is set, which breaks a network with one signing account such as Sepolia.
// Addresses come from ignition/parameters/local.json (local node) or sepolia.json.
export default buildModule("TrustLanceEscrowModule", (m) => {
  const admin = m.getParameter<string>("admin");
  const arbitrator = m.getParameter<string>("arbitrator");
  const feeBps = m.getParameter("feeBps", 100);

  const escrow = m.contract("TrustLanceEscrow", [admin, arbitrator, feeBps]);

  return { escrow };
});
