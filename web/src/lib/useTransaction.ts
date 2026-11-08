import { useCallback, useState } from 'react'
import type { ContractTransactionReceipt, ContractTransactionResponse, Signer } from 'ethers'
import { describeError } from './errors'
import { getInjectedProvider } from './ethereum'
import { walletSigner } from './escrow'

export type TxState =
  | { phase: 'idle' }
  | { phase: 'signing' }
  | { phase: 'pending'; hash: string }
  | { phase: 'confirmed'; hash: string }
  | { phase: 'failed'; message: string; hash?: string }

/**
 * Runs one wallet transaction and tracks it through signing, mining and confirmation.
 * ethers estimates gas before the wallet prompt, so most contract reverts fail fast with a decoded reason.
 */
export function useTransaction() {
  const [state, setState] = useState<TxState>({ phase: 'idle' })

  const run = useCallback(
    async (
      send: (signer: Signer) => Promise<ContractTransactionResponse>,
    ): Promise<ContractTransactionReceipt | undefined> => {
      const provider = getInjectedProvider()
      if (!provider) {
        setState({ phase: 'failed', message: 'Install MetaMask to send transactions.' })
        return undefined
      }
      let hash: string | undefined
      try {
        setState({ phase: 'signing' })
        const tx = await send(await walletSigner(provider))
        hash = tx.hash
        setState({ phase: 'pending', hash })
        const receipt = await tx.wait()
        if (!receipt || receipt.status !== 1) throw new Error('The transaction was reverted on-chain.')
        setState({ phase: 'confirmed', hash })
        return receipt
      } catch (error) {
        setState({ phase: 'failed', message: describeError(error), hash })
        return undefined
      }
    },
    [],
  )

  const reset = useCallback(() => setState({ phase: 'idle' }), [])
  const busy = state.phase === 'signing' || state.phase === 'pending'
  return { state, busy, run, reset }
}
