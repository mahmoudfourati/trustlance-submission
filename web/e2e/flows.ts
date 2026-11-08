// UI steps shared by several scenarios. Each one drives the app the way a user would and waits for the app's own
// confirmation; the scenarios then check the chain directly.
import type { Page } from '@playwright/test'
import { address } from './chain.ts'
import { expect, milestoneRow, openAs } from './fixtures.ts'

export type MilestoneDraft = { title: string; eth: string; days: number }

/** Creates and funds a project through the form as `client`, and returns its id from the page it lands on. */
export async function createProject(
  page: Page,
  { client, freelancer, title, milestones, reviewDays = 7 }: { client: number; freelancer: number; title: string; milestones: MilestoneDraft[]; reviewDays?: number },
): Promise<bigint> {
  await openAs(page, client, '/projects/new')
  await page.getByLabel('Title', { exact: true }).first().fill(title)
  await page.getByLabel('Freelancer address').fill(await address(freelancer))
  await page.getByLabel('Review window (days)').fill(String(reviewDays))
  for (const [i, m] of milestones.entries()) {
    if (i > 0) await page.getByRole('button', { name: 'Add milestone' }).click()
    const fieldset = page.getByRole('group', { name: `Milestone ${i + 1}` })
    await fieldset.getByLabel('Title').fill(m.title)
    await fieldset.getByLabel('Amount (ETH)').fill(m.eth)
    await fieldset.getByRole('spinbutton').fill(String(m.days))
  }
  await page.getByRole('button', { name: 'Create and fund project' }).click()
  await expect(page).toHaveURL(/\/projects\/\d+(\?|$)/)
  const id = /\/projects\/(\d+)/.exec(page.url())![1]
  return BigInt(id)
}

export async function acceptProject(page: Page, freelancer: number, id: bigint): Promise<void> {
  await openAs(page, freelancer, `/projects/${id}`)
  await page.getByRole('button', { name: 'Accept project' }).click()
  await expect(page.getByText('Project accepted. Every delivery period has started.')).toBeVisible()
}

/** Uploads a deliverable through the proxy (the local pinning store) and submits its manifest CID on-chain. */
export async function submitDeliverable(
  page: Page,
  { freelancer, id, number, title, file, passphrase }: { freelancer: number; id: bigint; number: number; title: string; file: { name: string; mimeType: string; buffer: Buffer }; passphrase?: string },
): Promise<void> {
  await openAs(page, freelancer, `/projects/${id}`)
  const row = milestoneRow(page, number, title)
  await row.getByRole('button', { name: 'Upload and submit' }).click()
  await row.getByLabel('Deliverable file (up to 50 MB)').setInputFiles(file)
  if (passphrase) {
    await row.getByLabel('Passphrase (optional)').fill(passphrase)
    await row.getByLabel('Repeat passphrase').fill(passphrase)
  }
  await row.getByRole('button', { name: 'Upload and submit' }).click()
  await expect(row.getByText("Milestone submitted. The client's review window has started.")).toBeVisible()
}

export async function approveMilestone(page: Page, client: number, id: bigint, number: number, title: string): Promise<void> {
  await openAs(page, client, `/projects/${id}`)
  const row = milestoneRow(page, number, title)
  await row.getByRole('button', { name: 'Approve', exact: true }).click()
  await row.getByRole('button', { name: 'Yes, approve' }).click()
  await expect(row.getByText("Milestone approved. Its amount is in the freelancer's withdrawable balance.")).toBeVisible()
}

export async function withdrawAll(page: Page, account: number): Promise<void> {
  await openAs(page, account, '/balances')
  await page.getByRole('button', { name: 'Withdraw all' }).click()
  await expect(page.getByText('Withdrawn to your wallet.')).toBeVisible()
}
