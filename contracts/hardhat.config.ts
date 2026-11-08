import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    profiles: {
      // Same optimizer as production: tests then run the bytecode that gets deployed, and the unoptimized
      // contract no longer fits the 24 KB code-size limit.
      default: {
        version: "0.8.34",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      production: {
        version: "0.8.34",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  test: {
    solidity: {
      profiles: {
        // Run by `npm test` and `npm run check`. The seed is fixed, so runs are reproducible.
        default: {
          fuzz: { runs: 256, seed: "0x7472757374" },
          // failOnRevert: the handler never reverts on purpose, so a revert is a bug in the harness.
          invariant: { runs: 64, depth: 200, failOnRevert: true },
          // The invariant setUp deploys the escrow and the fuzz handler in one call, which needs more than the default.
          gasLimit: 50_000_000n,
        },
        // `npm run test:deep -w @trustlance/contracts`: the long campaign reported in ticket 11.
        deep: {
          fuzz: { runs: 10_000, seed: "0x7472757374" },
          invariant: { runs: 1000, depth: 500, failOnRevert: true },
          gasLimit: 50_000_000n,
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    // Secrets come from the Hardhat keystore (`npx hardhat keystore set <NAME>`), never from files in the repo.
    sepolia: {
      type: "http",
      chainType: "l1",
      // Hardhat refuses every request but a chain ID read if the RPC is on another chain, so a wrong URL can't deploy.
      chainId: 11155111,
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
  },
  // Etherscan source verification (`--verify` on `npm run deploy:sepolia`); the key also comes from the keystore.
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
});
