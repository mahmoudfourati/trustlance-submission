import { defineConfig } from '@playwright/test'
import { loadEnv } from 'vite'
import { appServer, chainServer, sharedUse } from './e2e/stack.ts'

// Opt-in: the same stack against real Pinata, with the PINATA_JWT from web/.env.local (or the environment). The JWT is
// only checked for presence here; the dev server reads it as usual and it never reaches the browser or the test.
const fileEnv = loadEnv('testwallet', process.cwd(), '')
const pinataConfigured = Boolean(process.env.PINATA_JWT?.trim() || fileEnv.PINATA_JWT?.trim())
process.env.E2E_PINATA_CONFIGURED = pinataConfigured ? '1' : ''
// The app reads VITE_PINATA_GATEWAY first, then the public gateways. ipfs.io and dweb.link rate-limit (HTTP 429, without
// CORS headers) often enough to make this test flaky, so without a dedicated gateway it reads through Pinata's shared one.
const gateway = process.env.E2E_PINATA_GATEWAY?.trim() || fileEnv.VITE_PINATA_GATEWAY?.trim() || 'gateway.pinata.cloud'

/** `npm run test:e2e:pinata` from the repo root. Skips (and starts nothing) when no PINATA_JWT is configured. */
export default defineConfig({
  testDir: './e2e',
  testMatch: /pinata\.real\.e2e\.ts$/,
  globalSetup: pinataConfigured ? './e2e/globalSetup.ts' : undefined,
  workers: 1,
  retries: 0,
  // Real uploads and public gateway reads are slower than the local store.
  timeout: 5 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-pinata' }]],
  outputDir: 'test-results-pinata',
  use: sharedUse,
  webServer: pinataConfigured ? [chainServer, appServer({ VITE_PINATA_GATEWAY: gateway })] : [],
})
