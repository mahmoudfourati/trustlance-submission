import { LIMIT_TEXT } from '../lib/limits'

/** The spec's arbitration trust assumptions, shown wherever a dispute can be raised, settled or decided. */
export function TrustNote({ open = false }: { open?: boolean }) {
  return (
    <details open={open} className="rounded-lg border border-slate-200 p-3 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-400">
      <summary className="cursor-pointer font-medium text-slate-700 dark:text-slate-300">What the arbitrator can and can't do</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          The arbitrator can give the frozen funds to either party in any proportion, and could collude with one side. Only fund
          projects whose arbitrator you accept.
        </li>
        <li>
          The arbitrator can't touch approved milestones, refunds made before the dispute, existing balances or other projects,
          and can't take more than the fee rate fixed when the project was created.
        </li>
        <li>
          The arbitrator can delay a dispute by up to {LIMIT_TEXT.arbitrationPeriod}. After that, either party can settle the
          expired dispute with the fixed fallback split.
        </li>
        <li>
          On Sepolia the admin and the arbitrator are demo accounts run by the project team. That's acceptable only because only
          test ETH is used.
        </li>
      </ul>
    </details>
  )
}
