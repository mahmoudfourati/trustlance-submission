import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { getClientProjects, getFreelancerProjects, type Project } from '../lib/escrow'
import { formatEth, formatRelative } from '../lib/format'
import { useActiveChain } from '../lib/useActiveChain'
import { useNow } from '../lib/useNow'
import { useWallet } from '../lib/walletContext'
import { describeError } from '../lib/errors'
import { buttonClass } from '../components/styles'
import { Address, Alert, Card, Spinner, StatusBadge } from '../components/ui'

type Counterparty = 'client' | 'freelancer'

function ProjectCard({ project, chainId, counterparty, now }: { project: Project; chainId: number; counterparty: Counterparty; now: number }) {
  const offerOpen = project.status === 'Open' && now < project.acceptanceDeadline
  return (
    <Link to={`/projects/${project.id}`} className="block transition hover:-translate-y-0.5">
      <Card className="h-full hover:border-indigo-300 dark:hover:border-indigo-500/50">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-semibold">{project.title}</h3>
          <StatusBadge status={project.status} />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-slate-500 dark:text-slate-400">{project.status === 'Disputed' ? 'Frozen' : 'Escrowed'}</dt>
            <dd className="font-medium">{formatEth(project.pendingAmount + project.submittedAmount)}</dd>
          </div>
          <div>
            <dt className="text-slate-500 dark:text-slate-400">Milestones</dt>
            <dd className="font-medium">{project.milestoneCount}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-slate-500 dark:text-slate-400">{counterparty === 'client' ? 'Client' : 'Freelancer'}</dt>
            <dd>
              <Address address={counterparty === 'client' ? project.client : project.freelancer} chainId={chainId} />
            </dd>
          </div>
          {project.status === 'Open' && (
            <div className="col-span-2">
              <dt className="text-slate-500 dark:text-slate-400">Acceptance</dt>
              <dd className={offerOpen ? '' : 'text-amber-700 dark:text-amber-300'}>
                {offerOpen ? `Closes ${formatRelative(project.acceptanceDeadline, now)}` : 'Deadline passed'}
              </dd>
            </div>
          )}
        </dl>
      </Card>
    </Link>
  )
}

function ProjectSection({
  title,
  subtitle,
  query,
  filter = () => true,
  counterparty,
  empty,
  chainId,
  now,
}: {
  title: string
  subtitle?: string
  query: { isPending: boolean; isError: boolean; error: unknown; data?: Project[] }
  filter?: (project: Project) => boolean
  counterparty: Counterparty
  empty: ReactNode
  chainId: number
  now: number
}) {
  const projects = query.data?.filter(filter)
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {subtitle && <p className="text-sm text-slate-600 dark:text-slate-400">{subtitle}</p>}
      </div>
      {query.isPending ? (
        <p className="inline-flex items-center gap-2 text-slate-500">
          <Spinner /> Loading projects…
        </p>
      ) : query.isError ? (
        <Alert tone="error">Couldn't load these projects. {describeError(query.error)}</Alert>
      ) : !projects || projects.length === 0 ? (
        empty
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard key={p.id.toString()} project={p} chainId={chainId} counterparty={counterparty} now={now} />
          ))}
        </div>
      )}
    </section>
  )
}

export function Dashboard() {
  const { status, account, connect } = useWallet()
  const { chainId, provider, canTransact } = useActiveChain()
  const now = useNow()
  const enabled = status === 'connected' && canTransact && account !== undefined

  const clientProjects = useQuery({
    queryKey: ['clientProjects', chainId, account],
    queryFn: () => getClientProjects(chainId, provider, account!),
    enabled,
  })
  const freelancerProjects = useQuery({
    queryKey: ['freelancerProjects', chainId, account],
    queryFn: () => getFreelancerProjects(chainId, provider, account!),
    enabled,
  })

  if (status !== 'connected') {
    return (
      <section className="py-12 text-center">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Milestone escrow for freelance work</h1>
        <p className="mx-auto mt-4 max-w-2xl text-slate-600 dark:text-slate-400">
          Clients lock test ETH for each milestone. Freelancers are paid as work is approved, and a named arbitrator settles
          disputes. Every step is recorded on-chain.
        </p>
        {status !== 'unavailable' && (
          <button type="button" className={`${buttonClass.primary} mt-8`} onClick={() => void connect()}>
            Connect wallet to see your projects
          </button>
        )}
      </section>
    )
  }

  if (!canTransact) {
    return <Alert tone="info">Switch your wallet to a supported network to see your projects.</Alert>
  }

  const isOffer = (p: Project) => p.status === 'Open'
  const hasOffers = freelancerProjects.data?.some(isOffer) ?? false
  const hasWork = freelancerProjects.data?.some((p) => !isOffer(p)) ?? false

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">Read live from the escrow contract.</p>
        </div>
        <Link to="/projects/new" className={buttonClass.primary}>
          New project
        </Link>
      </div>

      {(freelancerProjects.isPending || freelancerProjects.isError || hasOffers) && (
        <ProjectSection
          title="Offers for you"
          subtitle="Projects that name you as the freelancer and wait for your answer."
          query={freelancerProjects}
          filter={isOffer}
          counterparty="client"
          empty={null}
          chainId={chainId}
          now={now}
        />
      )}

      {hasWork && (
        <ProjectSection
          title="Your work as a freelancer"
          query={freelancerProjects}
          filter={(p) => !isOffer(p)}
          counterparty="client"
          empty={null}
          chainId={chainId}
          now={now}
        />
      )}

      <ProjectSection
        title="Projects you created"
        query={clientProjects}
        counterparty="freelancer"
        chainId={chainId}
        now={now}
        empty={
          <Card className="text-center">
            <p className="text-slate-600 dark:text-slate-400">You haven't created a project yet.</p>
            <Link to="/projects/new" className={`${buttonClass.primary} mt-4`}>
              Create your first project
            </Link>
          </Card>
        }
      />
    </div>
  )
}
