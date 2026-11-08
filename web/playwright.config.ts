import { defineConfig } from '@playwright/test'
import { E2E } from './e2e/ports.ts'
import { appServer, chainServer, sharedUse } from './e2e/stack.ts'

/**
 * End-to-end suite (ticket 12): a fresh Hardhat node, the escrow deployed by global setup, the local pinning store in
 * place of Pinata, and the dev server in test-wallet mode. Run with `npm run test:e2e` from the repo root.
 * The real-Pinata test has its own config: playwright.pinata.config.ts.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts$/,
  testIgnore: /\.real\.e2e\.ts$/,
  globalSetup: './e2e/globalSetup.ts',
  // One chain shared by every test, reset to a snapshot between tests, so the suite runs serially.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: sharedUse,
  webServer: [
    chainServer,
    {
      command: `node e2e/pinningStore.ts ${E2E.storePort}`,
      url: `${E2E.storeUrl}/health`,
      reuseExistingServer: false,
    },
    appServer({ VITE_E2E_IPFS_GATEWAY: `${E2E.storeUrl}/ipfs/`, E2E_PINNING_STORE_URL: E2E.storeUrl }),
  ],
})
