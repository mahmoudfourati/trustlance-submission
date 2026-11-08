import { parseEther } from 'ethers'
import { sameAddress } from './address'
import type { Milestone, Project } from './escrow'
import { formatEthExact } from './format'
import { ARBITRATION_PERIOD, BPS_DENOMINATOR, LIMIT_TEXT, MAX_NOTE_BYTES } from './limits'

// Every amount here is integer wei computed with the contract's own formulas, so a preview equals what is credited.

export type DisputeAction = 'raise' | 'resolve' | 'settle'

export type AvailableDisputeAction = {
  action: DisputeAction
  /** Set when the action is shown but can't be sent yet; explains why. */
  disabledReason?: string
}

/** Unix seconds; the first second of expired-dispute settlement. The arbitrator can resolve until one second before (half-open). */
export function arbitrationDeadline(project: Pick<Project, 'raisedAt'>): number {
  return project.raisedAt + ARBITRATION_PERIOD
}

/**
 * Who can settle a dispute at `now`: the arbitrator (`arbitration`), or either party with expired-dispute settlement,
 * the fixed fallback split (`expired`).
 */
export function disputePhase(project: Pick<Project, 'raisedAt'>, now: number): 'arbitration' | 'expired' {
  return now < arbitrationDeadline(project) ? 'arbitration' : 'expired'
}

export function isProjectParty(project: Pick<Project, 'client' | 'freelancer'>, account: string | undefined): boolean {
  return sameAddress(account, project.client) || sameAddress(account, project.freelancer)
}

/** "Client" or "Freelancer": who raised the project's dispute. */
export function raisedByRole(project: Pick<Project, 'client' | 'raisedBy'>): 'Client' | 'Freelancer' {
  return sameAddress(project.raisedBy, project.client) ? 'Client' : 'Freelancer'
}

/** The most the arbitrator can give the freelancer: the frozen amount minus the fee, as `resolveDispute` computes it. */
export function maxFreelancerShare(frozen: bigint, feeBps: number): bigint {
  return frozen - (frozen * BigInt(feeBps)) / BPS_DENOMINATOR
}

/**
 * What raising a dispute at `now` would do, mirroring `raiseDispute`: Submitted milestones whose review window has
 * ended are credited to the freelancer first, then every other Pending or Submitted milestone is frozen. The contract
 * uses the block's timestamp, so a submission near its review deadline can fall either way.
 */
export function raiseDisputePreview(
  milestones: readonly Pick<Milestone, 'status' | 'amount' | 'reviewDeadline'>[],
  now: number,
): { credited: bigint; frozenPending: bigint; frozenSubmitted: bigint; frozen: bigint } {
  let credited = 0n
  let frozenPending = 0n
  let frozenSubmitted = 0n
  for (const m of milestones) {
    if (m.status === 'Pending') frozenPending += m.amount
    else if (m.status === 'Submitted' && now >= m.reviewDeadline) credited += m.amount
    else if (m.status === 'Submitted') frozenSubmitted += m.amount
  }
  return { credited, frozenPending, frozenSubmitted, frozen: frozenPending + frozenSubmitted }
}

/**
 * The arbitrator's split, as `resolveDispute` computes it: the fee is `frozen * feeBps / 10 000` rounded down, the
 * freelancer gets `freelancerShare` (at most `frozen - fee`), and the client gets the rest.
 * Throws a RangeError for a share the contract would reject.
 */
export function resolutionPreview(
  frozen: bigint,
  feeBps: number,
  freelancerShare: bigint,
): { fee: bigint; maxShare: bigint; freelancer: bigint; client: bigint } {
  const maxShare = maxFreelancerShare(frozen, feeBps)
  const fee = frozen - maxShare
  if (freelancerShare < 0n || freelancerShare > maxShare) {
    throw new RangeError(`The freelancer's share must be between 0 and ${maxShare} wei.`)
  }
  return { fee, maxShare, freelancer: freelancerShare, client: frozen - fee - freelancerShare }
}

/**
 * Expired-dispute settlement, the fixed fallback split, as `settleExpiredDispute` computes it: half the frozen submissions (rounded down) to the
 * freelancer; the frozen pending milestones and the other half (with the odd wei) to the client; no fee.
 */
export function expiredSettlementPreview(
  project: Pick<Project, 'frozenPendingAmount' | 'frozenSubmittedAmount'>,
): { freelancer: bigint; client: bigint } {
  const freelancer = project.frozenSubmittedAmount / 2n
  return { freelancer, client: project.frozenPendingAmount + (project.frozenSubmittedAmount - freelancer) }
}

/** The share at a slider position from 0 to 10 000 (hundredths of a percent of `maxShare`), in integer wei. */
export function shareAtFraction(maxShare: bigint, position: number): bigint {
  return (maxShare * BigInt(Math.round(position))) / BPS_DENOMINATOR
}

/** Parses a typed ETH amount into exact wei (any amount from 0 to `maxShare`, not only the slider's steps). */
export function parseShareInput(text: string, maxShare: bigint): { share: bigint } | { error: string } {
  const value = text.trim()
  if (!/^\d+(\.\d{1,18})?$/.test(value)) return { error: 'Enter an amount in ETH, like 0.5, with at most 18 decimals.' }
  const share = parseEther(value)
  if (share > maxShare) {
    return { error: `The freelancer's share can be at most the frozen funds minus the fee: ${formatEthExact(maxShare)}.` }
  }
  return { share }
}

/** The contract takes a dispute reason of 1 to 1000 bytes; a blank reason is rejected here as well. */
export function validateReason(reason: string): string | undefined {
  if (reason.trim() === '') return 'Explain what the dispute is about.'
  if (new TextEncoder().encode(reason).byteLength > MAX_NOTE_BYTES) return `The reason must be ${LIMIT_TEXT.note}.`
  return undefined
}

/**
 * The dispute actions the connected account may take right now, mirroring the contract's guards: either party
 * raises a dispute on an Active project; the arbitrator resolves until `arbitrationDeadline - 1`; either party
 * triggers expired-dispute settlement from `arbitrationDeadline`.
 */
export function disputeActions(
  project: Pick<Project, 'status' | 'client' | 'freelancer' | 'arbitrator' | 'raisedAt'>,
  milestones: readonly Pick<Milestone, 'status' | 'amount' | 'reviewDeadline'>[],
  account: string | undefined,
  now: number,
): AvailableDisputeAction[] {
  const isParty = isProjectParty(project, account)

  if (project.status === 'Active') {
    if (!isParty) return []
    return raiseDisputePreview(milestones, now).frozen > 0n
      ? [{ action: 'raise' }]
      : [
          {
            action: 'raise',
            disabledReason:
              'There is nothing left to dispute: every open milestone has passed its review window and counts as approved.',
          },
        ]
  }
  if (project.status !== 'Disputed') return []

  const open = disputePhase(project, now) === 'arbitration'
  if (sameAddress(account, project.arbitrator)) {
    return open
      ? [{ action: 'resolve' }]
      : [
          {
            action: 'resolve',
            disabledReason: `The arbitration period of ${LIMIT_TEXT.arbitrationPeriod} has ended; either party can now settle the expired dispute.`,
          },
        ]
  }
  if (!isParty) return []
  return open
    ? [{ action: 'settle', disabledReason: 'The arbitrator still has time to resolve this dispute.' }]
    : [{ action: 'settle' }]
}

/**
 * The arbitrator console's sections: disputes the arbitrator can still resolve (nearest deadline first), disputes
 * whose arbitration period has ended, settled disputes, and every other project that names them.
 */
export function arbitratorQueue<T extends { project: Pick<Project, 'status' | 'raisedAt'> }>(
  items: readonly T[],
  now: number,
): { awaiting: T[]; expired: T[]; settled: T[]; other: T[] } {
  const disputed = items.filter((i) => i.project.status === 'Disputed')
  return {
    awaiting: disputed
      .filter((i) => disputePhase(i.project, now) === 'arbitration')
      .sort((a, b) => a.project.raisedAt - b.project.raisedAt),
    expired: disputed
      .filter((i) => disputePhase(i.project, now) === 'expired')
      .sort((a, b) => a.project.raisedAt - b.project.raisedAt),
    settled: items.filter((i) => i.project.status === 'Resolved'),
    other: items.filter((i) => i.project.status !== 'Disputed' && i.project.status !== 'Resolved'),
  }
}
