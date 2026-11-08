import { Link, NavLink, Outlet } from 'react-router'
import { CHAINS, DEFAULT_CHAIN_ID, escrowAddressFor, isSupportedChain } from '../lib/chains'
import { shortAddress } from '../lib/format'
import { useWallet } from '../lib/walletContext'
import { buttonClass } from './styles'
import { Alert, Spinner } from './ui'

function NetworkBadge() {
  const { status, chainId } = useWallet()
  if (status !== 'connected') return null
  const supported = isSupportedChain(chainId)
  return (
    <span
      className={`hidden items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium sm:inline-flex ${
        supported
          ? 'border-emerald-200 text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-300'
          : 'border-red-200 text-red-700 dark:border-red-500/30 dark:text-red-300'
      }`}
    >
      <span className={`size-2 rounded-full ${supported ? 'bg-emerald-500' : 'bg-red-500'}`} />
      {supported ? CHAINS[chainId].name : `Unsupported network (${chainId})`}
    </span>
  )
}

function WalletButton() {
  const { status, account, connect } = useWallet()
  if (status === 'unavailable') {
    return (
      <a className={buttonClass.secondary} href="https://metamask.io/download/" target="_blank" rel="noreferrer">
        Install MetaMask
      </a>
    )
  }
  if (status === 'connected' && account) {
    return (
      <span className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm dark:border-slate-700" title={account}>
        {shortAddress(account)}
      </span>
    )
  }
  return (
    <button type="button" className={buttonClass.primary} onClick={() => void connect()} disabled={status === 'connecting'}>
      {status === 'connecting' && <Spinner />}
      {status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
    </button>
  )
}

function NetworkBanner() {
  const { status, chainId, error, switchChain } = useWallet()
  const target = DEFAULT_CHAIN_ID
  const switchButton = (
    <button type="button" className={`${buttonClass.secondary} mt-2 sm:ml-3 sm:mt-0`} onClick={() => void switchChain(target)}>
      Switch to {CHAINS[target].name}
    </button>
  )

  return (
    <div className="mx-auto max-w-6xl space-y-3 px-4 pt-4 empty:hidden">
      {error && <Alert tone="error">{error}</Alert>}
      {status === 'unavailable' && (
        <Alert tone="info">
          You're browsing read-only. Install MetaMask to create projects and sign transactions.
        </Alert>
      )}
      {status === 'connected' && !isSupportedChain(chainId) && (
        <Alert tone="warning">
          <span className="sm:inline">Your wallet is on a network TrustLance doesn't support. Showing {CHAINS[target].name} read-only.</span>
          {switchButton}
        </Alert>
      )}
      {status === 'connected' && isSupportedChain(chainId) && !escrowAddressFor(chainId) && (
        <Alert tone="warning">
          TrustLance isn't deployed on {CHAINS[chainId].name} yet.
          {chainId !== target && switchButton}
        </Alert>
      )}
    </div>
  )
}

const navClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-2 py-2 text-sm font-medium sm:px-3 ${
    isActive ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-white' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
  }`

export function Layout() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link to="/" className="text-lg font-semibold tracking-tight">
              Trust<span className="text-indigo-600 dark:text-indigo-400">Lance</span>
            </Link>
            <nav className="flex flex-wrap gap-1">
              <NavLink to="/" end className={navClass}>
                Dashboard
              </NavLink>
              <NavLink to="/projects/new" className={navClass}>
                New project
              </NavLink>
              <NavLink to="/balances" className={navClass}>
                Balance
              </NavLink>
              <NavLink to="/arbitration" className={navClass}>
                Arbitration
              </NavLink>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <NetworkBadge />
            <WalletButton />
          </div>
        </div>
      </header>
      <NetworkBanner />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  )
}
