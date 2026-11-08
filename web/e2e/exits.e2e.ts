// Ticket 12: the ways money goes back to the client before completion — overdue refund (at D − 1 and D), cancelling an
// open offer, declining it, and the freelancer forfeiting — each checked to the wei on-chain.
import { parseEther } from 'ethers'
import {
  CreditReason,
  MilestoneStatus,
  ProjectStatus,
  SETUP_CID,
  address,
  blockTimestampOf,
  createProjectDirect,
  credits,
  escrowBalance,
  events,
  expectRevertAt,
  gasPaid,
  milestones,
  mineAt,
  project,
  provider,
  sendAs,
  setNextBlockTimestamp,
  withdrawable,
} from './chain.ts'
import { expect, milestoneRow, openAs, syncBrowserClock, test } from './fixtures.ts'
import { withdrawAll } from './flows.ts'

const CLIENT = 2
const FREELANCER = 5

test('overdue refund is refused at D − 1 and taken at exactly D, then withdrawn to the wei', async ({ page }) => {
  const amounts = [parseEther('0.4'), parseEther('0.600000000000000007')]
  const id = await createProjectDirect({ client: CLIENT, freelancer: FREELANCER, amounts, deliveryDays: 5 })
  const D = Number((await milestones(id))[0].deliveryDeadline)

  // D − 1: still within the delivery period. No refund button for the client; the freelancer can still submit.
  await mineAt(D - 2)
  await page.clock.setFixedTime((D - 1) * 1000)
  await openAs(page, CLIENT, `/projects/${id}`)
  await expect(page.getByText('1. Milestone 1', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refund overdue milestone' })).toHaveCount(0)
  await openAs(page, FREELANCER, `/projects/${id}`)
  await expect(milestoneRow(page, 1, 'Milestone 1').getByRole('button', { name: 'Upload and submit' })).toBeEnabled()
  await expectRevertAt(D - 1, CLIENT, (e) => e.refundOverdueMilestone(id, 0, { gasLimit: 500_000 }), 'DeliveryWindowOpen')

  // D: overdue. The client refunds milestone 1 from the UI in a block mined at exactly D.
  await page.clock.setFixedTime(D * 1000)
  await openAs(page, CLIENT, `/projects/${id}`)
  const row = milestoneRow(page, 1, 'Milestone 1')
  await row.getByRole('button', { name: 'Refund overdue milestone' }).click()
  await setNextBlockTimestamp(D)
  await row.getByRole('button', { name: 'Yes, refund' }).click()
  await expect(row.getByText('Milestone refunded. Its amount is in your withdrawable balance.')).toBeVisible()

  const [refunded] = (await events('MilestoneRefunded')).filter((e) => e.args.projectId === id)
  expect(await blockTimestampOf(refunded.transactionHash)).toBe(D)
  expect(refunded.args.amount).toBe(amounts[0])
  const ms = await milestones(id)
  expect(ms.map((m) => m.status)).toEqual([MilestoneStatus.Refunded, MilestoneStatus.Pending])
  const p = await project(id)
  expect(p.status).toBe(ProjectStatus.Active)
  expect(p.refundedAmount).toBe(amounts[0])
  expect(p.pendingAmount).toBe(amounts[1])
  expect(await withdrawable(CLIENT)).toBe(amounts[0])
  expect(await credits(id)).toEqual([[await address(CLIENT), amounts[0], CreditReason.Refund]])

  // The client withdraws: wallet up by exactly the refund minus gas; the second milestone stays in escrow.
  const client = await address(CLIENT)
  const before = await provider.getBalance(client)
  const escrowBefore = await escrowBalance()
  await withdrawAll(page, CLIENT)
  const [withdrawn] = (await events('Withdrawn')).filter((e) => e.args.account === client)
  expect(await provider.getBalance(client)).toBe(before + amounts[0] - (await gasPaid(withdrawn.transactionHash)))
  expect(await escrowBalance()).toBe(escrowBefore - amounts[0])
  expect(await withdrawable(CLIENT)).toBe(0n)
})

test('the client cancels an open offer and gets the full escrow back', async ({ page }) => {
  const amounts = [parseEther('1'), parseEther('0.5')]
  const id = await createProjectDirect({ client: CLIENT, freelancer: FREELANCER, amounts, accept: false })

  // The freelancer sees accept/decline, never cancel; the client sees cancel, never accept.
  await openAs(page, FREELANCER, `/projects/${id}`)
  await expect(page.getByRole('button', { name: 'Accept project' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel project' })).toHaveCount(0)
  await openAs(page, CLIENT, `/projects/${id}`)
  await expect(page.getByRole('button', { name: 'Accept project' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Cancel project' }).click()
  await page.getByRole('button', { name: 'Yes, cancel project' }).click()
  await expect(page.getByText('Project cancelled. The escrow is now in your withdrawable balance.')).toBeVisible()

  expect((await project(id)).status).toBe(ProjectStatus.Cancelled)
  expect(await withdrawable(CLIENT)).toBe(parseEther('1.5'))
  expect(await withdrawable(FREELANCER)).toBe(0n)
  expect((await events('ProjectCancelled')).filter((e) => e.args.projectId === id)).toHaveLength(1)
  expect(await credits(id)).toEqual([[await address(CLIENT), parseEther('1.5'), CreditReason.Refund]])
})

test('the freelancer declines an offer and the client is refunded in full', async ({ page }) => {
  const id = await createProjectDirect({ client: CLIENT, freelancer: FREELANCER, amounts: [parseEther('0.25')], accept: false })

  await openAs(page, FREELANCER, `/projects/${id}`)
  await page.getByRole('button', { name: 'Decline', exact: true }).click()
  await page.getByRole('button', { name: 'Yes, decline' }).click()
  await expect(page.getByText('Project declined. The client has been refunded.')).toBeVisible()

  expect((await project(id)).status).toBe(ProjectStatus.Cancelled)
  expect(await withdrawable(CLIENT)).toBe(parseEther('0.25'))
  expect((await events('ProjectDeclined')).filter((e) => e.args.projectId === id)).toHaveLength(1)
  expect(await credits(id)).toEqual([[await address(CLIENT), parseEther('0.25'), CreditReason.Refund]])
})

test('forfeit keeps what the freelancer earned and refunds the rest', async ({ page }) => {
  const amounts = [parseEther('1'), parseEther('0.3'), parseEther('0.2')]
  const id = await createProjectDirect({ client: CLIENT, freelancer: FREELANCER, amounts, reviewDays: 2 })
  // Milestone 1 approved; milestone 2 submitted and past its review deadline (earned); milestone 3 never delivered.
  await sendAs(FREELANCER, (e) => e.submitMilestone(id, 0, SETUP_CID))
  await sendAs(CLIENT, (e) => e.approveMilestone(id, 0))
  await sendAs(FREELANCER, (e) => e.submitMilestone(id, 1, SETUP_CID))
  await mineAt(Number((await milestones(id))[1].reviewDeadline))
  await openAs(page, FREELANCER, `/projects/${id}`)
  await syncBrowserClock(page)

  await page.getByRole('button', { name: 'Forfeit project' }).click()
  await page.getByRole('button', { name: 'Yes, forfeit project' }).click()
  await expect(page.getByText('Project forfeited.', { exact: false })).toBeVisible()

  const [forfeited] = (await events('ProjectForfeited')).filter((e) => e.args.projectId === id)
  expect(forfeited.args.creditedAmount).toBe(amounts[1])
  expect(forfeited.args.refundedAmount).toBe(amounts[2])
  expect((await project(id)).status).toBe(ProjectStatus.Completed)
  // The approved milestone is final and untouched; the earned submission is credited; only the undelivered one returns.
  expect(await withdrawable(FREELANCER)).toBe(amounts[0] + amounts[1])
  expect(await withdrawable(CLIENT)).toBe(amounts[2])
  expect((await milestones(id)).map((m) => m.status)).toEqual([MilestoneStatus.Approved, MilestoneStatus.Approved, MilestoneStatus.Refunded])
})
