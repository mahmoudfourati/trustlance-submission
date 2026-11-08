// Ticket 12: disputes. The arbitrator's resolution preview must equal what the contract credits, to the wei; an
// expired dispute settles from exactly raisedAt + 30 days with the fixed fallback split.
import { parseEther } from 'ethers'
import type { Locator, Page } from '@playwright/test'
import {
  CreditReason,
  MilestoneStatus,
  ProjectStatus,
  ROLE,
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
  revert,
  sendAs,
  setNextBlockTimestamp,
  snapshot,
  withdrawable,
} from './chain.ts'
import { amount, expect, openAs, test } from './fixtures.ts'
import { withdrawAll } from './flows.ts'

const CLIENT = 2
const ARBITRATION_PERIOD = 30 * 24 * 60 * 60
const BPS = 10_000n

/** Reads an exact amount the UI shows ("1.000000000000000033 ETH") back into wei. */
async function weiShown(cell: Locator): Promise<bigint> {
  const text = (await cell.textContent())!.trim()
  expect(text).toMatch(/^\d+(\.\d+)? ETH$/)
  return parseEther(text.replace(/ ETH$/, ''))
}

/** The innermost div that contains `text` (a confirmation box or panel), for scoping its amounts. */
const boxWith = (page: Page, text: string) =>
  page.locator('div').filter({ hasText: text }).filter({ hasNot: page.locator('div').filter({ hasText: text }) })

test('arbitrator resolution: preview, confirmation and on-chain credits agree to the wei', async ({ page }) => {
  const FREELANCER = 6
  // Approved (final), submitted and in review, never delivered. The odd wei make the 1% fee round down.
  const amounts = [parseEther('0.5'), parseEther('0.300000000000000033'), parseEther('0.7')]
  const id = await createProjectDirect({ client: CLIENT, freelancer: FREELANCER, amounts, reviewDays: 7 })
  await sendAs(FREELANCER, (e) => e.submitMilestone(id, 0, SETUP_CID))
  await sendAs(CLIENT, (e) => e.approveMilestone(id, 0))
  await sendAs(FREELANCER, (e) => e.submitMilestone(id, 1, SETUP_CID))
  const frozen = amounts[1] + amounts[2]

  // The client raises the dispute; the confirmation shows exactly what will be frozen.
  await openAs(page, CLIENT, `/projects/${id}`)
  await page.getByRole('button', { name: 'Raise a dispute' }).click()
  await page.getByLabel('What is the dispute about?', { exact: false }).fill('The website milestone does not match the brief.')
  await page.getByRole('button', { name: 'Review dispute' }).click()
  const raiseBox = boxWith(page, "Raise a dispute on this project? This can't be withdrawn.")
  expect(await weiShown(amount(raiseBox, 'Frozen in total'))).toBe(frozen)
  expect(await weiShown(amount(raiseBox, 'Frozen from submissions in review'))).toBe(amounts[1])
  expect(await weiShown(amount(raiseBox, 'Frozen from Pending milestones'))).toBe(amounts[2])
  await page.getByRole('button', { name: 'Yes, raise the dispute' }).click()
  await expect(page.getByText('Dispute raised. The open milestones are frozen until it is settled.')).toBeVisible()
  let p = await project(id)
  expect(p.status).toBe(ProjectStatus.Disputed)
  expect(p.frozenAmount).toBe(frozen)
  expect(p.raisedBy).toBe(await address(CLIENT))

  // Neither party can resolve; only the arbitrator sees the console entry and the resolve action.
  await expect(page.getByRole('button', { name: 'Resolve dispute' })).toHaveCount(0)
  await openAs(page, ROLE.arbitrator, '/arbitration')
  await page.getByRole('link', { name: /Setup project/ }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${id}`))
  await expect(page.getByRole('button', { name: 'Resolve dispute' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Settle expired dispute' })).toHaveCount(0)

  // Switching the wallet to the client hides the arbitrator's action without a reload; switching back restores it.
  await page.evaluate((i) => window.testWallet!.switchAccount(i), CLIENT)
  await expect(page.getByRole('button', { name: 'Resolve dispute' })).toHaveCount(0)
  await page.evaluate((i) => window.testWallet!.switchAccount(i), ROLE.arbitrator)
  await expect(page.getByRole('button', { name: 'Resolve dispute' })).toBeEnabled()

  await page.getByRole('button', { name: 'Resolve dispute' }).click()
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Review resolution' }) })
  const fee = (frozen * 100n) / BPS
  const maxShare = frozen - fee

  // The slider's end gives the freelancer everything after the fee.
  await form.getByRole('slider').focus()
  await form.getByRole('slider').press('End')
  expect(await weiShown(amount(form, 'Freelancer receives'))).toBe(maxShare)
  expect(await weiShown(amount(form, 'Client receives'))).toBe(0n)

  // An exact share typed in wei precision; the preview is read back from the page, not recomputed by the test.
  await form.getByLabel("Freelancer's share in ETH", { exact: false }).fill('0.412345678901234567')
  const preview = {
    frozen: await weiShown(amount(form, 'Frozen')),
    fee: await weiShown(amount(form, 'Arbitration fee (1%, rounded down)')),
    freelancer: await weiShown(amount(form, 'Freelancer receives')),
    client: await weiShown(amount(form, 'Client receives')),
  }
  expect(preview.frozen).toBe(frozen)
  expect(preview.fee).toBe(fee)
  expect(preview.freelancer).toBe(parseEther('0.412345678901234567'))
  expect(preview.freelancer + preview.client + preview.fee).toBe(frozen)

  await form.getByRole('button', { name: 'Review resolution' }).click()
  const confirmBox = boxWith(page, 'Resolve this dispute with this split? It is final.')
  expect(await weiShown(amount(confirmBox, 'Freelancer'))).toBe(preview.freelancer)
  expect(await weiShown(amount(confirmBox, 'Client'))).toBe(preview.client)
  expect(await weiShown(amount(confirmBox, 'Your fee (1%)'))).toBe(preview.fee)

  // A rejected wallet prompt changes nothing on-chain.
  await page.evaluate(() => window.testWallet!.rejectNextTransaction())
  await page.getByRole('button', { name: 'Yes, resolve the dispute' }).click()
  await expect(page.getByText('You rejected the request in your wallet.')).toBeVisible()
  expect((await project(id)).status).toBe(ProjectStatus.Disputed)

  // Resolve for real with the same share.
  await page.getByRole('button', { name: 'Resolve dispute' }).click()
  await form.getByLabel("Freelancer's share in ETH", { exact: false }).fill('0.412345678901234567')
  await form.getByRole('button', { name: 'Review resolution' }).click()
  await page.getByRole('button', { name: 'Yes, resolve the dispute' }).click()
  await expect(page.getByText('Dispute resolved. The amounts are credited to the withdrawable balances.')).toBeVisible()

  const [resolved] = (await events('DisputeResolved')).filter((e) => e.args.projectId === id)
  expect(resolved.args.freelancerAmount).toBe(preview.freelancer)
  expect(resolved.args.clientAmount).toBe(preview.client)
  expect(resolved.args.fee).toBe(preview.fee)
  const freelancer = await address(FREELANCER)
  const client = await address(CLIENT)
  const arbitrator = await address(ROLE.arbitrator)
  expect(await credits(id)).toEqual([
    [freelancer, amounts[0], CreditReason.Approval],
    [arbitrator, preview.fee, CreditReason.ArbitrationFee],
    [freelancer, preview.freelancer, CreditReason.DisputeSettlement],
    [client, preview.client, CreditReason.DisputeSettlement],
  ])
  // The approved milestone's credit is untouched by the dispute.
  expect(await withdrawable(FREELANCER)).toBe(amounts[0] + preview.freelancer)
  expect(await withdrawable(CLIENT)).toBe(preview.client)
  expect(await withdrawable(ROLE.arbitrator)).toBe(preview.fee)
  p = await project(id)
  expect(p.status).toBe(ProjectStatus.Resolved)
  expect((await milestones(id)).map((m) => m.status)).toEqual([MilestoneStatus.Approved, MilestoneStatus.Resolved, MilestoneStatus.Resolved])

  // The outcome panel shows the amounts from the event.
  const outcome = boxWith(page, 'Resolved by the arbitrator.')
  expect(await weiShown(amount(outcome, 'Freelancer received'))).toBe(preview.freelancer)
  expect(await weiShown(amount(outcome, 'Client received'))).toBe(preview.client)
  expect(await weiShown(amount(outcome, 'Arbitration fee'))).toBe(preview.fee)

  // The arbitrator withdraws the fee: wallet up by exactly the fee minus gas.
  const escrowBefore = await escrowBalance()
  const before = await provider.getBalance(arbitrator)
  await withdrawAll(page, ROLE.arbitrator)
  const [withdrawn] = (await events('Withdrawn')).filter((e) => e.args.account === arbitrator)
  expect(withdrawn.args.amount).toBe(preview.fee)
  expect(await provider.getBalance(arbitrator)).toBe(before + preview.fee - (await gasPaid(withdrawn.transactionHash)))
  expect(await escrowBalance()).toBe(escrowBefore - preview.fee)
})

test('expired dispute: refused at D − 1, settled with the fallback split at exactly D', async ({ page }) => {
  const FREELANCER = 7
  // An odd-wei submission, so the half split's odd wei goes to the client.
  const amounts = [parseEther('0.500000000000000001'), parseEther('0.2')]
  const id = await createProjectDirect({ client: CLIENT, freelancer: FREELANCER, amounts, reviewDays: 7 })
  await sendAs(FREELANCER, (e) => e.submitMilestone(id, 0, SETUP_CID))

  // This time the freelancer raises it.
  await openAs(page, FREELANCER, `/projects/${id}`)
  await page.getByRole('button', { name: 'Raise a dispute' }).click()
  await page.getByLabel('What is the dispute about?', { exact: false }).fill('The client stopped responding.')
  await page.getByRole('button', { name: 'Review dispute' }).click()
  await page.getByRole('button', { name: 'Yes, raise the dispute' }).click()
  await expect(page.getByText('Dispute raised. The open milestones are frozen until it is settled.')).toBeVisible()
  const D = Number((await project(id)).raisedAt) + ARBITRATION_PERIOD

  // D − 1 and D on-chain for the arbitrator, each in a throwaway snapshot: resolving works at D − 1, not at D.
  let probe = await snapshot()
  await mineAt(D - 2)
  await setNextBlockTimestamp(D - 1)
  await sendAs(ROLE.arbitrator, (e) => e.resolveDispute(id, 0n))
  expect((await project(id)).status).toBe(ProjectStatus.Resolved)
  await revert(probe)
  probe = await snapshot()
  await mineAt(D - 1)
  await expectRevertAt(D, ROLE.arbitrator, (e) => e.resolveDispute(id, 0n, { gasLimit: 500_000 }), 'ArbitrationPeriodEnded')
  await revert(probe)

  // D − 1: the arbitrator can still resolve; the parties' settle button is disabled and the contract refuses it.
  await mineAt(D - 2)
  await page.clock.setFixedTime((D - 1) * 1000)
  await openAs(page, ROLE.arbitrator, `/projects/${id}`)
  await expect(page.getByRole('button', { name: 'Resolve dispute' })).toBeEnabled()
  await openAs(page, CLIENT, `/projects/${id}`)
  await expect(page.getByRole('button', { name: 'Settle expired dispute' })).toBeDisabled()
  await expectRevertAt(D - 1, CLIENT, (e) => e.settleExpiredDispute(id, { gasLimit: 500_000 }), 'ArbitrationPeriodOpen')
  expect((await project(id)).status).toBe(ProjectStatus.Disputed)

  // D: the arbitrator's window has closed; the client settles from the UI in a block mined at exactly D.
  await page.clock.setFixedTime(D * 1000)
  await openAs(page, ROLE.arbitrator, `/projects/${id}`)
  await expect(page.getByRole('button', { name: 'Resolve dispute' })).toBeDisabled()
  await openAs(page, CLIENT, `/projects/${id}`)
  await page.getByRole('button', { name: 'Settle expired dispute' }).click()
  const box = boxWith(page, 'Settle the expired dispute with the fixed fallback split? It is final.')
  const preview = { freelancer: await weiShown(amount(box, 'Freelancer receives')), client: await weiShown(amount(box, 'Client receives')) }
  expect(preview.freelancer).toBe(parseEther('0.25'))
  expect(preview.client).toBe(parseEther('0.450000000000000001'))
  await setNextBlockTimestamp(D)
  await page.getByRole('button', { name: 'Yes, settle the expired dispute' }).click()
  await expect(page.getByText('Expired dispute settled. The amounts are credited to the withdrawable balances.')).toBeVisible()

  const [settled] = (await events('ExpiredDisputeSettled')).filter((e) => e.args.projectId === id)
  expect(await blockTimestampOf(settled.transactionHash)).toBe(D)
  expect(settled.args.freelancerAmount).toBe(preview.freelancer)
  expect(settled.args.clientAmount).toBe(preview.client)
  expect(settled.args.settledBy).toBe(await address(CLIENT))
  expect(await credits(id)).toEqual([
    [await address(FREELANCER), preview.freelancer, CreditReason.DisputeSettlement],
    [await address(CLIENT), preview.client, CreditReason.DisputeSettlement],
  ])
  // No fee without a resolution.
  expect(await withdrawable(ROLE.arbitrator)).toBe(0n)
  expect(preview.freelancer + preview.client).toBe(amounts[0] + amounts[1])
  expect((await project(id)).status).toBe(ProjectStatus.Resolved)
})
