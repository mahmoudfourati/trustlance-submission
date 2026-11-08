// Direct access to the end-to-end chain for setup and for assertions. The app under test never sees this module; every
// value a test asserts is read back from the node after real transactions.
import { Contract, JsonRpcProvider, getAddress, type EventLog, type JsonRpcSigner } from 'ethers'
import { escrowAbi } from '../src/contracts/generated/escrowAbi.ts'
import { escrowAddresses } from '../src/contracts/generated/deployments.ts'
import { E2E } from './ports.ts'

export const provider = new JsonRpcProvider(E2E.chainUrl, 31337, { staticNetwork: true, cacheTimeout: -1 })
export const escrowAddress = escrowAddresses[31337]
export const escrow = new Contract(escrowAddress, escrowAbi, provider)

/** Hardhat's default accounts (checksummed, as the contract returns them), in the deployment's roles (see the Ignition module). */
export const ROLE = { admin: 0, arbitrator: 1 } as const

let accountsCache: string[] | undefined
export async function accounts(): Promise<string[]> {
  accountsCache ??= ((await provider.send('eth_accounts', [])) as string[]).map((a) => getAddress(a))
  return accountsCache
}

export async function address(index: number): Promise<string> {
  return (await accounts())[index]
}

export function signer(index: number): Promise<JsonRpcSigner> {
  return provider.getSigner(index)
}

/** The escrow connected to a local account, for setup steps that aren't the behaviour under test. */
export async function escrowAs(index: number): Promise<Contract> {
  return escrow.connect(await signer(index)) as Contract
}

export async function latestTimestamp(): Promise<number> {
  const block = await provider.getBlock('latest')
  return block!.timestamp
}

/** Mines the next block, or the next transaction, at exactly `timestamp`. */
export async function setNextBlockTimestamp(timestamp: number): Promise<void> {
  await provider.send('evm_setNextBlockTimestamp', [timestamp])
}

/** Mines an empty block at exactly `timestamp`, so views and the browser see the new time. */
export async function mineAt(timestamp: number): Promise<void> {
  await setNextBlockTimestamp(timestamp)
  await provider.send('evm_mine', [])
}

export async function snapshot(): Promise<string> {
  return (await provider.send('evm_snapshot', [])) as string
}

export async function revert(id: string): Promise<void> {
  const ok = (await provider.send('evm_revert', [id])) as boolean
  if (!ok) throw new Error(`evm_revert(${id}) failed`)
}

export type ProjectView = {
  client: string
  freelancer: string
  arbitrator: string
  feeBps: bigint
  status: bigint
  reviewWindow: bigint
  acceptanceDeadline: bigint
  acceptedAt: bigint
  totalAmount: bigint
  pendingAmount: bigint
  submittedAmount: bigint
  approvedAmount: bigint
  refundedAmount: bigint
  raisedBy: string
  raisedAt: bigint
  frozenAmount: bigint
  frozenPendingAmount: bigint
  frozenSubmittedAmount: bigint
}

export type MilestoneView = {
  amount: bigint
  status: bigint
  deliveryPeriod: bigint
  deliveryDeadline: bigint
  revisionCount: bigint
  submittedAt: bigint
  reviewDeadline: bigint
  deliverableCid: string
}

export async function project(id: bigint): Promise<ProjectView> {
  return (await escrow.getProject(id)) as ProjectView
}

export async function milestones(id: bigint): Promise<MilestoneView[]> {
  return (await escrow.getMilestones(id)) as MilestoneView[]
}

export async function withdrawable(index: number): Promise<bigint> {
  return (await escrow.withdrawable(await address(index))) as bigint
}

export async function projectCount(): Promise<bigint> {
  return (await escrow.projectCount()) as bigint
}

/** Every escrow event for one project, oldest first, with the transaction that emitted it. */
export async function projectEvents(id: bigint): Promise<EventLog[]> {
  const logs = (await escrow.queryFilter('*', 0, 'latest')) as EventLog[]
  return logs.filter((log) => 'args' in log && log.args && 'projectId' in log.args.toObject() && log.args.projectId === id)
}

/** A project's balance credits, oldest first, as [account, amount, reason]. */
export async function credits(id: bigint): Promise<[string, bigint, bigint][]> {
  return (await events('BalanceCredited'))
    .filter((e) => e.args.projectId === id)
    .map((e) => [e.args.account as string, e.args.amount as bigint, e.args.reason as bigint])
}

export async function events(name: string): Promise<EventLog[]> {
  return (await escrow.queryFilter(escrow.filters[name]!(), 0, 'latest')) as EventLog[]
}

/** Balance of the escrow contract itself: what it still holds for every project and every withdrawable balance. */
export async function escrowBalance(): Promise<bigint> {
  return provider.getBalance(escrowAddress)
}

export const MilestoneStatus = { Pending: 0n, Submitted: 1n, Approved: 2n, Refunded: 3n, Resolved: 4n } as const
export const ProjectStatus = { Open: 0n, Active: 1n, Completed: 2n, Cancelled: 3n, Disputed: 4n, Resolved: 5n } as const
export const CreditReason = { Refund: 0n, Approval: 1n, ArbitrationFee: 2n, DisputeSettlement: 3n } as const

function revertName(error: unknown): string | undefined {
  const parsed = (error as { revert?: { name?: string } }).revert?.name
  if (parsed) return parsed
  for (let e: unknown = error; e && typeof e === 'object'; e = (e as { error?: unknown }).error) {
    const data = (e as { data?: unknown }).data
    if (typeof data === 'string' && data.startsWith('0x')) return escrow.interface.parseError(data)?.name
  }
  return undefined
}

/**
 * Sends a transaction from a local account at exactly `timestamp` (with a fixed gas limit, so it is mined rather than
 * stopped at gas estimation) and checks that the contract rejects it with the custom error `expected`.
 */
export async function expectRevertAt(
  timestamp: number,
  account: number,
  call: (escrow: Contract) => Promise<unknown>,
  expected: string,
): Promise<void> {
  await setNextBlockTimestamp(timestamp)
  const connected = await escrowAs(account)
  let name: string | undefined
  try {
    const tx = (await call(connected)) as { wait(): Promise<unknown> }
    await tx.wait()
  } catch (error) {
    name = revertName(error)
    if (name !== expected) throw new Error(`Expected ${expected}, got ${name ?? 'an undecoded error'}: ${String(error)}`)
  }
  if (name === undefined) throw new Error(`Expected ${expected}, but the transaction succeeded`)
  const latest = await latestTimestamp()
  if (latest !== timestamp) throw new Error(`The rejected transaction was checked at ${latest}, not ${timestamp}`)
}

/** Gas paid by a transaction: what the sender's ETH balance moved by besides the value. */
export async function gasPaid(hash: string): Promise<bigint> {
  const receipt = (await provider.getTransactionReceipt(hash))!
  return receipt.gasUsed * receipt.gasPrice
}

export async function blockTimestampOf(hash: string): Promise<number> {
  const receipt = (await provider.getTransactionReceipt(hash))!
  return (await provider.getBlock(receipt.blockNumber))!.timestamp
}

const DAY = 24 * 60 * 60
/** A syntactically valid manifest CID for setup steps that don't exercise the upload path. */
export const SETUP_CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq'

/**
 * Creates and funds a project straight through the contract, for scenarios whose subject comes later (forfeit, disputes).
 * The create → accept path itself is driven through the UI in the happy-path scenario.
 */
export async function createProjectDirect({
  client,
  freelancer,
  amounts,
  reviewDays = 7,
  deliveryDays = 5,
  accept = true,
  title = 'Setup project',
}: {
  client: number
  freelancer: number
  amounts: bigint[]
  reviewDays?: number
  deliveryDays?: number
  accept?: boolean
  title?: string
}): Promise<bigint> {
  const params = {
    freelancer: await address(freelancer),
    acceptanceDeadline: (await latestTimestamp()) + 7 * DAY,
    reviewWindow: reviewDays * DAY,
    title,
    description: '',
    milestones: amounts.map((amount, i) => ({ amount, deliveryPeriod: deliveryDays * DAY, title: `Milestone ${i + 1}` })),
  }
  const total = amounts.reduce((a, b) => a + b, 0n)
  await sendAs(client, (escrow) => escrow.createProject(params, { value: total }))
  const id = await projectCount()
  if (accept) await sendAs(freelancer, (escrow) => escrow.acceptProject(id))
  return id
}

/** Runs one contract call from a local account and waits for it to be mined. */
export async function sendAs(account: number, call: (escrow: Contract) => Promise<unknown>): Promise<void> {
  await ((await call(await escrowAs(account))) as { wait(): Promise<unknown> }).wait()
}
