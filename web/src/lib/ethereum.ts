/** Minimal EIP-1193 provider surface (MetaMask or a test provider). */
export type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider
  }
}

/** Read lazily so a provider injected after page load (extensions, e2e shims) is still found. */
export function getInjectedProvider(): Eip1193Provider | undefined {
  return typeof window === 'undefined' ? undefined : window.ethereum
}

/** EIP-1193 / MetaMask error codes we react to. */
export const RpcErrorCode = {
  UserRejected: 4001,
  RequestPending: -32002,
  UnrecognizedChain: 4902,
} as const

export function rpcErrorCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code
    if (typeof code === 'number') return code
  }
  return undefined
}
