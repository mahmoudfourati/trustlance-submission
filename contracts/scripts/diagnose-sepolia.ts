// Read-only check of the Sepolia deployer before a deployment; it sends no transaction:
//   npm run diagnose:sepolia -w @trustlance/contracts
// Hardhat asks for the keystore password. Only public values are printed: never the key or the RPC URL.
import { readFileSync } from "node:fs";
import { network } from "hardhat";

const SEPOLIA_CHAIN_ID = 11155111n;
const MEASURED_DEPLOYMENT_GAS = 3_505_947n; // from a local deployment; used when the RPC can't estimate
const SAFETY_MARGIN_PERCENT = 120n;

/** Errors can quote the RPC URL, so print one short line with URLs and anything key-shaped removed. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .split("\n")[0]
    .replace(/[a-z]+:\/\/\S+/gi, "<url hidden>")
    .replace(/0x[0-9a-f]{64}/gi, "<hex hidden>")
    .slice(0, 200);
}

try {
  const { ethers } = await network.create();
  const { provider } = ethers;

  // The first check: Hardhat's chain lock lets only this read through on a wrong chain, and no funding advice is given
  // there because it could mean real ETH.
  const chainId = BigInt((await provider.send("eth_chainId", [])) as string);
  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(`RPC chain ID is ${chainId}${chainId === 1n ? " (Ethereum MAINNET, real ETH)" : ""}, not Sepolia (${SEPOLIA_CHAIN_ID}). DO NOT DEPLOY or add funds; set SEPOLIA_RPC_URL to a Sepolia endpoint.`);
  }

  const parameters = JSON.parse(readFileSync(new URL("../ignition/parameters/sepolia.json", import.meta.url), "utf8")).TrustLanceEscrowModule as { admin: string; arbitrator: string; feeBps?: number };
  const eth = (wei: bigint) => `${ethers.formatEther(wei)} ETH`;
  const gwei = (wei: bigint | null) => (wei === null ? "not reported" : `${ethers.formatUnits(wei, "gwei")} gwei`);

  const [deployer] = await ethers.getSigners();
  const balance = await provider.getBalance(deployer.address);
  const fees = await provider.getFeeData();
  const matchesAdmin = ethers.getAddress(parameters.admin) === deployer.address;

  console.log(`Deployer address:  ${deployer.address}`);
  console.log(`Balance:           ${eth(balance)}`);
  console.log(`RPC chain ID:      ${chainId} (Sepolia)`);
  console.log(`Gas price:         ${gwei(fees.gasPrice)}`);
  console.log(`Max fee per gas:   ${gwei(fees.maxFeePerGas)}`);
  console.log(`Priority fee:      ${gwei(fees.maxPriorityFeePerGas)}`);
  console.log(`Admin in params:   ${parameters.admin} (${matchesAdmin ? "matches the deployer" : "differs from the deployer"})`);

  // Estimated from the zero address, so that an empty deployer doesn't make the estimate itself fail.
  let gas = MEASURED_DEPLOYMENT_GAS;
  let gasSource = "measured locally";
  try {
    const factory = await ethers.getContractFactory("TrustLanceEscrow");
    const { data } = await factory.getDeployTransaction(parameters.admin, parameters.arbitrator, parameters.feeBps ?? 100);
    gas = await provider.estimateGas({ from: ethers.ZeroAddress, data });
    gasSource = "estimated by the RPC";
  } catch (error) {
    console.log(`Gas estimate:      failed, using the local measurement (${safeMessage(error)})`);
  }
  console.log(`Deployment gas:    ${gas} (${gasSource})`);

  const feePerGas = fees.maxFeePerGas ?? fees.gasPrice;
  if (feePerGas === null) throw new Error("The RPC reported no gas fees.");
  const expected = gas * (fees.gasPrice ?? feePerGas);
  const required = (gas * feePerGas * SAFETY_MARGIN_PERCENT) / 100n;
  console.log(`Expected cost:     ${eth(expected)}`);
  console.log(`Balance to hold:   ${eth(required)} (at the max fee, plus 20%)`);

  if (balance >= required) {
    console.log("\nVerdict:           balance looks sufficient");
  } else {
    console.log(`\nVerdict:           balance too low, add at least ${eth(required - balance)} of Sepolia test ETH`);
    if (balance === 0n) console.log("Note:              this address is empty on Sepolia. Check that SEPOLIA_PRIVATE_KEY belongs to the account you funded.");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Diagnostic failed: ${safeMessage(error)}`);
  process.exitCode = 1;
}
