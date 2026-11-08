import { useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { escrowContract, getPlatformConfig } from '../lib/escrow'
import { describeError } from '../lib/errors'
import { formatEth, formatFeeRate } from '../lib/format'
import { DAY, MAX_MILESTONES, MAX_REVIEW_WINDOW, MAX_TITLE_BYTES, MIN_REVIEW_WINDOW } from '../lib/limits'
import { emptyMilestone, validateProjectDraft, type DraftErrors, type MilestoneDraft, type ProjectDraft } from '../lib/projectForm'
import { useActiveChain } from '../lib/useActiveChain'
import { useNow } from '../lib/useNow'
import { useTransaction } from '../lib/useTransaction'
import { useWallet } from '../lib/walletContext'
import { TrustNote } from '../components/TrustNote'
import { TxStatus } from '../components/TxStatus'
import { buttonClass } from '../components/styles'
import { Address, Alert, Card, Spinner } from '../components/ui'

const inputClass =
  'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-950'

function FieldError({ message }: { message?: string }) {
  return message ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{message}</p> : null
}

/** `datetime-local` value one week from now, in the browser's time zone. */
function defaultDeadlineInput(): string {
  const d = new Date(Date.now() + 7 * DAY * 1000)
  d.setSeconds(0, 0)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

export function CreateProject() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { status, account, connect } = useWallet()
  const { chainId, provider, canTransact } = useActiveChain()
  const tx = useTransaction()
  const now = useNow()

  const [form, setForm] = useState({
    title: '',
    description: '',
    freelancer: '',
    deadline: defaultDeadlineInput(),
    reviewWindowDays: '7',
  })
  const [milestones, setMilestones] = useState<MilestoneDraft[]>([emptyMilestone()])
  // Errors stay hidden until the first submit attempt, then follow every edit.
  const [attempted, setAttempted] = useState(false)

  const platform = useQuery({
    queryKey: ['platform', chainId],
    queryFn: () => getPlatformConfig(chainId, provider),
    enabled: canTransact,
  })

  const draft: ProjectDraft = useMemo(
    () => ({
      title: form.title,
      description: form.description,
      freelancer: form.freelancer,
      acceptanceDeadline: form.deadline ? Math.floor(new Date(form.deadline).getTime() / 1000) : undefined,
      reviewWindowDays: form.reviewWindowDays,
      milestones,
    }),
    [form, milestones],
  )

  const validation = useMemo(
    () => validateProjectDraft(draft, { client: account, arbitrator: platform.data?.defaultArbitrator, now }),
    [draft, account, platform.data?.defaultArbitrator, now],
  )
  const runningTotal = validation.ok ? validation.total : undefined
  const errors: DraftErrors = attempted && !validation.ok ? validation.errors : {}


  const updateMilestone = (index: number, patch: Partial<MilestoneDraft>) =>
    setMilestones((list) => list.map((m, i) => (i === index ? { ...m, ...patch } : m)))

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setAttempted(true)
    if (!validation.ok) return
    const { params, total } = validation
    const receipt = await tx.run((signer) => escrowContract(chainId, signer).createProject(params, { value: total }))
    if (!receipt) return
    const escrow = escrowContract(chainId, provider)
    const created = receipt.logs
      .map((log) => {
        try {
          return escrow.interface.parseLog(log)
        } catch {
          return null
        }
      })
      .find((parsed) => parsed?.name === 'ProjectCreated')
    await queryClient.invalidateQueries()
    if (created) navigate(`/projects/${created.args.projectId}`)
  }

  if (status !== 'connected') {
    return (
      <Card className="mx-auto max-w-xl text-center">
        <h1 className="text-xl font-semibold">Connect your wallet</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">You need a wallet to fund a project.</p>
        {status !== 'unavailable' && (
          <button type="button" className={`${buttonClass.primary} mt-4`} onClick={() => void connect()}>
            Connect wallet
          </button>
        )}
      </Card>
    )
  }
  if (!canTransact) {
    return <Alert tone="warning">Switch your wallet to a supported network where TrustLance is deployed.</Alert>
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="mx-auto max-w-3xl space-y-6" noValidate>
      <div>
        <h1 className="text-2xl font-bold tracking-tight">New project</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          You fund every milestone now, in the same transaction. The freelancer is paid as you approve work.
        </p>
      </div>

      <Card className="space-y-4">
        <label className="block text-sm font-medium">
          Title
          <input className={inputClass} value={form.title} maxLength={MAX_TITLE_BYTES} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <FieldError message={errors.title} />
        </label>
        <label className="block text-sm font-medium">
          Description <span className="font-normal text-slate-500">(optional, public on-chain)</span>
          <textarea
            className={`${inputClass} min-h-24`}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <FieldError message={errors.description} />
        </label>
        <label className="block text-sm font-medium">
          Freelancer address
          <input
            className={`${inputClass} font-mono`}
            placeholder="0x…"
            value={form.freelancer}
            onChange={(e) => setForm({ ...form, freelancer: e.target.value })}
          />
          <FieldError message={errors.freelancer} />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium">
            Freelancer must accept before
            <input
              type="datetime-local"
              className={inputClass}
              value={form.deadline}
              onChange={(e) => setForm({ ...form, deadline: e.target.value })}
            />
            <FieldError message={errors.acceptanceDeadline} />
          </label>
          <label className="block text-sm font-medium">
            Review window (days)
            <input
              type="number"
              min={MIN_REVIEW_WINDOW / DAY}
              max={MAX_REVIEW_WINDOW / DAY}
              step={1}
              className={inputClass}
              value={form.reviewWindowDays}
              onChange={(e) => setForm({ ...form, reviewWindowDays: e.target.value })}
            />
            <FieldError message={errors.reviewWindowDays} />
          </label>
        </div>
      </Card>

      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Milestones</h2>
          <span className="text-sm text-slate-500">
            {milestones.length} / {MAX_MILESTONES}
          </span>
        </div>
        <FieldError message={errors.milestones} />
        {milestones.map((m, i) => (
          <fieldset key={i} className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
            <legend className="px-1 text-sm font-medium">Milestone {i + 1}</legend>
            <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
              <label className="block text-sm">
                Title
                <input className={inputClass} value={m.title} onChange={(e) => updateMilestone(i, { title: e.target.value })} />
                <FieldError message={errors[`milestones.${i}.title`]} />
              </label>
              <label className="block text-sm">
                Amount (ETH)
                <input
                  className={inputClass}
                  inputMode="decimal"
                  placeholder="0.5"
                  value={m.amountEth}
                  onChange={(e) => updateMilestone(i, { amountEth: e.target.value })}
                />
                <FieldError message={errors[`milestones.${i}.amountEth`]} />
              </label>
              <label className="block text-sm">
                Delivery within
                <div className="flex gap-2">
                  <input
                    type="number"
                    min={1}
                    className={inputClass}
                    value={m.deliveryValue}
                    onChange={(e) => updateMilestone(i, { deliveryValue: e.target.value })}
                  />
                  <select
                    className={inputClass}
                    value={m.deliveryUnit}
                    onChange={(e) => updateMilestone(i, { deliveryUnit: e.target.value as MilestoneDraft['deliveryUnit'] })}
                  >
                    <option value="days">days</option>
                    <option value="hours">hours</option>
                  </select>
                </div>
                <FieldError message={errors[`milestones.${i}.deliveryValue`]} />
              </label>
            </div>
            {milestones.length > 1 && (
              <button
                type="button"
                className="mt-2 text-xs text-red-600 hover:underline dark:text-red-400"
                onClick={() => setMilestones((list) => list.filter((_, j) => j !== i))}
              >
                Remove milestone
              </button>
            )}
          </fieldset>
        ))}
        <button
          type="button"
          className={buttonClass.secondary}
          disabled={milestones.length >= MAX_MILESTONES}
          onClick={() => setMilestones((list) => [...list, emptyMilestone()])}
        >
          Add milestone
        </button>
        <p className="text-xs text-slate-500">Delivery periods start when the freelancer accepts the project.</p>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-semibold">Review and fund</h2>
        {platform.isPending ? (
          <p className="inline-flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Loading platform settings…
          </p>
        ) : platform.isError ? (
          <Alert tone="error">Couldn't read the platform settings. {describeError(platform.error)}</Alert>
        ) : (
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Arbitrator</dt>
              <dd>
                <Address address={platform.data.defaultArbitrator} chainId={chainId} />
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Arbitration fee</dt>
              <dd className="font-medium">{formatFeeRate(platform.data.arbitrationFeeBps)} of disputed funds, only if a dispute is resolved</dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">You'll send</dt>
              <dd className="text-lg font-semibold">{runningTotal !== undefined ? formatEth(runningTotal) : '—'}</dd>
            </div>
          </dl>
        )}
        <TrustNote />
        <FieldError message={errors.client} />
        <TxStatus state={tx.state} chainId={chainId} confirmedText="Project created and funded." />
        <button type="submit" className={buttonClass.primary} disabled={tx.busy || !platform.isSuccess}>
          {tx.busy && <Spinner />}
          {tx.busy ? 'Creating…' : 'Create and fund project'}
        </button>
        {Object.keys(errors).length > 0 && <p className="text-sm text-red-600 dark:text-red-400">Fix the highlighted fields first.</p>}
      </Card>
    </form>
  )
}
