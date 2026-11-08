import { createContext, useContext } from 'react'

export type WalletStatus = 'unavailable' | 'disconnected' | 'connecting' | 'connected'

export type WalletContextValue = {
  status: WalletStatus
  account: string | undefined
  chainId: number | undefined
  error: string | undefined
  connect: () => Promise<void>
  switchChain: (chainId: number) => Promise<void>
}

export const WalletContext = createContext<WalletContextValue | undefined>(undefined)

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWallet must be used inside <WalletProvider>')
  return ctx
}
