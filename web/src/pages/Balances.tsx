import { useQuery, useQueryClient } from '@tanstack/react-query'
import { escrowContract, getWithdrawable } from '../lib/escrow'
import { describeError } from '../lib/errors'
import { formatEth } from '../lib/format'
import { useActiveChain } from '../lib/useActiveChain'
import { useTransaction } from '../lib/useTransaction'
import { useWallet } from '../lib/walletContext'
import { CHAINS } from '../lib/chains'
import { TxStatus } from '../components/TxStatus'
import { buttonClass } from '../components/styles'
import { Alert, Card, Spinner } from '../components/ui'

export function Balances() {
  const queryClient = useQueryClient()
  const { status, account, connect } = useWallet()
  const { chainId, provider, canTransact } = useActiveChain()
  const tx = useTransaction()

  const balance = useQuery({
    queryKey: ['withdrawable', chainId, account],
    queryFn: () => getWithdrawable(chainId, provider, account!),
    enabled: canTransact && account !== undefined,
  })

  async function withdraw() {
    const receipt = await tx.run((signer) => escrowContract(chainId, signer).withdraw())
    if (receipt) await queryClient.invalidateQueries()
  }

  if (status !== 'connected') {
    return (
      <Card className="mx-auto max-w-xl text-center">
        <h1 className="text-xl font-semibold">Connect your wallet</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">Connect to see and withdraw your balance.</p>
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
    <div className="mx-auto max-w-xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Balance</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Refunds and payments from all your projects are credited here. Only you can withdraw them, at any time.
        </p>
      </div>
      <Card className="space-y-4">
        <div>
          <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">Withdrawable on {CHAINS[chainId].name}</h2>
          {balance.isPending ? (
            <p className="mt-1 inline-flex items-center gap-2 text-slate-500">
              <Spinner /> Loading…
            </p>
          ) : balance.isError ? (
            <Alert tone="error">Couldn't read your balance. {describeError(balance.error)}</Alert>
          ) : (
            <p className="mt-1 text-3xl font-semibold">{formatEth(balance.data)}</p>
          )}
        </div>
        <TxStatus state={tx.state} chainId={chainId} confirmedText="Withdrawn to your wallet." />
        <button
          type="button"
          className={buttonClass.primary}
          disabled={tx.busy || !balance.isSuccess || balance.data === 0n}
          onClick={() => void withdraw()}
        >
          {tx.busy && <Spinner />}
          {tx.busy ? 'Withdrawing…' : 'Withdraw all'}
        </button>
        {balance.isSuccess && balance.data === 0n && tx.state.phase !== 'confirmed' && (
          <p className="text-xs text-slate-500">Nothing to withdraw yet.</p>
        )}
      </Card>
    </div>
  )
}
