import { formatDateTime, formatDuration, formatEth, shortAddress } from './format'
import { MAX_REVISIONS } from './limits'

/** Every contract event that carries a project id, and so belongs on a project's timeline. */
export const PROJECT_EVENTS = [
  'ProjectCreated',
  'MilestoneDefined',
  'ProjectAccepted',
  'ProjectDeclined',
  'ProjectCancelled',
  'MilestoneSubmitted',
  'RevisionRequested',
  'MilestoneApproved',
  'MilestoneRefunded',
  'ProjectForfeited',
  'ProjectCompleted',
  'BalanceCredited',
  'DisputeRaised',
  'DisputeResolved',
  'ExpiredDisputeSettled',
] as const

export type ProjectEventName = (typeof PROJECT_EVENTS)[number]

export type Role = 'client' | 'freelancer' | 'arbitrator'

export type DescribeContext = {
  milestoneTitle: (index: number) => string
  roleOf: (address: string) => Role | undefined
}

export type EventDescription = {
  title: string
  detail?: string
  /**
   * The project reached a final state with this event: Completed (`ProjectCompleted`, or `ProjectForfeited`, which
   * replaces it) or Resolved (`DisputeResolved`).
   */
  endsProject?: boolean
}

type Args = Record<string, unknown>

// Mirrors the contract's CreditReason enum.
const CREDIT_REASONS = ['refund', 'approval', 'arbitration fee', 'dispute settlement']

function milestoneLabel(args: Args, ctx: DescribeContext): string {
  const index = Number(args.index)
  return `milestone ${index + 1} (${ctx.milestoneTitle(index)})`
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const DESCRIBERS: Record<ProjectEventName, (args: Args, ctx: DescribeContext) => EventDescription> = {
  ProjectCreated: (a) => ({ title: `Project created and funded with ${formatEth(a.totalAmount as bigint)}` }),
  MilestoneDefined: (a) => ({
    title: `Milestone ${Number(a.index) + 1} defined: ${String(a.title)} (${formatEth(a.amount as bigint)}, ${formatDuration(
      Number(a.deliveryPeriod),
    )} to deliver)`,
  }),
  ProjectAccepted: () => ({ title: 'Freelancer accepted; delivery periods started' }),
  ProjectDeclined: () => ({ title: 'Freelancer declined the project' }),
  ProjectCancelled: () => ({ title: 'Client cancelled the project before acceptance' }),
  MilestoneSubmitted: (a, ctx) => ({
    title: `${capitalise(milestoneLabel(a, ctx))} submitted for review`,
    // The review window is half-open, so its last second is reviewDeadline - 1.
    detail: `Deliverable manifest ${String(a.cid)}. The client can review it until ${formatDateTime(Number(a.reviewDeadline) - 1)}.`,
  }),
  RevisionRequested: (a, ctx) => {
    const deadline = `New delivery deadline: ${formatDateTime(Number(a.deliveryDeadline))}.`
    return {
      title: `Revision ${Number(a.revisionCount)} of ${MAX_REVISIONS} requested on ${milestoneLabel(a, ctx)}`,
      detail: a.note ? `${String(a.note)}\n${deadline}` : deadline,
    }
  },
  // Approvals and refunds only name the amount: the BalanceCredited entry that follows says whose balance got it.
  MilestoneApproved: (a, ctx) => ({
    title: `${capitalise(milestoneLabel(a, ctx))} ${a.automatic ? 'auto-approved after the review window' : 'approved'} (${formatEth(
      a.amount as bigint,
    )})`,
  }),
  MilestoneRefunded: (a, ctx) => ({
    title: `${capitalise(milestoneLabel(a, ctx))} refunded (${formatEth(a.amount as bigint)})`,
  }),
  ProjectForfeited: (a) => ({
    title: 'Freelancer forfeited; project completed',
    detail: `${formatEth(a.creditedAmount as bigint)} of expired reviews credited to the freelancer, ${formatEth(
      a.refundedAmount as bigint,
    )} refunded to the client.`,
    endsProject: true,
  }),
  ProjectCompleted: () => ({ title: 'Project completed: every milestone is settled', endsProject: true }),
  DisputeRaised: (a, ctx) => {
    const by = String(a.raisedBy)
    const role = ctx.roleOf(by)
    return {
      title: `${role ? capitalise(role) : shortAddress(by)} raised a dispute; ${formatEth(a.frozenAmount as bigint)} is frozen`,
      // The arbitration period is half-open: the arbitrator's last second is arbitrationDeadline - 1.
      detail: `${String(a.reason)}\nThe arbitrator can resolve it until ${formatDateTime(Number(a.arbitrationDeadline) - 1)}.`,
    }
  },
  DisputeResolved: (a) => ({
    title: `Arbitrator resolved the dispute: ${formatEth(a.freelancerAmount as bigint)} to the freelancer, ${formatEth(
      a.clientAmount as bigint,
    )} to the client, ${formatEth(a.fee as bigint)} fee`,
    endsProject: true,
  }),
  ExpiredDisputeSettled: (a, ctx) => {
    const by = String(a.settledBy)
    const role = ctx.roleOf(by)
    return {
      title: `${role ? capitalise(role) : shortAddress(by)} settled the expired dispute with the fixed fallback split: ${formatEth(
        a.freelancerAmount as bigint,
      )} to the freelancer, ${formatEth(a.clientAmount as bigint)} to the client`,
      detail: 'Frozen pending milestones go back to the client, frozen submissions are split in half, and no fee is charged.',
      endsProject: true,
    }
  },
  BalanceCredited: (a, ctx) => {
    const account = String(a.account)
    const role = ctx.roleOf(account)
    const reason = CREDIT_REASONS[Number(a.reason)]
    return {
      title: `${formatEth(a.amount as bigint)} credited to ${role ? `the ${role}` : shortAddress(account)}'s withdrawable balance${
        reason ? ` (${reason})` : ''
      }`,
    }
  },
}

export function isProjectEvent(name: string): name is ProjectEventName {
  return (PROJECT_EVENTS as readonly string[]).includes(name)
}

export function describeEvent(name: ProjectEventName, args: Args, ctx: DescribeContext): EventDescription {
  return DESCRIBERS[name](args, ctx)
}

/** One decoded log plus the block and transaction data the timeline shows. */
export type RawTimelineEvent = {
  name: ProjectEventName
  args: Args
  blockNumber: number
  logIndex: number
  transactionHash: string
  /** Unix seconds of the block. */
  timestamp: number
  /** The account that sent the transaction. */
  from: string
}

export type TimelineEntry = RawTimelineEvent &
  EventDescription & {
    key: string
    /** The sender's role in the project; undefined for anyone else (e.g. a third party finalizing an auto-approval). */
    actorRole?: Role
    /** False while the block has fewer confirmations than the chain's threshold. */
    confirmed: boolean
  }

/**
 * Orders decoded logs as they happened (block, then position in the block), drops duplicates from overlapping
 * queries, describes each one and marks the ones newer than the confirmation threshold.
 */
export function buildTimeline(
  events: RawTimelineEvent[],
  { latestBlock, confirmations, ctx }: { latestBlock: number; confirmations: number; ctx: DescribeContext },
): TimelineEntry[] {
  const unique = new Map<string, RawTimelineEvent>()
  for (const event of events) unique.set(`${event.blockNumber}-${event.logIndex}`, event)
  return [...unique.entries()]
    .sort(([, a], [, b]) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    .map(([key, event]) => ({
      ...event,
      ...describeEvent(event.name, event.args, ctx),
      key,
      actorRole: ctx.roleOf(event.from),
      confirmed: latestBlock - event.blockNumber + 1 >= confirmations,
    }))
}
