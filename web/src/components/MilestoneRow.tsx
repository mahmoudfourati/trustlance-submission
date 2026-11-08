import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { escrowContract, type Milestone, type Project } from '../lib/escrow'
import { formatDateTime, formatDuration, formatEth, formatRelative } from '../lib/format'
import { LIMIT_TEXT, MAX_NOTE_BYTES, MAX_REVISIONS } from '../lib/limits'
import { milestoneActions, revisionsLeft, type MilestoneAction } from '../lib/milestoneActions'
import { useTransaction } from '../lib/useTransaction'
import { DeliverableDownload } from './DeliverableDownload'
import { SubmitDeliverable } from './SubmitDeliverable'
import { buttonClass, inputClass } from './styles'
import { TxStatus } from './TxStatus'
import { Spinner, StatusBadge } from './ui'

type TxAction = Exclude<MilestoneAction, 'submit'>

/** Button label and style for every action, and the confirmation text for those sent as one transaction. */
const COPY: Record<MilestoneAction, { label: string; primary: boolean; confirmed?: string }> = {
  submit: { label: 'Upload and submit', primary: true },
  approve: { label: 'Approve', primary: true, confirmed: "Milestone approved. Its amount is in the freelancer's withdrawable balance." },
  revise: { label: 'Request revision', primary: false, confirmed: 'Revision requested. The milestone is back with the freelancer.' },
  autoApprove: {
    label: 'Record auto-approval',
    primary: true,
    confirmed: "Auto-approval recorded. The amount is in the freelancer's withdrawable balance.",
  },
  refund: { label: 'Refund overdue milestone', primary: false, confirmed: 'Milestone refunded. Its amount is in your withdrawable balance.' },
}

/** Deadlines in the contract's half-open form: a window runs "until D − 1s", an expiry applies "from D". */
function Timing({ project, milestone, now }: { project: Project; milestone: Milestone; now: number }) {
  if (project.status === 'Disputed' && (milestone.status === 'Pending' || milestone.status === 'Submitted')) {
    return <>Frozen by the dispute: no deadline runs and nothing can be done with it until the dispute is settled.</>
  }
  if (milestone.status === 'Resolved') return <>Settled by the dispute: see the dispute panel for the amounts credited.</>
  if (milestone.status === 'Pending') {
    if (milestone.deliveryDeadline === 0) {
      return <>{project.status === 'Open' ? `Deliver within ${formatDuration(milestone.deliveryPeriod)} of acceptance` : `Delivery period: ${formatDuration(milestone.deliveryPeriod)}`}</>
    }
    return now < milestone.deliveryDeadline ? (
      <>
        Deliver until {formatDateTime(milestone.deliveryDeadline - 1)} ({formatRelative(milestone.deliveryDeadline, now)}). If
        it isn't submitted by then, the client can refund it from {formatDateTime(milestone.deliveryDeadline)}.
      </>
    ) : (
      <>
        Overdue since {formatDateTime(milestone.deliveryDeadline)}. The client can refund it from then on; until they do, a late
        submission is still accepted.
      </>
    )
  }
  if (milestone.status === 'Submitted') {
    return now < milestone.reviewDeadline ? (
      <>
        In review. The review window ends {formatRelative(milestone.reviewDeadline, now)}; the milestone auto-approves from{' '}
        {formatDateTime(milestone.reviewDeadline)}.
      </>
    ) : (
      <>Review window ended {formatRelative(milestone.reviewDeadline, now)}: this milestone counts as approved. Anyone can record it.</>
    )
  }
  return milestone.submittedAt > 0 ? <>Last submitted {formatDateTime(milestone.submittedAt)}</> : null
}

export function MilestoneRow({
  project,
  milestone,
  account,
  chainId,
  now,
}: {
  project: Project
  milestone: Milestone
  account: string | undefined
  chainId: number
  now: number
}) {
  const queryClient = useQueryClient()
  const tx = useTransaction()
  // Actions that open a form or confirmation first; auto-approval is sent straight away.
  const [open, setOpen] = useState<Exclude<MilestoneAction, 'autoApprove'>>()
  const [lastAction, setLastAction] = useState<TxAction>()
  const [note, setNote] = useState('')

  const actions = milestoneActions(project, milestone, account, now)
  const noteBytes = new TextEncoder().encode(note).byteLength
  const left = revisionsLeft(milestone)

  async function send(action: TxAction) {
    setOpen(undefined)
    setLastAction(action)
    const receipt = await tx.run((signer) => {
      const escrow = escrowContract(chainId, signer)
      if (action === 'approve') return escrow.approveMilestone(project.id, milestone.index)
      if (action === 'revise') return escrow.requestRevision(project.id, milestone.index, note)
      if (action === 'refund') return escrow.refundOverdueMilestone(project.id, milestone.index)
      return escrow.finalizeAutoApproval(project.id, milestone.index)
    })
    if (receipt) {
      setNote('')
      await queryClient.invalidateQueries()
    }
  }

  function onRevise(event: FormEvent) {
    event.preventDefault()
    if (noteBytes <= MAX_NOTE_BYTES) void send('revise')
  }

  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            {milestone.index + 1}. {milestone.title}
          </p>
          <p className="text-xs text-slate-500">
            <Timing project={project} milestone={milestone} now={now} />
          </p>
          {project.status === 'Active' && (milestone.status === 'Pending' || milestone.status === 'Submitted') && (
            <p className="text-xs text-slate-500">
              {left} of {MAX_REVISIONS} revision requests left
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="font-medium">{formatEth(milestone.amount)}</span>
          <StatusBadge status={milestone.status} />
        </div>
      </div>

      {milestone.status === 'Pending' && milestone.revisionNote !== undefined && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
          <p className="font-medium">Revision requested</p>
          <p className="mt-1 whitespace-pre-line break-words">{milestone.revisionNote || 'No note was given.'}</p>
        </div>
      )}

      {milestone.deliverableCid && milestone.status !== 'Pending' && <DeliverableDownload manifestCid={milestone.deliverableCid} />}

      {open === 'submit' ? (
        <SubmitDeliverable project={project} milestone={milestone} chainId={chainId} onClose={() => setOpen(undefined)} />
      ) : open === 'approve' ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-500/30 dark:bg-emerald-500/10">
          <p>
            Approve milestone {milestone.index + 1}? {formatEth(milestone.amount)} moves to the freelancer's withdrawable balance.
            This is final.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={buttonClass.primary} onClick={() => void send('approve')}>
              Yes, approve
            </button>
            <button type="button" className={buttonClass.secondary} onClick={() => setOpen(undefined)}>
              Not yet
            </button>
          </div>
        </div>
      ) : open === 'refund' ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-500/30 dark:bg-red-500/10">
          <p>
            Refund milestone {milestone.index + 1}? {formatEth(milestone.amount)} moves to your withdrawable balance and the freelancer
            can no longer deliver this milestone. This is final.
          </p>
          <p className="mt-2 text-slate-600 dark:text-slate-400">
            The freelancer may still be submitting. If their submission is mined first, your refund fails, costs only gas, and
            the milestone goes into review instead.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={buttonClass.danger} onClick={() => void send('refund')}>
              Yes, refund
            </button>
            <button type="button" className={buttonClass.secondary} onClick={() => setOpen(undefined)}>
              Not yet
            </button>
          </div>
        </div>
      ) : open === 'revise' ? (
        <form onSubmit={onRevise} className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
          <label className="block">
            What needs to change? (public, {LIMIT_TEXT.note})
            <textarea
              rows={3}
              className={inputClass}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <p className={`text-xs ${noteBytes > MAX_NOTE_BYTES ? 'text-red-600 dark:text-red-400' : 'text-slate-500'}`}>
            {noteBytes} / {MAX_NOTE_BYTES} bytes
          </p>
          <p className="text-slate-600 dark:text-slate-400">
            {left === 1
              ? 'This is your last revision request. After the next submission you can only approve, let it auto-approve, or dispute.'
              : `You have ${left} revision requests left.`}{' '}
            The freelancer gets at least {formatDuration(project.reviewWindow)} to deliver again.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={buttonClass.primary} disabled={noteBytes > MAX_NOTE_BYTES}>
              Request revision
            </button>
            <button type="button" className={buttonClass.secondary} onClick={() => setOpen(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        actions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {actions.map(({ action, disabledReason }) => (
              <button
                key={action}
                type="button"
                title={disabledReason}
                disabled={tx.busy || disabledReason !== undefined}
                className={COPY[action].primary ? buttonClass.primary : buttonClass.secondary}
                onClick={() => (action === 'autoApprove' ? void send(action) : setOpen(action))}
              >
                {tx.busy && lastAction === action && <Spinner />}
                {COPY[action].label}
              </button>
            ))}
            {actions
              .filter((a) => a.disabledReason)
              .map((a) => (
                <p key={a.action} className="w-full text-xs text-slate-500">
                  {a.disabledReason}
                </p>
              ))}
          </div>
        )
      )}

      {lastAction && <TxStatus state={tx.state} chainId={chainId} confirmedText={COPY[lastAction].confirmed ?? ''} />}
    </li>
  )
}
