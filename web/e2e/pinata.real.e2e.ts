// Opt-in real-Pinata check of the browser deliverable flow (playwright.pinata.config.ts, `npm run test:e2e:pinata`):
// the freelancer uploads an encrypted file through the dev server's proxy to real Pinata and submits its manifest CID;
// the client reads it back through a real IPFS gateway, decrypts it and gets the exact bytes. Skipped without a JWT.
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseEther } from 'ethers'
import { MilestoneStatus, createProjectDirect, milestones } from './chain.ts'
import { expect, milestoneRow, openAs, test } from './fixtures.ts'
import { submitDeliverable } from './flows.ts'

const CLIENT = 2
const FREELANCER = 3

test.skip(!process.env.E2E_PINATA_CONFIGURED, 'No PINATA_JWT in web/.env.local or the environment; the real Pinata flow was not run.')

test('real Pinata: encrypted upload, on-chain submit, gateway download and decryption in the browser', async ({ page }) => {
  // Random content, so the gateway can't answer from a cache of an earlier run.
  const content = Buffer.from(`TrustLance real Pinata E2E ${new Date().toISOString()} ${randomBytes(16).toString('hex')}`)
  const passphrase = randomBytes(12).toString('base64url')
  const id = await createProjectDirect({ client: CLIENT, freelancer: FREELANCER, amounts: [parseEther('0.01')] })

  await submitDeliverable(page, {
    freelancer: FREELANCER,
    id,
    number: 1,
    title: 'Milestone 1',
    file: { name: 'pinata-e2e.txt', mimeType: 'text/plain', buffer: content },
    passphrase,
  })
  const [submitted] = await milestones(id)
  expect(submitted.status).toBe(MilestoneStatus.Submitted)
  expect(submitted.deliverableCid).toMatch(/^(Qm|b)[a-z0-9]+$/i)
  console.log(`[pinata e2e] project ${id}, manifest CID ${submitted.deliverableCid}`)

  await openAs(page, CLIENT, `/projects/${id}`)
  const row = milestoneRow(page, 1, 'Milestone 1')
  // Gateways can take a moment to see a new pin; the app shows an error and the button stays available to retry.
  await expect(async () => {
    await row.getByRole('button', { name: 'Open deliverable' }).click()
    await expect(row.getByLabel('Passphrase from the freelancer')).toBeVisible({ timeout: 30_000 })
  }).toPass({ timeout: 3 * 60_000 })
  await row.getByLabel('Passphrase from the freelancer').fill(passphrase)
  const downloadEvent = page.waitForEvent('download', { timeout: 3 * 60_000 })
  await row.getByRole('button', { name: 'Decrypt and download' }).click()
  const download = await downloadEvent
  expect(Buffer.compare(await readFile(await download.path()), content)).toBe(0)
  await expect(row.getByText('Downloaded. The file matched the SHA-256 the freelancer committed to.')).toBeVisible()
})
