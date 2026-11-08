import { Link, useRouteError } from 'react-router'
import { buttonClass } from '../components/styles'

/** Shown instead of a blank page when a route throws while rendering. */
export function RouteError() {
  const error = useRouteError()
  console.error(error)
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 dark:bg-slate-950">
      <div className="max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Something went wrong</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          The page hit an unexpected error. Your funds are safe: they're held by the contract, not this app.
        </p>
        <Link to="/" reloadDocument className={`${buttonClass.secondary} mt-4`}>
          Reload dashboard
        </Link>
      </div>
    </div>
  )
}
