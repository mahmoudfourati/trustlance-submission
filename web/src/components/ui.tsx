import type { ReactNode } from 'react'
import type { ProjectStatus, MilestoneStatus } from '../lib/escrow'
import { explorerAddressUrl } from '../lib/chains'
import { shortAddress } from '../lib/format'

const STATUS_STYLES: Record<ProjectStatus | MilestoneStatus, string> = {
  Open: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  Active: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-300',
  Completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  Cancelled: 'bg-slate-200 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300',
  Disputed: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  Resolved: 'bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300',
  Pending: 'bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300',
  Submitted: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  Approved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  Refunded: 'bg-slate-200 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300',
}

export function StatusBadge({ status }: { status: ProjectStatus | MilestoneStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>
      {status}
    </span>
  )
}

export function Address({ address, chainId, you }: { address: string; chainId: number; you?: string }) {
  const url = explorerAddressUrl(chainId, address)
  const isYou = you !== undefined && you.toLowerCase() === address.toLowerCase()
  const label = (
    <span className="font-mono text-sm" title={address}>
      {shortAddress(address)}
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1.5">
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="hover:underline">
          {label}
        </a>
      ) : (
        label
      )}
      {isYou && <span className="rounded bg-indigo-50 px-1.5 text-xs text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">you</span>}
    </span>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 ${className}`}>
      {children}
    </div>
  )
}

export function Alert({ tone, children }: { tone: 'info' | 'warning' | 'error' | 'success'; children: ReactNode }) {
  const tones = {
    info: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200',
    warning: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
    error: 'border-red-200 bg-red-50 text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200',
  }
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border px-4 py-3 text-sm ${tones[tone]}`}>
      {children}
    </div>
  )
}

export function Spinner() {
  return <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
}
