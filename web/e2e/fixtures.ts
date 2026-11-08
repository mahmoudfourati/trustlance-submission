// Shared test setup: every test runs against a chain snapshot taken right after deployment and reverted afterwards,
// so tests can't see each other's projects, balances or time travel.
import { test as base, expect, type Locator, type Page } from '@playwright/test'
import { address, latestTimestamp, revert, snapshot } from './chain.ts'

export { expect }

export const test = base.extend<{ chainSnapshot: void }>({
  chainSnapshot: [
    // Playwright reads fixture dependencies from this destructuring, so it must stay an (empty) object pattern.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const id = await snapshot()
      await use()
      await revert(id)
    },
    { auto: true },
  ],
})

/**
 * Opens a page of the app as a local account through the test wallet (MetaMask's stand-in), and waits until the
 * header shows that account as connected, so a later "this button is absent" check can't pass before the wallet loads.
 */
export async function openAs(page: Page, account: number, path: string, extra: Record<string, string> = {}): Promise<void> {
  const query = new URLSearchParams({ testAccount: String(account), ...extra })
  await page.goto(`${path}${path.includes('?') ? '&' : '?'}${query}`)
  await expect(page.getByRole('banner').getByTitle(await address(account), { exact: true })).toBeVisible()
}

/**
 * Sets the browser's clock to the chain's latest block time and reloads, so the app's deadline states match what the
 * contract will see. Uploads are done before any time travel: the upload proxy checks signatures against real time.
 */
export async function syncBrowserClock(page: Page): Promise<void> {
  await page.clock.setFixedTime((await latestTimestamp()) * 1000)
  await page.reload()
}

/** One milestone's row on the project page, by its number and title. */
export function milestoneRow(page: Page, number: number, title: string): Locator {
  return page.getByRole('listitem').filter({ has: page.getByText(`${number}. ${title}`, { exact: true }) })
}

/** The exact amount next to a label in a list of amounts (dt/dd pairs). */
export function amount(scope: Page | Locator, label: string): Locator {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return scope.locator('dt', { hasText: new RegExp(`^${escaped}$`) }).locator('xpath=following-sibling::dd[1]')
}
