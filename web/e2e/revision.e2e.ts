// Ticket 12: the revision loop up to its limit of two, then auto-approval at the review deadline, with the UI and the
// contract both checked at D − 1 (still in review) and at exactly D (counts as approved).
import { parseEther } from 'ethers'
import {
  MilestoneStatus,
  ProjectStatus,
  blockTimestampOf,
  events,
  expectRevertAt,
  milestones,
  mineAt,
  project,
  revert,
  setNextBlockTimestamp,
  snapshot,
  withdrawable,
} from './chain.ts'
import { expect, milestoneRow, openAs, test } from './fixtures.ts'
import { acceptProject, createProject, submitDeliverable } from './flows.ts'

const CLIENT = 2
const FREELANCER = 4
const report = (version: number) => ({ name: `report-v${version}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`Report, version ${version}`) })

test('two revision requests, then auto-approval exactly at the review deadline', async ({ page }) => {
  const id = await createProject(page, {
    client: CLIENT,
    freelancer: FREELANCER,
    title: 'Market report',
    reviewDays: 3,
    milestones: [{ title: 'Report', eth: '0.5', days: 2 }],
  })
  await acceptProject(page, FREELANCER, id)

  for (const [round, note] of [
    [1, 'Please add the 2025 figures.'],
    [2, 'The chart labels are still missing.'],
  ] as const) {
    await submitDeliverable(page, { freelancer: FREELANCER, id, number: 1, title: 'Report', file: report(round) })

    await openAs(page, CLIENT, `/projects/${id}`)
    const row = milestoneRow(page, 1, 'Report')
    await expect(row.getByText(`${3 - round} of 2 revision requests left`)).toBeVisible()
    await row.getByRole('button', { name: 'Request revision' }).click()
    await row.getByLabel('What needs to change?', { exact: false }).fill(note)
    await row.getByRole('button', { name: 'Request revision' }).click()
    await expect(row.getByText('Revision requested. The milestone is back with the freelancer.')).toBeVisible()

    const [m] = await milestones(id)
    expect(m.status).toBe(MilestoneStatus.Pending)
    expect(m.revisionCount).toBe(BigInt(round))
    const requested = (await events('RevisionRequested')).filter((e) => e.args.projectId === id)
    expect(requested.at(-1)!.args.note).toBe(note)

    // The freelancer sees the note on their next visit.
    await openAs(page, FREELANCER, `/projects/${id}`)
    await expect(milestoneRow(page, 1, 'Report').getByText(note)).toBeVisible()
  }

  // Third submission: no revision request is left, so the client can only approve or wait.
  await submitDeliverable(page, { freelancer: FREELANCER, id, number: 1, title: 'Report', file: report(3) })
  const [submitted] = await milestones(id)
  const D = Number(submitted.reviewDeadline)
  await openAs(page, CLIENT, `/projects/${id}`)
  let row = milestoneRow(page, 1, 'Report')
  await expect(row.getByRole('button', { name: 'Request revision' })).toBeDisabled()
  await expect(row.getByText("You've used both revision requests.", { exact: false })).toBeVisible()

  // D − 1: the review window is still open. The UI offers approval, not auto-approval, and the contract agrees.
  await mineAt(D - 2)
  await page.clock.setFixedTime((D - 1) * 1000)
  await openAs(page, CLIENT, `/projects/${id}`)
  row = milestoneRow(page, 1, 'Report')
  await expect(row.getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: 'Record auto-approval' })).toHaveCount(0)
  await expectRevertAt(D - 1, FREELANCER, (e) => e.finalizeAutoApproval(id, 0, { gasLimit: 500_000 }), 'ReviewWindowOpen')
  expect((await milestones(id))[0].status).toBe(MilestoneStatus.Submitted)

  // D: the review window has closed on-chain; a revision request is refused for the deadline (checked before the
  // revision limit), in a throwaway snapshot so the UI step below still lands exactly on D. Approval has no deadline by
  // design (spec, as built in ticket 05): late approval and auto-approval credit the same amount.
  const probe = await snapshot()
  await expectRevertAt(D, CLIENT, (e) => e.requestRevision(id, 0, 'too late', { gasLimit: 500_000 }), 'ReviewWindowClosed')
  await revert(probe)

  // D: the submission counts as approved; the freelancer records it from the UI in a block mined at exactly D.
  await page.clock.setFixedTime(D * 1000)
  await openAs(page, FREELANCER, `/projects/${id}`)
  row = milestoneRow(page, 1, 'Report')
  await setNextBlockTimestamp(D)
  await row.getByRole('button', { name: 'Record auto-approval' }).click()
  await expect(row.getByText("Auto-approval recorded. The amount is in the freelancer's withdrawable balance.")).toBeVisible()

  const [approved] = (await events('MilestoneApproved')).filter((e) => e.args.projectId === id)
  expect(approved.args.automatic).toBe(true)
  expect(await blockTimestampOf(approved.transactionHash)).toBe(D)
  expect((await milestones(id))[0].status).toBe(MilestoneStatus.Approved)
  expect((await project(id)).status).toBe(ProjectStatus.Completed)
  expect(await withdrawable(FREELANCER)).toBe(parseEther('0.5'))
  expect(await withdrawable(CLIENT)).toBe(0n)
})
