// The real `sepolia` network config, pointed at a fake RPC on localhost with a throwaway key, proves that a wrong RPC
// can't receive a deployment. Nothing here reaches a live network or reads the keystore.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Wallet } from "ethers";
import { network } from "hardhat";
import TrustLanceEscrowModule from "../ignition/modules/TrustLanceEscrow.js";

const MAINNET = 1;
const SEPOLIA = 11155111;
const CONTRACTS_DIR = fileURLToPath(new URL("..", import.meta.url));
const HARDHAT_CLI = fileURLToPath(new URL("../../node_modules/hardhat/dist/src/cli.js", import.meta.url));
const DEPLOYMENT_ID = "test-chain-guard";
const SEND_METHODS = ["eth_sendRawTransaction", "eth_sendTransaction"];

/** A JSON-RPC endpoint reporting `chainId`. It records every method and refuses to accept a transaction. */
async function startFakeRpc(chainId: number) {
  const methods: string[] = [];
  const answers: Record<string, unknown> = {
    eth_chainId: `0x${chainId.toString(16)}`,
    eth_gasPrice: "0x77359400",
    eth_maxPriorityFeePerGas: "0x3b9aca00",
    eth_feeHistory: { baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"], gasUsedRatio: [0.5], oldestBlock: "0x10", reward: [["0x3b9aca00"]] },
    eth_getBlockByNumber: {
      number: "0x10",
      hash: `0x${"ab".repeat(32)}`,
      parentHash: `0x${"cd".repeat(32)}`,
      timestamp: "0x1",
      nonce: "0x0000000000000000",
      difficulty: "0x0",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      miner: `0x${"11".repeat(20)}`,
      extraData: "0x",
      baseFeePerGas: "0x3b9aca00",
      transactions: [],
    },
    eth_getTransactionCount: "0x0",
    eth_getBalance: "0xde0b6b3a7640000",
    eth_estimateGas: "0x5208",
    eth_blockNumber: "0x10",
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      methods.push(method);
      const outcome = method in answers ? { result: answers[method] } : { error: { code: -32000, message: `fake RPC: ${method} not accepted` } };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id, ...outcome }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v3/rpc-key-marker`;
  return { url, methods, close: () => new Promise((resolve) => server.close(resolve)) };
}

function connectSepoliaConfigTo(url: string) {
  return network.create({ network: "sepolia", override: { url, accounts: [Wallet.createRandom().privateKey] } });
}

function assertNothingSent(methods: string[]) {
  assert.deepEqual(methods.filter((method) => SEND_METHODS.includes(method)), []);
}

describe("sepolia network: chain ID guard", function () {
  let rpc: Awaited<ReturnType<typeof startFakeRpc>>;

  afterEach(async function () {
    await rpc.close();
  });

  describe("with an RPC on Ethereum Mainnet", function () {
    beforeEach(async function () {
      rpc = await startFakeRpc(MAINNET);
    });

    after(async function () {
      await rm(`${CONTRACTS_DIR}ignition/deployments/${DEPLOYMENT_ID}`, { recursive: true, force: true });
    });

    it("refuses the Ignition deployment and sends no transaction", async function () {
      const { ignition } = await connectSepoliaConfigTo(rpc.url);

      await assert.rejects(
        ignition.deploy(TrustLanceEscrowModule, {
          deploymentId: DEPLOYMENT_ID,
          parameters: { TrustLanceEscrowModule: { admin: Wallet.createRandom().address, arbitrator: Wallet.createRandom().address } },
        }),
        /HHE708.*"11155111".*"1"/,
      );
      assertNothingSent(rpc.methods);
    });

    it("refuses a plain transaction from the signer and sends nothing", async function () {
      const { ethers } = await connectSepoliaConfigTo(rpc.url);

      await assert.rejects(async () => {
        const [signer] = await ethers.getSigners();
        await signer.sendTransaction({ to: Wallet.createRandom().address, value: 1n });
      }, /HHE708/);
      assertNothingSent(rpc.methods);
    });

    it("makes diagnose-sepolia stop with a clear error, without printing secrets", async function () {
      const key = Wallet.createRandom().privateKey;
      const run = promisify(execFile)(process.execPath, [HARDHAT_CLI, "run", "scripts/diagnose-sepolia.ts", "--network", "sepolia"], {
        cwd: CONTRACTS_DIR,
        env: { ...process.env, SEPOLIA_RPC_URL: rpc.url, SEPOLIA_PRIVATE_KEY: key },
      });

      const failure = (await run.then(
        () => assert.fail("expected a non-zero exit"),
        (error: unknown) => error,
      )) as { code: number; stdout: string; stderr: string };
      const output = failure.stdout + failure.stderr;

      assert.equal(failure.code, 1);
      assert.match(output, /chain ID is 1 \(Ethereum MAINNET/);
      assert.match(output, /DO NOT DEPLOY/);
      assert.doesNotMatch(output, /rpc-key-marker|127\.0\.0\.1/);
      assert.ok(!output.includes(key.slice(2)), "the private key was printed");
      assertNothingSent(rpc.methods);
    });
  });

  // The control: on the right chain a transaction does reach the fake RPC, so "nothing sent" above means something.
  describe("with an RPC on Sepolia", function () {
    it("lets a signed transaction through to the RPC", async function () {
      rpc = await startFakeRpc(SEPOLIA);
      const { ethers } = await connectSepoliaConfigTo(rpc.url);
      const [signer] = await ethers.getSigners();

      await assert.rejects(signer.sendTransaction({ to: Wallet.createRandom().address, value: 1n }), /eth_sendRawTransaction not accepted/);
      assert.ok(rpc.methods.includes("eth_sendRawTransaction"));
    });
  });
});
