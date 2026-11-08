import { sameAddress } from './address'
import type { Milestone, Project } from './escrow'
import { MAX_REVISIONS } from './limits'

export type MilestoneAction = 'submit' | 'approve' | 'revise' | 'autoApprove' | 'refund'

export type AvailableMilestoneAction = {
  action: MilestoneAction
  /** Set when the action is shown but can't be sent; explains why. */
  disabledReason?: string
}

export function revisionsLeft(milestone: Pick<Milestone, 'revisionCount'>): number {
  return Math.max(0, MAX_REVISIONS - milestone.revisionCount)
}

/**
 * The milestone actions the connected account may take right now, mirroring the contract's role, state and
 * half-open deadline guards: the review window runs until reviewDeadline - 1, auto-approval from reviewDeadline;
 * delivery runs until deliveryDeadline - 1, an overdue refund from deliveryDeadline.
 */
export function milestoneActions(
  project: Pick<Project, 'status' | 'client' | 'freelancer'>,
  milestone: Pick<Milestone, 'status' | 'reviewDeadline' | 'revisionCount' | 'deliveryDeadline'>,
  account: string | undefined,
  now: number,
): AvailableMilestoneAction[] {
  if (project.status !== 'Active' || !account) return []

  if (milestone.status === 'Pending') {
    // Late submission stays open until the client actually refunds; whichever transaction is mined first wins.
    if (sameAddress(account, project.freelancer)) return [{ action: 'submit' }]
    if (sameAddress(account, project.client) && now >= milestone.deliveryDeadline) return [{ action: 'refund' }]
    return []
  }
  if (milestone.status !== 'Submitted') return []

  // From the review deadline the milestone already counts as approved; anyone can record it.
  if (now >= milestone.reviewDeadline) return [{ action: 'autoApprove' }]
  if (!sameAddress(account, project.client)) return []
  const revise: AvailableMilestoneAction =
    revisionsLeft(milestone) > 0
      ? { action: 'revise' }
      : {
          action: 'revise',
          disabledReason: "You've used both revision requests. Approve it, let it auto-approve, or raise a dispute.",
        }
  return [{ action: 'approve' }, revise]
}
