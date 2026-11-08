import { explorerTxUrl } from '../lib/chains'
import { formatDateTime, shortAddress } from '../lib/format'
import type { TimelineEntry } from '../lib/timeline'
import { Address } from './ui'

/** The project's on-chain activity, oldest first, read from the contract's event logs. */
export function Timeline({ entries, chainId, account }: { entries: TimelineEntry[]; chainId: number; account?: string }) {
  if (entries.length === 0) return <p className="mt-2 text-sm text-slate-500">No activity found in the contract's logs yet.</p>
  return (
    <ol className="mt-3 space-y-4 border-l border-slate-200 pl-5 dark:border-slate-800">
      {entries.map((entry) => (
        <TimelineItem key={entry.key} entry={entry} chainId={chainId} account={account} />
      ))}
    </ol>
  )
}

function TimelineItem({ entry, chainId, account }: { entry: TimelineEntry; chainId: number; account?: string }) {
  const txUrl = explorerTxUrl(chainId, entry.transactionHash)
  const dot = entry.endsProject ? 'bg-emerald-500' : entry.confirmed ? 'bg-indigo-500' : 'bg-amber-400'
  return (
    <li className="relative">
      <span aria-hidden className={`absolute top-1.5 -left-[25px] size-2.5 rounded-full ring-4 ring-white dark:ring-slate-900 ${dot}`} />
      <p className="text-sm font-medium break-words">
        {entry.title}
        {!entry.confirmed && (
          <span
            className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-normal text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
            title="This block doesn't have enough confirmations yet and could still be reorganised away."
          >
            unconfirmed
          </span>
        )}
      </p>
      {entry.detail && <p className="mt-0.5 text-sm break-words whitespace-pre-line text-slate-600 dark:text-slate-400">{entry.detail}</p>}
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <time dateTime={new Date(entry.timestamp * 1000).toISOString()}>{formatDateTime(entry.timestamp)}</time>
        <span className="inline-flex items-center gap-1">
          by {entry.actorRole ?? 'a third party'} <Address address={entry.from} chainId={chainId} you={account} />
        </span>
        <span>block {entry.blockNumber}</span>
        {txUrl ? (
          <a href={txUrl} target="_blank" rel="noreferrer" className="font-mono hover:underline" title={entry.transactionHash}>
            tx {shortAddress(entry.transactionHash)} ↗
          </a>
        ) : (
          <span className="font-mono" title={entry.transactionHash}>
            tx {shortAddress(entry.transactionHash)}
          </span>
        )}
      </p>
    </li>
  )
}
