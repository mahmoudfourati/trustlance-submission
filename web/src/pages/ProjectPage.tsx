import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { getProjectDetail } from '../lib/escrow'
import { decodeContractError, describeError } from '../lib/errors'
import { formatDateTime, formatDuration, formatEth, formatFeeRate, formatRelative } from '../lib/format'
import { useActiveChain } from '../lib/useActiveChain'
import { useNow } from '../lib/useNow'
import { useWallet } from '../lib/walletContext'
import { CHAINS } from '../lib/chains'
import { DisputePanel } from '../components/DisputePanel'
import { MilestoneRow } from '../components/MilestoneRow'
import { ProjectActions } from '../components/ProjectActions'
import { Timeline } from '../components/Timeline'
import { Address, Alert, Card, Spinner, StatusBadge } from '../components/ui'

function parseId(raw: string | undefined): bigint | undefined {
  return raw && /^\d{1,20}$/.test(raw) && raw !== '0' ? BigInt(raw) : undefined
}

export function ProjectPage() {
  const id = parseId(useParams().id)
  const { account } = useWallet()
  const { chainId, provider, deployed, canTransact } = useActiveChain()
  // Actions only for a wallet that can sign on the chain being shown; on another network the page is read-only.
  const actor = canTransact ? account : undefined
  const now = useNow()

  const detail = useQuery({
    queryKey: ['project', chainId, id?.toString()],
    queryFn: () => getProjectDetail(chainId, provider, id!),
    enabled: id !== undefined && deployed,
    // Picks up other parties' transactions and new confirmations; our own transactions invalidate it at once.
    refetchInterval: 15_000,
  })

  if (id === undefined) return <Alert tone="error">That isn't a valid project id.</Alert>
  if (!deployed) return <Alert tone="warning">TrustLance isn't deployed on {CHAINS[chainId].name}.</Alert>
  if (detail.isPending) {
    return (
      <p className="inline-flex items-center gap-2 text-slate-500">
        <Spinner /> Loading project #{id.toString()}…
      </p>
    )
  }
  // A failed background refresh keeps the last data on screen (see the warning below) instead of hiding it.
  if (detail.isError && !detail.data) {
    const notFound = decodeContractError(detail.error)?.name === 'UnknownProject'
    return (
      <Alert tone="error">
        {notFound ? `Project #${id} doesn't exist on ${CHAINS[chainId].name}.` : `Couldn't load the project. ${describeError(detail.error)}`}{' '}
        <Link to="/" className="underline">
          Back to dashboard
        </Link>
      </Alert>
    )
  }

  if (!detail.data) return null // unreachable after the guards above; narrows the type
  const { project, milestones, timeline, dispute } = detail.data
  const acceptanceOpen = project.status === 'Open' && now < project.acceptanceDeadline

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">
            Project #{project.id.toString()} · {CHAINS[chainId].name}
          </p>
          <h1 className="text-2xl font-bold tracking-tight">{project.title}</h1>
          {project.description && <p className="mt-2 max-w-3xl whitespace-pre-line text-slate-600 dark:text-slate-400">{project.description}</p>}
        </div>
        <StatusBadge status={project.status} />
      </div>

      {detail.isError && (
        <Alert tone="warning">
          Couldn't refresh from the chain, so this may be out of date (last read {formatDateTime(Math.floor(detail.dataUpdatedAt / 1000))}).{' '}
          {describeError(detail.error)}
        </Alert>
      )}

      {project.status === 'Open' && (
        <Alert tone={acceptanceOpen ? 'info' : 'warning'}>
          {acceptanceOpen
            ? `Waiting for the freelancer to accept, until ${formatDateTime(project.acceptanceDeadline - 1)} (${formatRelative(project.acceptanceDeadline, now)}).`
            : `The acceptance deadline passed ${formatRelative(project.acceptanceDeadline, now)}. The freelancer can no longer accept; the client can cancel for a full refund.`}
        </Alert>
      )}
      {project.status === 'Completed' && (
        <Alert tone="success">
          This project is complete: every milestone is settled.
          {project.approvedAmount > 0n && ` ${formatEth(project.approvedAmount)} went to the freelancer.`}
          {project.refundedAmount > 0n && ` ${formatEth(project.refundedAmount)} was refunded to the client.`}
        </Alert>
      )}
      {project.status === 'Disputed' && (
        <Alert tone="warning">
          This project is in dispute. {formatEth(project.frozenAmount)} is frozen until the arbitrator resolves it or the expired
          dispute is settled; see the dispute panel below.
        </Alert>
      )}
      {project.status === 'Resolved' && (
        <Alert tone="success">The dispute on this project is settled and the project is closed. See the dispute panel for the amounts credited.</Alert>
      )}
      {project.status === 'Cancelled' && (
        <Alert tone="info">This project was cancelled before work started. The client was refunded {formatEth(project.refundedAmount)}.</Alert>
      )}

      {actor && <ProjectActions project={project} milestones={milestones} account={actor} chainId={chainId} now={now} />}
      <DisputePanel project={project} milestones={milestones} dispute={dispute} account={actor} chainId={chainId} now={now} />

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">Escrow</h2>
          <p className="mt-1 text-2xl font-semibold">{formatEth(project.pendingAmount + project.submittedAmount)}</p>
          <p className="mt-1 text-xs text-slate-500">of {formatEth(project.totalAmount)} funded</p>
          {project.status === 'Disputed' ? (
            <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">{formatEth(project.frozenAmount)} frozen by the dispute</p>
          ) : (
            project.submittedAmount > 0n && <p className="mt-1 text-xs text-slate-500">{formatEth(project.submittedAmount)} in review</p>
          )}
          {project.status === 'Resolved' && (
            <p className="mt-1 text-xs text-slate-500">{formatEth(project.frozenAmount)} split by the dispute</p>
          )}
          {project.approvedAmount > 0n && <p className="mt-1 text-xs text-slate-500">{formatEth(project.approvedAmount)} approved for the freelancer</p>}
          {project.refundedAmount > 0n && <p className="mt-1 text-xs text-slate-500">{formatEth(project.refundedAmount)} refunded to the client</p>}
        </Card>
        <Card className="md:col-span-2">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Client</dt>
              <dd>
                <Address address={project.client} chainId={chainId} you={account} />
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Freelancer</dt>
              <dd>
                <Address address={project.freelancer} chainId={chainId} you={account} />
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Arbitrator</dt>
              <dd>
                <Address address={project.arbitrator} chainId={chainId} you={account} />
                <span className="ml-2 text-slate-500">{formatFeeRate(project.feeBps)} fee on disputed funds</span>
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Review window</dt>
              <dd>{formatDuration(project.reviewWindow)} per submission</dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Created</dt>
              <dd>{formatDateTime(project.createdAt)}</dd>
            </div>
            {project.acceptedAt > 0 && (
              <div>
                <dt className="text-slate-500 dark:text-slate-400">Accepted</dt>
                <dd>{formatDateTime(project.acceptedAt)}</dd>
              </div>
            )}
          </dl>
        </Card>
      </div>

      <Card>
        <h2 className="font-semibold">Milestones</h2>
        <ul className="mt-2 divide-y divide-slate-200 dark:divide-slate-800">
          {milestones.map((m) => (
            <MilestoneRow key={m.index} project={project} milestone={m} account={actor} chainId={chainId} now={now} />
          ))}
        </ul>
      </Card>

      <Card>
        <h2 className="font-semibold">Activity</h2>
        <p className="text-xs text-slate-500">From the contract's event logs on {CHAINS[chainId].name}, oldest first.</p>
        <Timeline entries={timeline} chainId={chainId} account={account} />
      </Card>
    </div>
  )
}
