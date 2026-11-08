// Ticket 12: create → accept → submit (encrypted) → client download and decrypt → approve → withdraw, with every
// amount checked in wei against the chain and the deliverable checked in the pinning store.
import { parseEther } from 'ethers'
import {
  CreditReason,
  MilestoneStatus,
  ProjectStatus,
  address,
  escrowBalance,
  events,
  gasPaid,
  milestones,
  project,
  projectEvents,
  provider,
  withdrawable,
} from './chain.ts'
import { expect, milestoneRow, openAs, test } from './fixtures.ts'
import { acceptProject, approveMilestone, createProject, submitDeliverable, withdrawAll } from './flows.ts'
import { E2E } from './ports.ts'

const CLIENT = 2
const FREELANCER = 3
const SECRET = 'correct horse battery staple'
const LOGO = { name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><title>TrustLance e2e logo</title></svg>') }
const SITE = { name: 'site.txt', mimeType: 'text/plain', buffer: Buffer.from('Public deliverable for milestone 2.') }

type Pin = { cid: string; name: string; type: string; base64: string }
const pins = async () => (await (await fetch(`${E2E.storeUrl}/pins`)).json()) as Pin[]
const pinned = async (cid: string) => (await pins()).find((p) => p.cid === cid)

test('create, accept, encrypted submission, download, approve and withdraw settle every wei', async ({ page }) => {
  const client = await address(CLIENT)
  const freelancer = await address(FREELANCER)
  const clientEthBefore = await provider.getBalance(client)
  const escrowBefore = await escrowBalance()

  // Create and fund: the escrow holds exactly the milestone total, taken from the client's wallet.
  const id = await createProject(page, {
    client: CLIENT,
    freelancer: FREELANCER,
    title: 'Brand refresh',
    milestones: [
      { title: 'Logo', eth: '1.25', days: 3 },
      { title: 'Website', eth: '0.75', days: 5 },
    ],
  })
  const total = parseEther('2')
  let p = await project(id)
  expect(p.status).toBe(ProjectStatus.Open)
  expect(p.client).toBe(client)
  expect(p.freelancer).toBe(freelancer)
  expect(p.totalAmount).toBe(total)
  expect((await milestones(id)).map((m) => m.amount)).toEqual([parseEther('1.25'), parseEther('0.75')])
  expect(await escrowBalance()).toBe(escrowBefore + total)
  const [created] = (await events('ProjectCreated')).filter((e) => e.args.projectId === id)
  expect(await provider.getBalance(client)).toBe(clientEthBefore - total - (await gasPaid(created.transactionHash)))

  await acceptProject(page, FREELANCER, id)
  expect((await project(id)).status).toBe(ProjectStatus.Active)

  // Encrypted submission: the store only ever receives ciphertext, and the chain records the manifest CID.
  await submitDeliverable(page, { freelancer: FREELANCER, id, number: 1, title: 'Logo', file: LOGO, passphrase: SECRET })
  let [logo] = await milestones(id)
  expect(logo.status).toBe(MilestoneStatus.Submitted)
  const manifestPin = await pinned(logo.deliverableCid)
  expect(manifestPin, 'the on-chain CID is pinned').toBeDefined()
  const manifest = JSON.parse(Buffer.from(manifestPin!.base64, 'base64').toString('utf8')) as {
    schema: string
    fileCid: string
    size: number
    sha256: string
    encryption?: unknown
  }
  expect(manifest.schema).toBe('trustlance.deliverable')
  expect(manifest.encryption).toBeDefined()
  const filePin = await pinned(manifest.fileCid)
  expect(filePin, 'the manifest points at a pinned file').toBeDefined()
  const stored = Buffer.from(filePin!.base64, 'base64')
  expect(stored.includes(LOGO.buffer)).toBe(false)
  expect(stored.includes(Buffer.from('TrustLance e2e logo'))).toBe(false)

  // The client downloads it: a wrong passphrase is refused, the right one yields the exact original bytes.
  await openAs(page, CLIENT, `/projects/${id}`)
  const row = milestoneRow(page, 1, 'Logo')
  await row.getByRole('button', { name: 'Open deliverable' }).click()
  await row.getByLabel('Passphrase from the freelancer').fill('wrong passphrase')
  await row.getByRole('button', { name: 'Decrypt and download' }).click()
  await expect(row.getByText("That passphrase doesn't unlock this deliverable.", { exact: false })).toBeVisible()
  await expect(row.getByText('Downloaded.', { exact: false })).toHaveCount(0)
  await row.getByLabel('Passphrase from the freelancer').fill(SECRET)
  const downloadEvent = page.waitForEvent('download')
  await row.getByRole('button', { name: 'Decrypt and download' }).click()
  const download = await downloadEvent
  expect(download.suggestedFilename()).toBe(LOGO.name)
  const { readFile } = await import('node:fs/promises')
  expect(Buffer.compare(await readFile(await download.path()), LOGO.buffer)).toBe(0)
  await expect(row.getByText('Downloaded. The file matched the SHA-256 the freelancer committed to.')).toBeVisible()

  await approveMilestone(page, CLIENT, id, 1, 'Logo')
  ;[logo] = await milestones(id)
  expect(logo.status).toBe(MilestoneStatus.Approved)
  expect(await withdrawable(FREELANCER)).toBe(parseEther('1.25'))
  const credits = (await events('BalanceCredited')).filter((e) => e.args.projectId === id)
  expect(credits.map((e) => [e.args.account, e.args.amount, e.args.reason])).toEqual([[freelancer, parseEther('1.25'), CreditReason.Approval]])

  // Second milestone, unencrypted, then approval completes the project.
  await submitDeliverable(page, { freelancer: FREELANCER, id, number: 2, title: 'Website', file: SITE })
  await approveMilestone(page, CLIENT, id, 2, 'Website')
  p = await project(id)
  expect(p.status).toBe(ProjectStatus.Completed)
  expect(p.approvedAmount).toBe(total)
  expect(await withdrawable(FREELANCER)).toBe(total)
  expect(await withdrawable(CLIENT)).toBe(0n)

  // Withdraw: the freelancer's wallet gains exactly the balance minus gas, and the escrow is back where it started.
  const freelancerEthBefore = await provider.getBalance(freelancer)
  await withdrawAll(page, FREELANCER)
  expect(await withdrawable(FREELANCER)).toBe(0n)
  const [withdrawn] = (await events('Withdrawn')).filter((e) => e.args.account === freelancer)
  expect(withdrawn.args.amount).toBe(total)
  expect(await provider.getBalance(freelancer)).toBe(freelancerEthBefore + total - (await gasPaid(withdrawn.transactionHash)))
  expect(await escrowBalance()).toBe(escrowBefore)

  // The project page and timeline show the outcome from the chain's own events.
  await openAs(page, CLIENT, `/projects/${id}`)
  await expect(page.getByText('This project is complete', { exact: false })).toBeVisible()
  await expect(page.getByText('Project completed: every milestone is settled')).toBeVisible()
  await openAs(page, FREELANCER, '/')
  await expect(page.getByRole('link').filter({ has: page.getByRole('heading', { name: 'Brand refresh' }) }).getByText('Completed', { exact: true })).toBeVisible()
  const names = (await projectEvents(id)).map((e) => e.eventName)
  expect(names).toEqual([
    'ProjectCreated',
    'MilestoneDefined',
    'MilestoneDefined',
    'ProjectAccepted',
    'MilestoneSubmitted',
    'MilestoneApproved',
    'BalanceCredited',
    'MilestoneSubmitted',
    'MilestoneApproved',
    'BalanceCredited',
    'ProjectCompleted',
  ])
})
