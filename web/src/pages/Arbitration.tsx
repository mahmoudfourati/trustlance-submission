import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { arbitrationDeadline, arbitratorQueue, raisedByRole } from '../lib/disputes'
import { getArbitratorProjects, type Project } from '../lib/escrow'
import { describeError } from '../lib/errors'
import { formatDateTime, formatEth, formatFeeRate, formatRelative } from '../lib/format'
import { useActiveChain } from '../lib/useActiveChain'
import { useNow } from '../lib/useNow'
import { useWallet } from '../lib/walletContext'
import { buttonClass } from '../components/styles'
import { TrustNote } from '../components/TrustNote'
import { Address, Alert, Card, Spinner, StatusBadge } from '../components/ui'

type Item = { project: Project; reason?: string }

function DisputeCard({ item: { project, reason }, chainId, now }: { item: Item; chainId: number; now: number }) {
  const deadline = arbitrationDeadline(project)
  return (
    <Link to={`/projects/${project.id}`} className="block transition hover:-translate-y-0.5">
      <Card className="h-full space-y-3 hover:border-indigo-300 dark:hover:border-indigo-500/50">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-slate-500">Project #{project.id.toString()}</p>
            <h3 className="font-semibold">{project.title}</h3>
          </div>
          <StatusBadge status={project.status} />
        </div>
        {reason && <p className="line-clamp-3 whitespace-pre-line break-words text-sm text-slate-600 dark:text-slate-400">{reason}</p>}
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-slate-500 dark:text-slate-400">{project.status === 'Resolved' ? 'Was frozen' : 'Frozen'}</dt>
            <dd className="font-medium">{formatEth(project.frozenAmount)}</dd>
          </div>
          <div>
            <dt className="text-slate-500 dark:text-slate-400">Your fee rate</dt>
            <dd className="font-medium">{formatFeeRate(project.feeBps)}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-slate-500 dark:text-slate-400">Raised by</dt>
            <dd>
              {raisedByRole(project)} <Address address={project.raisedBy} chainId={chainId} />
            </dd>
          </div>
          {project.status === 'Disputed' && (
            <div className="col-span-2">
              <dt className="text-slate-500 dark:text-slate-400">Arbitration deadline</dt>
              <dd className={now < deadline ? '' : 'text-amber-700 dark:text-amber-300'}>
                {now < deadline
                  ? `Resolve until ${formatDateTime(deadline - 1)} (${formatRelative(deadline, now)})`
                  : `Ended ${formatRelative(deadline, now)}; either party can settle the expired dispute`}
              </dd>
            </div>
          )}
        </dl>
      </Card>
    </Link>
  )
}

function Section({ title, subtitle, items, chainId, now }: { title: string; subtitle: string; items: Item[]; chainId: number; now: number }) {
  if (items.length === 0) return null
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">
          {title} <span className="text-slate-500">({items.length})</span>
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">{subtitle}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <DisputeCard key={item.project.id.toString()} item={item} chainId={chainId} now={now} />
        ))}
      </div>
    </section>
  )
}

/** The arbitrator console: every project that names the connected account as its arbitrator, disputes first. */
export function Arbitration() {
  const { status, account, connect } = useWallet()
  const { chainId, provider, canTransact } = useActiveChain()
  const now = useNow()

  const projects = useQuery({
    queryKey: ['arbitratorProjects', chainId, account],
    queryFn: () => getArbitratorProjects(chainId, provider, account!),
    enabled: status === 'connected' && canTransact && account !== undefined,
    refetchInterval: 15_000,
  })

  const header = (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Arbitration</h1>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Disputes on projects that name your account as their arbitrator. Open one to review the evidence (the reason, each
        milestone's deliverables and the activity timeline) and to resolve it.
      </p>
    </div>
  )

  if (status !== 'connected') {
    return (
      <div className="space-y-6">
        {header}
        <Card className="text-center">
          <p className="text-slate-600 dark:text-slate-400">Connect the arbitrator's wallet to see the disputes assigned to it.</p>
          {status !== 'unavailable' && (
            <button type="button" className={`${buttonClass.primary} mt-4`} onClick={() => void connect()}>
              Connect wallet
            </button>
          )}
        </Card>
      </div>
    )
  }
  if (!canTransact) return <Alert tone="info">Switch your wallet to a supported network to see your disputes.</Alert>

  const queue = projects.data ? arbitratorQueue(projects.data, now) : undefined

  return (
    <div className="space-y-8">
      {header}
      {projects.isPending ? (
        <p className="inline-flex items-center gap-2 text-slate-500">
          <Spinner /> Loading your projects…
        </p>
      ) : projects.isError && !projects.data ? (
        <Alert tone="error">Couldn't load the projects you arbitrate. {describeError(projects.error)}</Alert>
      ) : !queue || projects.data.length === 0 ? (
        <Card className="text-center text-slate-600 dark:text-slate-400">
          No project on this network names your account as its arbitrator. Projects take the platform's default arbitrator when
          they are created.
        </Card>
      ) : (
        <>
          {projects.isError && (
            <Alert tone="warning">Couldn't refresh from the chain, so this may be out of date. {describeError(projects.error)}</Alert>
          )}
          {queue.awaiting.length === 0 && queue.expired.length === 0 && (
            <Alert tone="success">No dispute is waiting for you.</Alert>
          )}
          <Section
            title="Awaiting your resolution"
            subtitle="Resolve each before its deadline; after that, either party can settle the expired dispute with the fixed fallback split instead."
            items={queue.awaiting}
            chainId={chainId}
            now={now}
          />
          <Section
            title="Arbitration period ended"
            subtitle="You can no longer resolve these. Either party can settle the expired dispute."
            items={queue.expired}
            chainId={chainId}
            now={now}
          />
          <Section title="Settled disputes" subtitle="Resolved by you, or settled after the arbitration period expired." items={queue.settled} chainId={chainId} now={now} />
          {queue.other.length > 0 && (
            <p className="text-sm text-slate-500">
              {queue.other.length} other project{queue.other.length === 1 ? '' : 's'} name{queue.other.length === 1 ? 's' : ''} you as
              arbitrator without a dispute.
            </p>
          )}
        </>
      )}
      <TrustNote open />
    </div>
  )
}
