// The processes behind both end-to-end configs: a fresh Hardhat node and the dev server in test-wallet mode.
// Nothing reuses a running server, so every run starts from an empty chain.
import type { PlaywrightTestConfig } from '@playwright/test'
import { E2E } from './ports.ts'

type WebServer = Exclude<NonNullable<PlaywrightTestConfig['webServer']>, readonly unknown[]>

export const chainServer: WebServer = {
  command: `npx hardhat node --port ${E2E.chainPort}`,
  cwd: '../contracts',
  port: E2E.chainPort,
  reuseExistingServer: false,
  timeout: 120_000,
}

/** The dev server pointed at the end-to-end node; `env` adds settings such as the local pinning store. */
export function appServer(env: Record<string, string> = {}): WebServer {
  return {
    command: `npx vite --mode testwallet --port ${E2E.appPort} --strictPort`,
    url: E2E.appUrl,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_DEFAULT_CHAIN_ID: '31337',
      VITE_LOCAL_RPC_URL: E2E.chainUrl,
      UPLOAD_PROXY_RPC_URL_31337: E2E.chainUrl,
      ...env,
    },
  }
}

export const sharedUse: PlaywrightTestConfig['use'] = {
  baseURL: E2E.appUrl,
  // The installed Chrome by default (no browser download); E2E_BROWSER_CHANNEL='' uses Playwright's Chromium.
  channel: process.env.E2E_BROWSER_CHANNEL ?? 'chrome',
  // Traces (DOM snapshots, network, console) and screenshots are the failure diagnostics.
  trace: 'retain-on-failure',
  screenshot: 'only-on-failure',
  acceptDownloads: true,
}
