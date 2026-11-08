import { useMemo } from 'react'
import { DEFAULT_CHAIN_ID, escrowAddressFor, isSupportedChain } from './chains'
import { readProviderFor } from './escrow'
import { useWallet } from './walletContext'

/**
 * The chain the app reads from: the wallet's chain when it is supported, otherwise the default chain,
 * so visitors without a wallet can still browse.
 */
export function useActiveChain() {
  const { status, chainId: walletChainId } = useWallet()
  const walletConnected = status === 'connected'
  const walletOnSupportedChain = walletConnected && isSupportedChain(walletChainId)
  const chainId = walletOnSupportedChain ? walletChainId! : DEFAULT_CHAIN_ID

  return useMemo(
    () => ({
      chainId,
      provider: readProviderFor(chainId),
      deployed: escrowAddressFor(chainId) !== undefined,
      /** True when the wallet can sign for the chain being shown. */
      canTransact: walletOnSupportedChain && escrowAddressFor(chainId) !== undefined,
    }),
    [chainId, walletOnSupportedChain],
  )
}
