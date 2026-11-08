// Ticket 12: the wallet on an unsupported network, stale tabs, duplicate submissions and isolation between projects.
// Every check that something "didn't happen" is made on the chain, not only in the UI.
import { parseEther } from 'ethers'
import {
  MilestoneStatus,
  ProjectStatus,
  SETUP_CID,
  createProjectDirect,
  events,
  milestones,
  project,
  sendAs,
  withdrawable,
} from './chain.ts'
import { expect, milestoneRow, openAs, test } from './fixtures.ts'

const CLIENT = 2
const MAINNET = '1'

test('an unsupported network shows a read-only app with a switch prompt and offers no transactions', async ({ page }) => {
  const FREELANCER = 8
  const id = await createProjectDirect({ client: CLIENT, freelancer: FREELANCER, amounts: [parseEther('1')], accept: false })

  await openAs(page, FREELANCER, `/projects/${id}`, { testChain: MAINNET })
  await expect(page.getByText("Your wallet is on a network TrustLance doesn't support.", { exact: false })).toBeVisible()
  // The project is readable from the default chain, but nothing can be signed on the wallet's network.
  await expect(page.getByRole('heading', { name: 'Setup project' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Accept project' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Decline', exact: true })).toHaveCount(0)

  await openAs(page, FREELANCER, '/projects/new', { testChain: MAINNET })
  await expect(page.getByText('Switch your wallet to a supported network where TrustLance is deployed.')).toBeVisible()
  await openAs(page, FREELANCER, '/balances', { testChain: MAINNET })
  await expect(page.getByRole('button', { name: 'Withdraw all' })).toHaveCount(0)

  // Switching from the prompt brings the actions back without a reload.
  await openAs(page, FREELANCER, `/projects/${id}`, { testChain: MAINNET })
  await page.getByRole('button', { name: /^Switch to / }).click()
  await expect(page.getByText("Your wallet is on a network TrustLance doesn't support.", { exact: false })).toHaveCount(0)
  await page.getByRole('button', { name: 'Accept project' }).click()
  await expect(page.getByText('Project accepted. Every delivery period has started.')).toBeVisible()
  expect((await project(id)).status).toBe(ProjectStatus.Active)
})

test('a stale tab cannot approve twice: the second approval fails and nothing is credited again', async ({ page, context }) => {
  const FREELANCER = 9
  const id = await createProjectDirect({ client: CLIENT, freelancer: FREELANCER, amounts: [parseEther('0.8'), parseEther('0.2')] })
  await sendAs(FREELANCER, (e) => e.submitMilestone(id, 0, SETUP_CID))

  // Both tabs open the approval confirmation before either sends.
  const second = await context.newPage()
  for (const tab of [page, second]) {
    await openAs(tab, CLIENT, `/projects/${id}`)
    await milestoneRow(tab, 1, 'Milestone 1').getByRole('button', { name: 'Approve', exact: true }).click()
  }
  await milestoneRow(page, 1, 'Milestone 1').getByRole('button', { name: 'Yes, approve' }).click()
  await expect(page.getByText("Milestone approved. Its amount is in the freelancer's withdrawable balance.")).toBeVisible()

  const staleRow = milestoneRow(second, 1, 'Milestone 1')
  await staleRow.getByRole('button', { name: 'Yes, approve' }).click()
  await expect(staleRow.getByText('Transaction failed.')).toBeVisible()

  expect(await withdrawable(FREELANCER)).toBe(parseEther('0.8'))
  expect((await events('MilestoneApproved')).filter((e) => e.args.projectId === id)).toHaveLength(1)
  expect((await milestones(id)).map((m) => m.status)).toEqual([MilestoneStatus.Approved, MilestoneStatus.Pending])
})

test('a duplicate submission from a second tab is refused by the upload proxy and changes nothing', async ({ page, context }) => {
  const FREELANCER = 10
  const id = await createProjectDirect({ client: CLIENT, freelancer: FREELANCER, amounts: [parseEther('0.3')] })
  const file = (text: string) => ({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from(text) })

  const second = await context.newPage()
  for (const tab of [page, second]) {
    await openAs(tab, FREELANCER, `/projects/${id}`)
    const row = milestoneRow(tab, 1, 'Milestone 1')
    await row.getByRole('button', { name: 'Upload and submit' }).click()
    await row.getByLabel('Deliverable file (up to 50 MB)').setInputFiles(file(tab === page ? 'first' : 'second'))
  }
  const firstRow = milestoneRow(page, 1, 'Milestone 1')
  await firstRow.getByRole('button', { name: 'Upload and submit' }).click()
  await expect(firstRow.getByText("Milestone submitted. The client's review window has started.")).toBeVisible()
  const cid = (await milestones(id))[0].deliverableCid

  const staleRow = milestoneRow(second, 1, 'Milestone 1')
  await staleRow.getByRole('button', { name: 'Upload and submit' }).click()
  await expect(staleRow.getByText('This milestone is not waiting for a submission.')).toBeVisible()
  await expect(staleRow.getByText("Milestone submitted. The client's review window has started.")).toHaveCount(0)

  expect((await events('MilestoneSubmitted')).filter((e) => e.args.projectId === id)).toHaveLength(1)
  expect((await milestones(id))[0].deliverableCid).toBe(cid)
})

test('projects stay separate: each account sees only its own projects and only its own actions', async ({ page }) => {
  const [A, B] = [11, 12]
  const forA = await createProjectDirect({ client: CLIENT, freelancer: A, amounts: [parseEther('1')], accept: false, title: 'Offer for A' })
  const forB = await createProjectDirect({ client: CLIENT, freelancer: B, amounts: [parseEther('2')], accept: false, title: 'Offer for B' })

  await openAs(page, A, '/')
  await expect(page.getByRole('heading', { name: 'Offer for A' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Offer for B' })).toHaveCount(0)

  await openAs(page, CLIENT, '/')
  await expect(page.getByRole('heading', { name: 'Offer for A' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Offer for B' })).toBeVisible()

  // A can read B's project (it is public on-chain) but is offered no action on it.
  await openAs(page, A, `/projects/${forB}`)
  await expect(page.getByRole('heading', { name: 'Offer for B' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Accept project' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Cancel project' })).toHaveCount(0)

  // A accepting their offer leaves B's untouched.
  await openAs(page, A, `/projects/${forA}`)
  await page.getByRole('button', { name: 'Accept project' }).click()
  await expect(page.getByText('Project accepted. Every delivery period has started.')).toBeVisible()
  expect((await project(forA)).status).toBe(ProjectStatus.Active)
  expect((await project(forB)).status).toBe(ProjectStatus.Open)
  expect((await project(forB)).totalAmount).toBe(parseEther('2'))
})
