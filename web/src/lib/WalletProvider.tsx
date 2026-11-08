import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getAddress, toBeHex } from 'ethers'
import { CHAINS } from './chains'
import { RpcErrorCode, getInjectedProvider, rpcErrorCode } from './ethereum'
import { describeError } from './errors'
import { WalletContext, type WalletStatus } from './walletContext'

const toAccount = (accounts: unknown): string | undefined =>
  Array.isArray(accounts) && typeof accounts[0] === 'string' ? getAddress(accounts[0]) : undefined

const toChainId = (hex: unknown): number | undefined => (typeof hex === 'string' ? Number.parseInt(hex, 16) : undefined)

export function WalletProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WalletStatus>(() => (getInjectedProvider() ? 'disconnected' : 'unavailable'))
  const [account, setAccount] = useState<string>()
  const [chainId, setChainId] = useState<number>()
  const [error, setError] = useState<string>()

  // Restore an existing authorization without prompting, and follow account/network changes.
  useEffect(() => {
    const provider = getInjectedProvider()
    if (!provider) return
    let cancelled = false

    void (async () => {
      try {
        const [accounts, chain] = await Promise.all([
          provider.request({ method: 'eth_accounts' }),
          provider.request({ method: 'eth_chainId' }),
        ])
        if (cancelled) return
        setChainId(toChainId(chain))
        const restored = toAccount(accounts)
        setAccount(restored)
        setStatus(restored ? 'connected' : 'disconnected')
      } catch {
        // Leave the wallet disconnected; the user can still connect manually.
      }
    })()

    const onAccounts = (accounts: unknown) => {
      const next = toAccount(accounts)
      setAccount(next)
      setStatus(next ? 'connected' : 'disconnected')
    }
    const onChain = (chain: unknown) => setChainId(toChainId(chain))
    provider.on?.('accountsChanged', onAccounts)
    provider.on?.('chainChanged', onChain)
    return () => {
      cancelled = true
      provider.removeListener?.('accountsChanged', onAccounts)
      provider.removeListener?.('chainChanged', onChain)
    }
  }, [])

  const connect = useCallback(async () => {
    const provider = getInjectedProvider()
    if (!provider) {
      setStatus('unavailable')
      return
    }
    setError(undefined)
    setStatus('connecting')
    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts' })
      setChainId(toChainId(await provider.request({ method: 'eth_chainId' })))
      const next = toAccount(accounts)
      setAccount(next)
      setStatus(next ? 'connected' : 'disconnected')
    } catch (err) {
      setError(describeError(err))
      setStatus('disconnected')
    }
  }, [])

  const switchChain = useCallback(async (target: number) => {
    const provider = getInjectedProvider()
    const chain = CHAINS[target]
    if (!provider || !chain) return
    setError(undefined)
    const hexId = toBeHex(target)
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] })
    } catch (err) {
      if (rpcErrorCode(err) !== RpcErrorCode.UnrecognizedChain) {
        setError(describeError(err))
        return
      }
      try {
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: hexId,
              chainName: chain.name,
              rpcUrls: [chain.rpcUrl],
              nativeCurrency: chain.nativeCurrency,
              blockExplorerUrls: chain.explorerUrl ? [chain.explorerUrl] : undefined,
            },
          ],
        })
      } catch (addErr) {
        setError(describeError(addErr))
      }
    }
  }, [])

  const value = useMemo(
    () => ({ status, account, chainId, error, connect, switchChain }),
    [status, account, chainId, error, connect, switchChain],
  )
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}
