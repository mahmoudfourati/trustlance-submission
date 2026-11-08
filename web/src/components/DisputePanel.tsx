import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { formatEther } from 'ethers'
import { sameAddress } from '../lib/address'
import {
  arbitrationDeadline,
  disputeActions,
  disputePhase,
  expiredSettlementPreview,
  isProjectParty,
  maxFreelancerShare,
  parseShareInput,
  raiseDisputePreview,
  raisedByRole,
  resolutionPreview,
  shareAtFraction,
  validateReason,
  type DisputeAction,
} from '../lib/disputes'
import { escrowContract, type DisputeRecord, type Milestone, type Project } from '../lib/escrow'
import { formatDateTime, formatEth, formatEthExact, formatFeeRate, formatRelative } from '../lib/format'
import { LIMIT_TEXT, MAX_NOTE_BYTES } from '../lib/limits'
import { useTransaction } from '../lib/useTransaction'
import { buttonClass, inputClass } from './styles'
import { TxStatus } from './TxStatus'
import { TrustNote } from './TrustNote'
import { Address, Card, Spinner } from './ui'

const CONFIRMED: Record<DisputeAction, string> = {
  raise: 'Dispute raised. The open milestones are frozen until it is settled.',
  resolve: 'Dispute resolved. The amounts are credited to the withdrawable balances.',
  settle: 'Expired dispute settled. The amounts are credited to the withdrawable balances.',
}

/** Label/value rows of exact amounts. */
function Amounts({ rows }: { rows: [label: ReactNode, wei: bigint][] }) {
  return (
    <dl className="grid gap-1 text-sm">
      {rows.map(([label, wei], i) => (
        <div key={i} className="flex flex-wrap justify-between gap-x-4">
          <dt className="text-slate-600 dark:text-slate-400">{label}</dt>
          <dd className="font-mono font-medium">{formatEthExact(wei)}</dd>
        </div>
      ))}
    </dl>
  )
}

function ConfirmBox({
  tone,
  children,
  yes,
  busy,
  onYes,
  onNo,
}: {
  tone: 'danger' | 'primary'
  children: ReactNode
  yes: string
  busy: boolean
  onYes: () => void
  onNo: () => void
}) {
  const box =
    tone === 'danger'
      ? 'border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10'
      : 'border-indigo-200 bg-indigo-50 dark:border-indigo-500/30 dark:bg-indigo-500/10'
  return (
    <div className={`space-y-3 rounded-lg border p-3 text-sm ${box}`}>
      {children}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={tone === 'danger' ? buttonClass.danger : buttonClass.primary} disabled={busy} onClick={onYes}>
          {yes}
        </button>
        <button type="button" className={buttonClass.secondary} onClick={onNo}>
          Go back
        </button>
      </div>
    </div>
  )
}

/** Either party raises a dispute: a reason, then a confirmation spelling out what is credited and frozen. */
function RaiseDisputeForm({
  project,
  milestones,
  now,
  busy,
  onSend,
  onClose,
}: {
  project: Project
  milestones: Milestone[]
  now: number
  busy: boolean
  onSend: (reason: string) => void
  onClose: () => void
}) {
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [touched, setTouched] = useState(false)
  const error = validateReason(reason)
  const bytes = new TextEncoder().encode(reason).byteLength
  const preview = raiseDisputePreview(milestones, now)
  const hasSubmissionInReview = milestones.some((m) => m.status === 'Submitted' && now < m.reviewDeadline)

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    setTouched(true)
    if (!error) setConfirming(true)
  }

  if (confirming) {
    return (
      <ConfirmBox tone="danger" yes="Yes, raise the dispute" busy={busy} onYes={() => onSend(reason)} onNo={() => setConfirming(false)}>
        <p className="font-medium">Raise a dispute on this project? This can't be withdrawn.</p>
        <Amounts
          rows={[
            ...(preview.credited > 0n ? [["Credited to the freelancer first (review window ended)", preview.credited] as [string, bigint]] : []),
            ['Frozen from Pending milestones', preview.frozenPending],
            ['Frozen from submissions in review', preview.frozenSubmitted],
            ['Frozen in total', preview.frozen],
          ]}
        />
        <p className="text-slate-600 dark:text-slate-400">
          No milestone can be submitted, approved or refunded while the dispute is open. The arbitrator decides the split (minus a{' '}
          {formatFeeRate(project.feeBps)} fee) within {LIMIT_TEXT.arbitrationPeriod}; after that either of you can settle the expired
          dispute with the fixed fallback split.
          {hasSubmissionInReview &&
            ' A submission whose review window ends before your transaction is mined is credited to the freelancer instead of frozen.'}
        </p>
        <p className="whitespace-pre-line break-words text-slate-600 dark:text-slate-400">Reason (public on-chain): {reason}</p>
      </ConfirmBox>
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
      <label className="block">
        What is the dispute about? (public on-chain, {LIMIT_TEXT.note})
        <textarea rows={3} className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} onBlur={() => setTouched(true)} />
      </label>
      <p aria-live="polite" className={`text-xs ${bytes > MAX_NOTE_BYTES ? 'text-red-600 dark:text-red-400' : 'text-slate-500'}`}>
        {bytes} / {MAX_NOTE_BYTES} bytes
      </p>
      {touched && error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <p className="text-slate-600 dark:text-slate-400">
        About {formatEth(preview.frozen)} would be frozen. You'll see the exact amounts before confirming.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={buttonClass.danger} disabled={busy}>
          Review dispute
        </button>
        <button type="button" className={buttonClass.secondary} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** The arbitrator's split: a slider and an exact ETH field over the same integer-wei share. */
function ResolveForm({ project, busy, onSend, onClose }: { project: Project; busy: boolean; onSend: (share: bigint) => void; onClose: () => void }) {
  const maxShare = maxFreelancerShare(project.frozenAmount, project.feeBps)
  const [text, setText] = useState(() => formatEther(shareAtFraction(maxShare, 5_000)))
  const [confirming, setConfirming] = useState(false)
  const parsed = parseShareInput(text, maxShare)
  const preview = 'share' in parsed ? resolutionPreview(project.frozenAmount, project.feeBps, parsed.share) : undefined
  const position = preview && maxShare > 0n ? Number((preview.freelancer * 10_000n) / maxShare) : 0

  if (confirming && preview) {
    return (
      <ConfirmBox tone="primary" yes="Yes, resolve the dispute" busy={busy} onYes={() => onSend(preview.freelancer)} onNo={() => setConfirming(false)}>
        <p className="font-medium">Resolve this dispute with this split? It is final.</p>
        <Amounts
          rows={[
            ['Freelancer', preview.freelancer],
            ['Client', preview.client],
            [`Your fee (${formatFeeRate(project.feeBps)})`, preview.fee],
          ]}
        />
      </ConfirmBox>
    )
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (preview) setConfirming(true)
      }}
      className="space-y-3 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800"
    >
      <label className="block">
        <span className="flex justify-between text-slate-600 dark:text-slate-400">
          <span>All to the client</span>
          <span>All to the freelancer</span>
        </span>
        <input
          type="range"
          min={0}
          max={10_000}
          step={1}
          value={position}
          disabled={maxShare === 0n}
          aria-label="Freelancer's share of the frozen funds after the fee, from all to the client to all to the freelancer"
          aria-valuetext={preview ? `${formatEthExact(preview.freelancer)} to the freelancer, ${formatEthExact(preview.client)} to the client` : undefined}
          className="mt-1 w-full accent-indigo-600"
          onChange={(e) => setText(formatEther(shareAtFraction(maxShare, Number(e.target.value))))}
        />
      </label>
      <label className="block">
        Freelancer's share in ETH (exact; at most {formatEthExact(maxShare)})
        <input className={`${inputClass} font-mono`} inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {'error' in parsed && <p className="text-xs text-red-600 dark:text-red-400">{parsed.error}</p>}
      {preview && (
        <Amounts
          rows={[
            ['Frozen', project.frozenAmount],
            [`Arbitration fee (${formatFeeRate(project.feeBps)}, rounded down)`, preview.fee],
            ['Freelancer receives', preview.freelancer],
            ['Client receives', preview.client],
          ]}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={buttonClass.primary} disabled={busy || !preview}>
          Review resolution
        </button>
        <button type="button" className={buttonClass.secondary} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** One line on who can settle the dispute now, in the contract's half-open form. */
function DeadlineState({ project, now }: { project: Project; now: number }) {
  const deadline = arbitrationDeadline(project)
  return disputePhase(project, now) === 'arbitration' ? (
    <p>
      <span className="font-medium">Arbitration open.</span> The arbitrator can resolve it until {formatDateTime(deadline - 1)} (
      {formatRelative(deadline, now)}). If they don't, either party can settle the expired dispute from {formatDateTime(deadline)}.
    </p>
  ) : (
    <p>
      <span className="font-medium">Arbitration period ended</span> at {formatDateTime(deadline)}. The arbitrator can no longer
      resolve it; either party can settle the expired dispute now.
    </p>
  )
}

/**
 * Everything about a project's dispute: raising one (client or freelancer of an Active project), the frozen amounts and
 * the arbitration deadline, the arbitrator's resolution, expired-dispute settlement, and the outcome.
 */
export function DisputePanel({
  project,
  milestones,
  dispute,
  account,
  chainId,
  now,
}: {
  project: Project
  milestones: Milestone[]
  dispute: DisputeRecord | undefined
  account: string | undefined
  chainId: number
  now: number
}) {
  const queryClient = useQueryClient()
  const tx = useTransaction()
  const [open, setOpen] = useState<DisputeAction>()
  const [lastAction, setLastAction] = useState<DisputeAction>()

  const actions = disputeActions(project, milestones, account, now)
  const action = (name: DisputeAction) => actions.find((a) => a.action === name)
  const hasDispute = project.status === 'Disputed' || project.status === 'Resolved'
  // Keep the card after a transaction changes the status so its confirmation stays visible.
  if (!hasDispute && actions.length === 0 && lastAction === undefined) return null

  async function send(name: DisputeAction, run: Parameters<typeof tx.run>[0]) {
    setOpen(undefined)
    setLastAction(name)
    if (await tx.run(run)) await queryClient.invalidateQueries()
  }

  const expired = expiredSettlementPreview(project)
  const isArbitrator = sameAddress(account, project.arbitrator)
  const raise = action('raise')
  const resolve = action('resolve')
  const settle = action('settle')

  return (
    <Card className="space-y-4">
      <h2 className="font-semibold">Dispute</h2>

      {!hasDispute && raise && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            If you and the other party can't agree, either of you can raise a dispute. Submissions whose review window has ended are
            credited to the freelancer first; every other open milestone is frozen. The project's arbitrator then splits the frozen
            funds (for a {formatFeeRate(project.feeBps)} fee) within {LIMIT_TEXT.arbitrationPeriod}; after that either of you can
            settle the expired dispute with the fixed fallback split.
          </p>
          {open === 'raise' ? (
            <RaiseDisputeForm
              project={project}
              milestones={milestones}
              now={now}
              busy={tx.busy}
              onClose={() => setOpen(undefined)}
              onSend={(reason) => void send('raise', (signer) => escrowContract(chainId, signer).raiseDispute(project.id, reason))}
            />
          ) : (
            <>
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={tx.busy || raise.disabledReason !== undefined}
                title={raise.disabledReason}
                onClick={() => setOpen('raise')}
              >
                {tx.busy && lastAction === 'raise' && <Spinner />}
                Raise a dispute
              </button>
              {raise.disabledReason && <p className="text-xs text-slate-500">{raise.disabledReason}</p>}
            </>
          )}
        </div>
      )}

      {hasDispute && (
        <div className="space-y-3 text-sm">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Raised by</dt>
              <dd>
                {raisedByRole(project)}{' '}
                <Address address={project.raisedBy} chainId={chainId} you={account} /> on {formatDateTime(project.raisedAt)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Arbitrator</dt>
              <dd>
                <Address address={project.arbitrator} chainId={chainId} you={account} />
                <span className="ml-2 text-slate-500">{formatFeeRate(project.feeBps)} fee if they resolve it</span>
              </dd>
            </div>
            {dispute && (
              <div className="sm:col-span-2">
                <dt className="text-slate-500 dark:text-slate-400">Reason</dt>
                <dd className="whitespace-pre-line break-words">{dispute.reason}</dd>
              </div>
            )}
          </dl>
          <Amounts
            rows={[
              ['Frozen from Pending milestones', project.frozenPendingAmount],
              ['Frozen from submissions in review', project.frozenSubmittedAmount],
              ['Frozen in total', project.frozenAmount],
            ]}
          />
        </div>
      )}

      {project.status === 'Disputed' && (
        <div className="space-y-3 text-sm">
          <DeadlineState project={project} now={now} />
          <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
            <p className="mb-2 text-slate-600 dark:text-slate-400">
              Expired-dispute settlement, the fixed fallback split (no fee): the frozen Pending milestones go back to the client,
              the frozen submissions are split in half, the odd wei to the client.
            </p>
            <Amounts
              rows={[
                ['Freelancer', expired.freelancer],
                ['Client', expired.client],
              ]}
            />
          </div>

          {resolve &&
            (open === 'resolve' ? (
              <ResolveForm
                project={project}
                busy={tx.busy}
                onClose={() => setOpen(undefined)}
                onSend={(share) => void send('resolve', (signer) => escrowContract(chainId, signer).resolveDispute(project.id, share))}
              />
            ) : (
              <div className="space-y-1">
                <button
                  type="button"
                  className={buttonClass.primary}
                  disabled={tx.busy || resolve.disabledReason !== undefined}
                  title={resolve.disabledReason}
                  onClick={() => setOpen('resolve')}
                >
                  {tx.busy && lastAction === 'resolve' && <Spinner />}
                  Resolve dispute
                </button>
                {resolve.disabledReason && <p className="text-xs text-slate-500">{resolve.disabledReason}</p>}
              </div>
            ))}

          {settle &&
            (open === 'settle' ? (
              <ConfirmBox
                tone="danger"
                yes="Yes, settle the expired dispute"
                busy={tx.busy}
                onNo={() => setOpen(undefined)}
                onYes={() => void send('settle', (signer) => escrowContract(chainId, signer).settleExpiredDispute(project.id))}
              >
                <p className="font-medium">Settle the expired dispute with the fixed fallback split? It is final.</p>
                <Amounts
                  rows={[
                    ['Freelancer receives', expired.freelancer],
                    ['Client receives', expired.client],
                  ]}
                />
              </ConfirmBox>
            ) : (
              <div className="space-y-1">
                <button
                  type="button"
                  className={buttonClass.primary}
                  disabled={tx.busy || settle.disabledReason !== undefined}
                  title={settle.disabledReason}
                  onClick={() => setOpen('settle')}
                >
                  {tx.busy && lastAction === 'settle' && <Spinner />}
                  Settle expired dispute
                </button>
                {settle.disabledReason && (
                  <p className="text-xs text-slate-500">
                    {settle.disabledReason} Available from {formatDateTime(arbitrationDeadline(project))}.
                  </p>
                )}
              </div>
            ))}
        </div>
      )}

      {project.status === 'Resolved' && (
        <div className="space-y-2 text-sm">
          {dispute?.outcome ? (
            <>
              <p className="font-medium">
                {dispute.outcome.kind === 'resolved'
                  ? 'Resolved by the arbitrator.'
                  : 'Expired dispute settled with the fixed fallback split after the arbitration period.'}
              </p>
              <Amounts
                rows={[
                  ['Freelancer received', dispute.outcome.freelancerAmount],
                  ['Client received', dispute.outcome.clientAmount],
                  ...(dispute.outcome.kind === 'resolved' ? [['Arbitration fee', dispute.outcome.fee] as [string, bigint]] : []),
                ]}
              />
            </>
          ) : (
            <p>The dispute is settled. The credited amounts are on the activity timeline below.</p>
          )}
          {(isArbitrator || isProjectParty(project, account)) && (
            <Link to="/balances" className="font-medium text-indigo-600 underline dark:text-indigo-400">
              Withdraw from your balance
            </Link>
          )}
        </div>
      )}

      {(hasDispute || isArbitrator || raise) && <TrustNote />}
      {lastAction && <TxStatus state={tx.state} chainId={chainId} confirmedText={CONFIRMED[lastAction]} />}
    </Card>
  )
}
