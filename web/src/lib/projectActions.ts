import { sameAddress } from './address'
import type { Milestone, Project } from './escrow'

export type ProjectAction = 'accept' | 'decline' | 'cancel' | 'forfeit'

export type AvailableAction = {
  action: ProjectAction
  /** Set when the action is shown but can't be sent yet; explains why. */
  disabledReason?: string
}

/**
 * The lifecycle actions the connected account may take on a project right now, mirroring the contract's
 * role and state guards so the UI never offers a transaction that is certain to revert.
 */
export function availableActions(
  project: Pick<Project, 'status' | 'client' | 'freelancer' | 'acceptanceDeadline'>,
  account: string | undefined,
  now: number,
): AvailableAction[] {
  if (project.status === 'Active') return sameAddress(account, project.freelancer) ? [{ action: 'forfeit' }] : []
  if (project.status !== 'Open') return []
  if (sameAddress(account, project.freelancer)) {
    const accept: AvailableAction =
      now < project.acceptanceDeadline
        ? { action: 'accept' }
        : { action: 'accept', disabledReason: 'The acceptance deadline has passed.' }
    return [accept, { action: 'decline' }]
  }
  if (sameAddress(account, project.client)) return [{ action: 'cancel' }]
  return []
}

/**
 * What a forfeit would do right now, mirroring the contract: Submitted milestones whose review window has ended are
 * credited to the freelancer, every other Pending or Submitted milestone is refunded to the client.
 */
export function forfeitPreview(
  milestones: readonly Pick<Milestone, 'status' | 'amount' | 'reviewDeadline'>[],
  now: number,
): { credited: bigint; refunded: bigint } {
  let credited = 0n
  let refunded = 0n
  for (const m of milestones) {
    if (m.status === 'Submitted' && now >= m.reviewDeadline) credited += m.amount
    else if (m.status === 'Pending' || m.status === 'Submitted') refunded += m.amount
  }
  return { credited, refunded }
}
