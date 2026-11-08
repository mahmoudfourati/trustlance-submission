import { escrowAddresses } from '../contracts/generated/deployments'

export type ChainConfig = {
  id: number
  name: string
  rpcUrl: string
  explorerUrl?: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  /** Blocks (including the event's own) before the timeline shows an event as confirmed. */
  confirmations: number
  /** Widest `eth_getLogs` block range to try; narrowed automatically if the RPC rejects it. */
  maxLogRange: number
}

const ETH = { name: 'Ether', symbol: 'ETH', decimals: 18 }

export const CHAINS: Record<number, ChainConfig> = {
  31337: {
    id: 31337,
    name: 'Hardhat Local',
    rpcUrl: import.meta.env.VITE_LOCAL_RPC_URL ?? 'http://127.0.0.1:8545',
    nativeCurrency: ETH,
    // Automine: a block is final as soon as it exists.
    confirmations: 1,
    maxLogRange: 1_000_000,
  },
  11155111: {
    id: 11155111,
    name: 'Sepolia',
    // Reads, including the event logs behind titles and the timeline, need an RPC that keeps the full log history:
    // publicnode only serves roughly the last 10,000 blocks ("pruned history unavailable").
    rpcUrl: import.meta.env.VITE_SEPOLIA_RPC_URL ?? 'https://sepolia.gateway.tenderly.co',
    explorerUrl: 'https://sepolia.etherscan.io',
    nativeCurrency: { ...ETH, name: 'Sepolia Ether' },
    // About a minute of 12-second slots, enough to ride out the short reorgs Sepolia sees.
    confirmations: 5,
    // Keep this small: some free RPCs silently return partial results for very wide ranges instead of an error.
    maxLogRange: 10_000,
  },
}

/** Chain used for read-only browsing when no wallet is connected to a supported chain. */
export const DEFAULT_CHAIN_ID = Number(import.meta.env.VITE_DEFAULT_CHAIN_ID ?? 31337)

export function isSupportedChain(chainId: number | undefined): chainId is number {
  return chainId !== undefined && chainId in CHAINS
}

export function escrowAddressFor(chainId: number): string | undefined {
  return escrowAddresses[chainId]
}

export function explorerTxUrl(chainId: number, hash: string): string | undefined {
  const base = CHAINS[chainId]?.explorerUrl
  return base ? `${base}/tx/${hash}` : undefined
}

export function explorerAddressUrl(chainId: number, address: string): string | undefined {
  const base = CHAINS[chainId]?.explorerUrl
  return base ? `${base}/address/${address}` : undefined
}
