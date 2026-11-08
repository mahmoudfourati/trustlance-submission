import { explorerTxUrl } from '../lib/chains'
import type { TxState } from '../lib/useTransaction'
import { Alert, Spinner } from './ui'

function TxLink({ chainId, hash }: { chainId: number; hash: string }) {
  const url = explorerTxUrl(chainId, hash)
  const short = `${hash.slice(0, 10)}…${hash.slice(-6)}`
  return url ? (
    <a className="font-mono underline" href={url} target="_blank" rel="noreferrer">
      {short}
    </a>
  ) : (
    <span className="font-mono" title={hash}>
      {short}
    </span>
  )
}

export function TxStatus({ state, chainId, confirmedText }: { state: TxState; chainId: number; confirmedText: string }) {
  switch (state.phase) {
    case 'idle':
      return null
    case 'signing':
      return (
        <Alert tone="info">
          <span className="inline-flex items-center gap-2">
            <Spinner /> Confirm the transaction in your wallet…
          </span>
        </Alert>
      )
    case 'pending':
      return (
        <Alert tone="info">
          <span className="inline-flex flex-wrap items-center gap-2">
            <Spinner /> Waiting for the transaction to be mined: <TxLink chainId={chainId} hash={state.hash} />
          </span>
        </Alert>
      )
    case 'confirmed':
      return (
        <Alert tone="success">
          {confirmedText} <TxLink chainId={chainId} hash={state.hash} />
        </Alert>
      )
    case 'failed':
      return (
        <Alert tone="error">
          <strong className="font-semibold">Transaction failed.</strong> {state.message}
          {state.hash && (
            <>
              {' '}
              <TxLink chainId={chainId} hash={state.hash} />
            </>
          )}
        </Alert>
      )
  }
}
