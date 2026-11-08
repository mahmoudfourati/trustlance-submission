// Read-only check of an Ignition deployment against the chain, needing no secrets:
//   node scripts/check-deployment.ts <chainId>      (RPC from CHECK_RPC_URL, or a public default)
// It compares the chain id, the deployed bytecode (immutables masked), the constructor arguments the journal recorded
// (admin, default arbitrator, fee), the pause state, the deployment block and the address exported to the web app.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, getAddress } from "ethers";

const DEFAULT_RPC: Record<number, string> = {
  31337: "http://127.0.0.1:8545",
  11155111: "https://sepolia.gateway.tenderly.co",
};
const EXPLORER: Record<number, string> = { 11155111: "https://sepolia.etherscan.io" };
const MAX_CODE_BYTES = 24_576; // EIP-170
const futureId = "TrustLanceEscrowModule#TrustLanceEscrow";

const contractsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const chainId = Number(process.argv[2]);
if (!Number.isSafeInteger(chainId)) throw new Error("Usage: node scripts/check-deployment.ts <chainId>");
const rpcUrl = process.env.CHECK_RPC_URL?.trim() || DEFAULT_RPC[chainId];
if (!rpcUrl) throw new Error(`No default RPC for chain ${chainId}; set CHECK_RPC_URL.`);

const deploymentDir = join(contractsDir, "ignition", "deployments", `chain-${chainId}`);
const journalPath = join(deploymentDir, "journal.jsonl");
if (!existsSync(journalPath)) throw new Error(`No Ignition deployment for chain ${chainId} (${journalPath}).`);
const journal = readFileSync(journalPath, "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as Record<string, any>);
const init = journal.find((e) => e.type === "DEPLOYMENT_EXECUTION_STATE_INITIALIZE" && e.futureId === futureId);
const done = journal.find((e) => e.type === "DEPLOYMENT_EXECUTION_STATE_COMPLETE" && e.futureId === futureId);
const confirm = journal.find((e) => e.type === "TRANSACTION_CONFIRM" && e.futureId === futureId);
if (!init || !done || !confirm) throw new Error("The journal has no completed TrustLanceEscrow deployment.");
const [adminArg, arbitratorArg, feeArg] = init.constructorArgs as [string, string, number];
const address = getAddress(done.result.address);
const txHash: string = confirm.hash;

// The artifact Ignition deployed from, kept with the deployment record (so no compile is needed and drift since then
// doesn't matter here).
const artifact = JSON.parse(readFileSync(join(deploymentDir, "artifacts", `${futureId}.json`), "utf8")) as { abi: []; deployedBytecode: string; immutableReferences: Record<string, { start: number; length: number }[]> };

const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: false });
const escrow = new Contract(address, artifact.abi, provider);
let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${detail}`);
  if (!ok) failures++;
}

/** Hex code with every immutable slot zeroed, so the artifact and the deployed code can be compared. */
function maskImmutables(code: string): string {
  const bytes = Buffer.from(code.slice(2), "hex");
  for (const refs of Object.values(artifact.immutableReferences)) for (const { start, length } of refs) bytes.fill(0, start, start + length);
  return bytes.toString("hex");
}

const network = await provider.getNetwork();
check("chain id", network.chainId === BigInt(chainId), `${network.chainId}`);

const code = await provider.getCode(address);
const size = (code.length - 2) / 2;
check("code size", size > 0 && size <= MAX_CODE_BYTES, `${size} bytes (limit ${MAX_CODE_BYTES})`);
check("bytecode matches the deployed artifact", maskImmutables(code) === maskImmutables(artifact.deployedBytecode), address);
if (size === 0) {
  console.error(`\nNo contract code at ${address} on this chain; nothing else to check.`);
  process.exit(1);
}

const receipt = await provider.getTransactionReceipt(txHash);
check("deployment transaction succeeded", receipt?.status === 1 && getAddress(receipt.contractAddress ?? "0x0000000000000000000000000000000000000000") === address, txHash);
const deploymentBlock = (await escrow.deploymentBlock()) as bigint;
check("deploymentBlock()", receipt !== null && deploymentBlock === BigInt(receipt.blockNumber), `${deploymentBlock}`);

check("admin (owner)", getAddress((await escrow.owner()) as string) === getAddress(adminArg), adminArg);
check("default arbitrator", getAddress((await escrow.defaultArbitrator()) as string) === getAddress(arbitratorArg), arbitratorArg);
check("arbitration fee", Number(await escrow.arbitrationFeeBps()) === Number(feeArg), `${feeArg} bps`);
check("admin and arbitrator differ", getAddress(adminArg) !== getAddress(arbitratorArg), "separate roles");
check("not paused", (await escrow.paused()) === false, "new projects can be created");

const exportedFile = readFileSync(join(contractsDir, "..", "web", "src", "contracts", "generated", "deployments.ts"), "utf8");
const exportedJson = /=\s*(\{[\s\S]*?\});/.exec(exportedFile)?.[1];
const exported = exportedJson ? (JSON.parse(exportedJson) as Record<string, string>)[String(chainId)] : undefined;
check("address exported to the web app", exported !== undefined && getAddress(exported) === address, `${exported ?? "missing"} in web/src/contracts/generated/deployments.ts`);

const explorer = EXPLORER[chainId];
if (explorer) {
  console.log(`\nContract:   ${explorer}/address/${address}#code`);
  console.log(`Deployment: ${explorer}/tx/${txHash} (block ${deploymentBlock})`);
}
if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll deployment checks passed.");
