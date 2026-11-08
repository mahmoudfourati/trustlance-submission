import { useState } from 'react'
import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { sameAddress } from '../lib/address'
import { escrowContract, type Milestone, type Project } from '../lib/escrow'
import { formatEth } from '../lib/format'
import { availableActions, forfeitPreview, type ProjectAction } from '../lib/projectActions'
import { useTransaction } from '../lib/useTransaction'
import { buttonClass } from './styles'
import { TxStatus } from './TxStatus'
import { Card, Spinner } from './ui'

type Preview = ReturnType<typeof forfeitPreview>

const COPY: Record<
  ProjectAction,
  {
    label: string
    method: 'acceptProject' | 'declineProject' | 'cancelProject' | 'forfeit'
    /** Asks before sending; forfeit's text depends on the milestones, see `forfeitConfirmText`. */
    confirm?: string
    confirmed: string
  }
> = {
  accept: {
    label: 'Accept project',
    method: 'acceptProject',
    confirmed: 'Project accepted. Every delivery period has started.',
  },
  decline: {
    label: 'Decline',
    method: 'declineProject',
    confirm: 'Decline this project? The client is refunded in full and the project closes for good.',
    confirmed: 'Project declined. The client has been refunded.',
  },
  cancel: {
    label: 'Cancel project',
    method: 'cancelProject',
    confirm: "Cancel this project? The full escrow moves to your withdrawable balance and the project can't be reopened.",
    confirmed: 'Project cancelled. The escrow is now in your withdrawable balance.',
  },
  forfeit: {
    label: 'Forfeit project',
    method: 'forfeit',
    confirm: 'Forfeit the rest of this project?',
    confirmed: 'Project forfeited. Unearned escrow went back to the client; everything you earned is in your withdrawable balance.',
  },
}

/** Spells out what a forfeit costs right now. The contract decides with the block's timestamp, so near a review
 * deadline the split can differ by one block. */
function forfeitConfirmText({ credited, refunded }: Preview, submittedInReview: boolean): string {
  const parts = ['Forfeit the rest of this project? Milestones already approved stay yours.']
  if (credited > 0n) parts.push(`${formatEth(credited)} of submissions whose review window has ended is credited to you.`)
  if (refunded > 0n) parts.push(`You give up the remaining milestones: ${formatEth(refunded)} goes back to the client.`)
  if (submittedInReview) {
    parts.push('A submission whose review window ends before your transaction is mined is credited to you instead of refunded.')
  }
  parts.push('The project ends and this is final.')
  return parts.join(' ')
}

const INTRO: Partial<Record<Project['status'], string>> = {
  Open: "Accepting starts every milestone's delivery period now. Declining refunds the client and closes the project.",
  Active:
    "If you can't finish, you can forfeit: approved milestones and submissions whose review window has ended stay yours, everything else goes back to the client.",
}

/** Project-level actions for the connected account's role: accept, decline or cancel an Open project, forfeit an Active one. */
export function ProjectActions({
  project,
  milestones,
  account,
  chainId,
  now,
}: {
  project: Project
  milestones: Milestone[]
  account: string
  chainId: number
  now: number
}) {
  const queryClient = useQueryClient()
  const tx = useTransaction()
  const [confirming, setConfirming] = useState<ProjectAction>()
  const [lastAction, setLastAction] = useState<ProjectAction>()

  const actions = availableActions(project, account, now)
  const isFreelancer = sameAddress(account, project.freelancer)

  async function send(action: ProjectAction) {
    setConfirming(undefined)
    setLastAction(action)
    const receipt = await tx.run((signer) => escrowContract(chainId, signer)[COPY[action].method](project.id))
    if (receipt) await queryClient.invalidateQueries()
  }

  // Keep the card after the action changes the project's status so the confirmation stays visible.
  if (actions.length === 0 && lastAction === undefined) return null

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">{isFreelancer && project.status === 'Open' ? 'Your response' : 'Actions'}</h2>
      {isFreelancer && actions.length > 0 && INTRO[project.status] && (
        <p className="text-sm text-slate-600 dark:text-slate-400">{INTRO[project.status]}</p>
      )}
      {confirming ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-500/30 dark:bg-red-500/10">
          <p>{confirming === 'forfeit'
              ? forfeitConfirmText(
                  forfeitPreview(milestones, now),
                  milestones.some((m) => m.status === 'Submitted' && now < m.reviewDeadline),
                )
              : COPY[confirming].confirm}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={buttonClass.danger} onClick={() => void send(confirming)}>
              Yes, {COPY[confirming].label.toLowerCase()}
            </button>
            <button type="button" className={buttonClass.secondary} onClick={() => setConfirming(undefined)}>
              Keep the project
            </button>
          </div>
        </div>
      ) : (
        actions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {actions.map(({ action, disabledReason }) => (
              <button
                key={action}
                type="button"
                title={disabledReason}
                disabled={tx.busy || disabledReason !== undefined}
                className={action === 'accept' ? buttonClass.primary : buttonClass.secondary}
                onClick={() => (COPY[action].confirm ? setConfirming(action) : void send(action))}
              >
                {tx.busy && lastAction === action && <Spinner />}
                {COPY[action].label}
              </button>
            ))}
          </div>
        )
      )}
      {actions
        .filter((a) => a.disabledReason)
        .map((a) => (
          <p key={a.action} className="text-xs text-slate-500">
            {COPY[a.action].label}: {a.disabledReason}
          </p>
        ))}
      {lastAction && <TxStatus state={tx.state} chainId={chainId} confirmedText={COPY[lastAction].confirmed} />}
      {tx.state.phase === 'confirmed' && lastAction === 'cancel' && (
        <Link to="/balances" className="text-sm font-medium text-indigo-600 underline dark:text-indigo-400">
          Go to your balance to withdraw
        </Link>
      )}
    </Card>
  )
}
