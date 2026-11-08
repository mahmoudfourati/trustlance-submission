import { BrowserProvider, Contract, JsonRpcProvider, toBeHex, zeroPadValue, type ContractRunner, type DeferredTopicFilter, type EventLog, type Log, type Provider } from 'ethers'
import { escrowAbi } from '../contracts/generated/escrowAbi'
import { CHAINS, escrowAddressFor } from './chains'
import type { Eip1193Provider } from './ethereum'
import { fetchInPages } from './logs'
import { buildTimeline, isProjectEvent, type ProjectEventName, type RawTimelineEvent, type Role, type TimelineEntry } from './timeline'

export const PROJECT_STATUSES = ['Open', 'Active', 'Completed', 'Cancelled', 'Disputed', 'Resolved'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export const MILESTONE_STATUSES = ['Pending', 'Submitted', 'Approved', 'Refunded', 'Resolved'] as const
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number]

export type Project = {
  id: bigint
  client: string
  freelancer: string
  arbitrator: string
  feeBps: number
  status: ProjectStatus
  milestoneCount: number
  /** Seconds. */
  reviewWindow: number
  /** Unix seconds. */
  createdAt: number
  /** Unix seconds; the first second at which the freelancer can no longer accept. */
  acceptanceDeadline: number
  /** Unix seconds; 0 until the freelancer accepts. */
  acceptedAt: number
  totalAmount: bigint
  pendingAmount: bigint
  submittedAmount: bigint
  approvedAmount: bigint
  refundedAmount: bigint
  /** Zero address until a dispute is raised. */
  raisedBy: string
  /** Unix seconds; 0 until a dispute is raised. */
  raisedAt: number
  /** The disputed amount, fixed when the dispute is raised (kept after it settles as the record of what was split). */
  frozenAmount: bigint
  /** The part of `frozenAmount` that was in Pending milestones. */
  frozenPendingAmount: bigint
  /** The part of `frozenAmount` that was in Submitted milestones still in review. */
  frozenSubmittedAmount: bigint
  title: string
  description: string
}

/** A dispute as recorded in the project's events. */
export type DisputeRecord = {
  reason: string
  /** How it was settled, once it was. */
  outcome?:
    | { kind: 'resolved'; freelancerAmount: bigint; clientAmount: bigint; fee: bigint }
    | { kind: 'expired'; freelancerAmount: bigint; clientAmount: bigint }
}

export type Milestone = {
  index: number
  amount: bigint
  /** Seconds. */
  deliveryPeriod: number
  /** Unix seconds; 0 until the project is accepted. */
  deliveryDeadline: number
  status: MilestoneStatus
  /** Revision requests so far (at most MAX_REVISIONS). */
  revisionCount: number
  /** Unix seconds of the latest submission; 0 before the first. */
  submittedAt: number
  /** Unix seconds; the first second at which the latest submission counts as approved. */
  reviewDeadline: number
  /** Manifest CID of the latest submission; empty before the first. */
  deliverableCid: string
  /** The note of the latest revision request (event data only), if there was one. */
  revisionNote?: string
  title: string
}

export type PlatformConfig = {
  address: string
  defaultArbitrator: string
  arbitrationFeeBps: number
}

const readProviders = new Map<number, JsonRpcProvider>()

/** A read-only provider for a chain, independent of the user's wallet. */
export function readProviderFor(chainId: number): JsonRpcProvider {
  let provider = readProviders.get(chainId)
  if (!provider) {
    provider = new JsonRpcProvider(CHAINS[chainId].rpcUrl, chainId, { staticNetwork: true })
    readProviders.set(chainId, provider)
  }
  return provider
}

export function escrowContract(chainId: number, runner: ContractRunner): Contract {
  const address = escrowAddressFor(chainId)
  if (!address) throw new Error(`TrustLance isn't deployed on ${CHAINS[chainId]?.name ?? `chain ${chainId}`}.`)
  return new Contract(address, escrowAbi, runner)
}

export async function walletSigner(provider: Eip1193Provider) {
  return new BrowserProvider(provider).getSigner()
}

export async function getPlatformConfig(chainId: number, provider: Provider): Promise<PlatformConfig> {
  const escrow = escrowContract(chainId, provider)
  const [defaultArbitrator, feeBps] = await Promise.all([
    escrow.defaultArbitrator() as Promise<string>,
    escrow.arbitrationFeeBps() as Promise<bigint>,
  ])
  return {
    address: await escrow.getAddress(),
    defaultArbitrator,
    arbitrationFeeBps: Number(feeBps),
  }
}

/** The block range to scan for this contract's logs: from its deployment block to the latest block. */
async function logRange(escrow: Contract): Promise<{ fromBlock: number; toBlock: number }> {
  const provider = escrow.runner?.provider
  if (!provider) throw new Error('The escrow contract has no provider to read logs from.')
  const [fromBlock, toBlock] = await Promise.all([escrow.deploymentBlock() as Promise<bigint>, provider.getBlockNumber()])
  return { fromBlock: Number(fromBlock), toBlock }
}

/** `queryFilter` over the whole contract history, paged to stay inside the RPC's `eth_getLogs` range limit. */
async function queryFilterPaged(
  escrow: Contract,
  chainId: number,
  filter: DeferredTopicFilter,
  range?: { fromBlock: number; toBlock: number },
): Promise<(EventLog | Log)[]> {
  const { fromBlock, toBlock } = range ?? (await logRange(escrow))
  return fetchInPages((from, to) => escrow.queryFilter(filter, from, to), { fromBlock, toBlock, maxRange: CHAINS[chainId].maxLogRange })
}

type ProjectText = { title: string; description: string; milestoneTitles: Map<number, string> }

/** Titles and descriptions are only in event data, so they come from the logs. */
async function loadProjectTexts(escrow: Contract, chainId: number, ids: bigint[]): Promise<Map<bigint, ProjectText>> {
  const texts = new Map<bigint, ProjectText>()
  if (ids.length === 0) return texts
  const range = await logRange(escrow)
  const [created, milestones] = await Promise.all([
    queryFilterPaged(escrow, chainId, escrow.filters.ProjectCreated(ids), range),
    queryFilterPaged(escrow, chainId, escrow.filters.MilestoneDefined(ids), range),
  ])
  for (const log of created) {
    if (!('args' in log)) continue
    texts.set(log.args.projectId, { title: log.args.title, description: log.args.description, milestoneTitles: new Map() })
  }
  for (const log of milestones) {
    if (!('args' in log)) continue
    texts.get(log.args.projectId)?.milestoneTitles.set(Number(log.args.index), log.args.title)
  }
  return texts
}

type DecodedEvent = Omit<RawTimelineEvent, 'timestamp' | 'from'> & { blockHash: string }

/**
 * Every event of one project, in chain order. Most events index the project id as their first topic;
 * `BalanceCredited` indexes the account first and the project id second, so it needs its own query.
 */
async function loadProjectEvents(
  escrow: Contract,
  provider: Provider,
  chainId: number,
  id: bigint,
): Promise<{ events: DecodedEvent[]; latestBlock: number }> {
  const address = await escrow.getAddress()
  const range = await logRange(escrow)
  const idTopic = zeroPadValue(toBeHex(id), 32)
  const creditTopic = escrow.interface.getEvent('BalanceCredited')!.topicHash
  const scan = (topics: (string | null)[]) =>
    fetchInPages((fromBlock, toBlock) => provider.getLogs({ address, topics, fromBlock, toBlock }), {
      ...range,
      maxRange: CHAINS[chainId].maxLogRange,
    })
  const logs = (await Promise.all([scan([null, idTopic]), scan([creditTopic, null, idTopic])])).flat()

  const events: DecodedEvent[] = []
  for (const log of logs) {
    const parsed = escrow.interface.parseLog(log)
    // The first query also matches events whose first indexed value merely equals the id (e.g. an account), so
    // keep only project events that really carry this project id.
    if (!parsed || !isProjectEvent(parsed.name) || parsed.args.projectId !== id) continue
    events.push({
      name: parsed.name as ProjectEventName,
      args: parsed.args.toObject(),
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      logIndex: log.index,
      transactionHash: log.transactionHash,
    })
  }
  events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
  return { events, latestBlock: range.toBlock }
}

// Block timestamps (by block hash, so a reorged block is fetched again) and transaction senders never change. The
// promise is cached, so the many events of one transaction share a single request; a failed request is forgotten.
const blockTimestamps = new Map<string, Promise<number>>()
const transactionSenders = new Map<string, Promise<string>>()

function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let value = cache.get(key)
  if (!value) {
    value = load()
    cache.set(key, value)
    value.catch(() => cache.delete(key))
  }
  return value
}

function blockTimestamp(provider: Provider, blockHash: string): Promise<number> {
  return cached(blockTimestamps, blockHash, async () => {
    const block = await provider.getBlock(blockHash)
    if (!block) throw new Error(`Block ${blockHash} is no longer available.`)
    return block.timestamp
  })
}

function transactionSender(provider: Provider, hash: string): Promise<string> {
  return cached(transactionSenders, hash, async () => {
    const tx = await provider.getTransaction(hash)
    if (!tx) throw new Error(`Transaction ${hash} is no longer available.`)
    return tx.from
  })
}

type RawProject = {
  client: string
  freelancer: string
  arbitrator: string
  feeBps: bigint
  status: bigint
  milestoneCount: bigint
  reviewWindow: bigint
  createdAt: bigint
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

type RawMilestone = {
  amount: bigint
  deliveryPeriod: bigint
  deliveryDeadline: bigint
  status: bigint
  revisionCount: bigint
  submittedAt: bigint
  reviewDeadline: bigint
  deliverableCid: string
}

function toProject(id: bigint, raw: RawProject, text: ProjectText | undefined): Project {
  return {
    id,
    client: raw.client,
    freelancer: raw.freelancer,
    arbitrator: raw.arbitrator,
    feeBps: Number(raw.feeBps),
    status: PROJECT_STATUSES[Number(raw.status)],
    milestoneCount: Number(raw.milestoneCount),
    reviewWindow: Number(raw.reviewWindow),
    createdAt: Number(raw.createdAt),
    acceptanceDeadline: Number(raw.acceptanceDeadline),
    acceptedAt: Number(raw.acceptedAt),
    totalAmount: raw.totalAmount,
    pendingAmount: raw.pendingAmount,
    submittedAmount: raw.submittedAmount,
    approvedAmount: raw.approvedAmount,
    refundedAmount: raw.refundedAmount,
    raisedBy: raw.raisedBy,
    raisedAt: Number(raw.raisedAt),
    frozenAmount: raw.frozenAmount,
    frozenPendingAmount: raw.frozenPendingAmount,
    frozenSubmittedAmount: raw.frozenSubmittedAmount,
    title: text?.title ?? `Project #${id}`,
    description: text?.description ?? '',
  }
}

export async function getProjectsByIds(chainId: number, provider: Provider, ids: bigint[]): Promise<Project[]> {
  const escrow = escrowContract(chainId, provider)
  const [raws, texts] = await Promise.all([
    Promise.all(ids.map((id) => escrow.getProject(id) as Promise<RawProject>)),
    loadProjectTexts(escrow, chainId, ids),
  ])
  return ids.map((id, i) => toProject(id, raws[i], texts.get(id)))
}

export async function getClientProjects(chainId: number, provider: Provider, account: string): Promise<Project[]> {
  const escrow = escrowContract(chainId, provider)
  const ids = [...((await escrow.projectIdsAsClient(account)) as bigint[])].reverse()
  return getProjectsByIds(chainId, provider, ids)
}

export async function getFreelancerProjects(chainId: number, provider: Provider, account: string): Promise<Project[]> {
  const escrow = escrowContract(chainId, provider)
  const ids = [...((await escrow.projectIdsAsFreelancer(account)) as bigint[])].reverse()
  return getProjectsByIds(chainId, provider, ids)
}

/** Projects that name `account` as their arbitrator, newest first, with each dispute's reason. */
export async function getArbitratorProjects(
  chainId: number,
  provider: Provider,
  account: string,
): Promise<{ project: Project; reason?: string }[]> {
  const escrow = escrowContract(chainId, provider)
  const ids = [...((await escrow.projectIdsAsArbitrator(account)) as bigint[])].reverse()
  if (ids.length === 0) return []
  const [projects, raised] = await Promise.all([
    getProjectsByIds(chainId, provider, ids),
    queryFilterPaged(escrow, chainId, escrow.filters.DisputeRaised(ids)),
  ])
  // A project has at most one dispute.
  const reasons = new Map<bigint, string>()
  for (const log of raised) if ('args' in log) reasons.set(log.args.projectId, log.args.reason)
  return projects.map((project) => ({ project, reason: reasons.get(project.id) }))
}

export async function getWithdrawable(chainId: number, provider: Provider, account: string): Promise<bigint> {
  return (await escrowContract(chainId, provider).withdrawable(account)) as bigint
}

export async function getProjectDetail(
  chainId: number,
  provider: Provider,
  id: bigint,
): Promise<{ project: Project; milestones: Milestone[]; timeline: TimelineEntry[]; dispute?: DisputeRecord }> {
  const escrow = escrowContract(chainId, provider)
  // The project's logs are read once and give the titles, the revision notes and the timeline.
  const [raw, rawMilestones, { events, latestBlock }] = await Promise.all([
    escrow.getProject(id) as Promise<RawProject>,
    escrow.getMilestones(id) as Promise<RawMilestone[]>,
    loadProjectEvents(escrow, provider, chainId, id),
  ])

  let text: ProjectText | undefined
  const notes = new Map<number, string>()
  let dispute: DisputeRecord | undefined
  for (const { name, args } of events) {
    if (name === 'ProjectCreated') text = { title: String(args.title), description: String(args.description), milestoneTitles: new Map() }
    if (name === 'MilestoneDefined') text?.milestoneTitles.set(Number(args.index), String(args.title))
    // Events are in chain order, so a later revision note replaces an earlier one.
    if (name === 'RevisionRequested') notes.set(Number(args.index), String(args.note))
    if (name === 'DisputeRaised') dispute = { reason: String(args.reason) }
    if (name === 'DisputeResolved' && dispute) {
      dispute.outcome = {
        kind: 'resolved',
        freelancerAmount: args.freelancerAmount as bigint,
        clientAmount: args.clientAmount as bigint,
        fee: args.fee as bigint,
      }
    }
    if (name === 'ExpiredDisputeSettled' && dispute) {
      dispute.outcome = { kind: 'expired', freelancerAmount: args.freelancerAmount as bigint, clientAmount: args.clientAmount as bigint }
    }
  }
  const project = toProject(id, raw, text)

  const [timestamps, senders] = await Promise.all([
    Promise.all(events.map((e) => blockTimestamp(provider, e.blockHash))),
    Promise.all(events.map((e) => transactionSender(provider, e.transactionHash))),
  ])
  const roles = new Map<string, Role>([
    [project.arbitrator.toLowerCase(), 'arbitrator'],
    [project.freelancer.toLowerCase(), 'freelancer'],
    [project.client.toLowerCase(), 'client'],
  ])
  const timeline = buildTimeline(
    events.map(({ blockHash: _blockHash, ...event }, i) => ({ ...event, timestamp: timestamps[i], from: senders[i] })),
    {
      latestBlock,
      confirmations: CHAINS[chainId].confirmations,
      ctx: {
        milestoneTitle: (index) => text?.milestoneTitles.get(index) ?? `Milestone ${index + 1}`,
        roleOf: (address) => roles.get(address.toLowerCase()),
      },
    },
  )

  return {
    project,
    timeline,
    dispute,
    milestones: rawMilestones.map((m, index) => ({
      index,
      amount: m.amount,
      deliveryPeriod: Number(m.deliveryPeriod),
      deliveryDeadline: Number(m.deliveryDeadline),
      status: MILESTONE_STATUSES[Number(m.status)],
      revisionCount: Number(m.revisionCount),
      submittedAt: Number(m.submittedAt),
      reviewDeadline: Number(m.reviewDeadline),
      deliverableCid: m.deliverableCid,
      revisionNote: notes.get(index),
      title: text?.milestoneTitles.get(index) ?? `Milestone ${index + 1}`,
    })),
  }
}
