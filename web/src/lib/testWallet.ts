import { CHAINS } from './chains'
import { RpcErrorCode, type Eip1193Provider } from './ethereum'

/** Controls the end-to-end suite uses to act like a user in MetaMask (see web/e2e). */
export type TestWalletControls = {
  /** Switches to another local account and emits `accountsChanged`, as MetaMask does. */
  switchAccount(index: number): void
  /** Makes the next transaction fail as if the user clicked Reject (EIP-1193 code 4001). */
  rejectNextTransaction(): void
}

declare global {
  interface Window {
    testWallet?: TestWalletControls
  }
}

/**
 * Dev-only stand-in for MetaMask: forwards every request to the local Hardhat node, which signs with
 * its unlocked accounts. Chain state and data stay real; only the wallet popup is skipped.
 * Active only under `vite --mode testwallet`; pick the account with `?testAccount=<index>` (default 2).
 * `?testChain=<id>` makes the wallet report another network until the app asks it to switch.
 */
export function installTestWallet(): void {
  if (!import.meta.env.DEV || import.meta.env.MODE !== 'testwallet') return

  const rpcUrl = CHAINS[31337].rpcUrl
  const search = new URLSearchParams(window.location.search)
  let accountIndex = Number(search.get('testAccount') ?? '2')
  let chainId = Number(search.get('testChain') ?? '31337')
  let rejectNext = false
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const emit = (event: string, value: unknown) => listeners.get(event)?.forEach((listener) => listener(value))
  let nextId = 0

  async function rpc(method: string, params: unknown = []): Promise<unknown> {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
    })
    const body = (await response.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } }
    if (body.error) throw Object.assign(new Error(body.error.message), body.error)
    return body.result
  }

  const currentAccount = async () => ((await rpc('eth_accounts')) as string[])[accountIndex]

  const provider: Eip1193Provider = {
    async request({ method, params }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [await currentAccount()]
      if (method === 'eth_chainId') return `0x${chainId.toString(16)}`
      if (method === 'wallet_switchEthereumChain') {
        const [{ chainId: target }] = params as [{ chainId: string }]
        if (Number(target) !== 31337) throw Object.assign(new Error('Unrecognized chain'), { code: RpcErrorCode.UnrecognizedChain })
        chainId = 31337
        emit('chainChanged', target)
        return null
      }
      if (method === 'wallet_addEthereumChain') return null
      if (method === 'eth_sendTransaction' && rejectNext) {
        rejectNext = false
        throw Object.assign(new Error('User rejected the request.'), { code: RpcErrorCode.UserRejected })
      }
      return rpc(method, params ?? [])
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener)
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener)
    },
  }
  window.ethereum = provider
  window.testWallet = {
    switchAccount(index) {
      accountIndex = index
      void currentAccount().then((account) => emit('accountsChanged', [account]))
    },
    rejectNextTransaction() {
      rejectNext = true
    },
  }
  console.info(`[TrustLance] Test wallet active: local account #${accountIndex}`)
}
