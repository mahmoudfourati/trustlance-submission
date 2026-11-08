import { Contract, JsonRpcProvider } from 'ethers'
import { escrowAbi } from '../src/contracts/generated/escrowAbi'
import { escrowAddresses } from '../src/contracts/generated/deployments'
import { createPinataSigner } from './pinata'
import { createRateLimiter, createUploadHandler, errorResponse, type ChainReader, type PinataSigner } from './uploadProxy'

type Env = Record<string, string | undefined>

const LOCAL_CHAIN_ID = 31337
const RPC_ENV_PREFIX = 'UPLOAD_PROXY_RPC_URL_'

export type ProxyConfig = {
  pinataJwt: string | undefined
  /** RPC URL per chain id the proxy may serve. */
  rpcUrls: Record<number, string>
}

/** Server-side settings. Read from the host environment only; see web/.env.example. */
export function readProxyConfig(env: Env): ProxyConfig {
  const rpcUrls: Record<number, string> = { [LOCAL_CHAIN_ID]: 'http://127.0.0.1:8545' }
  for (const [key, value] of Object.entries(env)) {
    const chainId = Number(key.slice(RPC_ENV_PREFIX.length))
    if (key.startsWith(RPC_ENV_PREFIX) && Number.isSafeInteger(chainId) && value?.trim()) rpcUrls[chainId] = value.trim()
  }
  return { pinataJwt: env.PINATA_JWT?.trim() || undefined, rpcUrls }
}

function ethersChainReader(rpcUrl: string, chainId: number, escrowAddress: string): ChainReader {
  const escrow = new Contract(escrowAddress, escrowAbi, new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true }))
  return {
    async getProject(projectId) {
      if (projectId === 0n || projectId > ((await escrow.projectCount()) as bigint)) return undefined
      const [project, milestones] = await Promise.all([
        escrow.getProject(projectId) as Promise<{ status: bigint; freelancer: string }>,
        escrow.getMilestones(projectId) as Promise<{ status: bigint }[]>,
      ])
      return {
        status: Number(project.status),
        freelancer: project.freelancer,
        milestoneStatuses: milestones.map((m) => Number(m.status)),
      }
    },
  }
}

/**
 * Builds the production handler from environment variables, or a 503 handler when Pinata isn't configured.
 * `signer` replaces Pinata; only the dev server passes one, for the end-to-end suite's local pinning store.
 */
export function createUploadHandlerFromEnv(env: Env, signer?: PinataSigner): (request: Request) => Promise<Response> {
  const config = readProxyConfig(env)
  const now = () => Math.floor(Date.now() / 1000)
  const pinata = signer ?? (config.pinataJwt ? createPinataSigner({ jwt: config.pinataJwt, now }) : undefined)
  if (!pinata) {
    return async () => errorResponse(503, 'not-configured', 'Deliverable uploads are not configured on this server.')
  }

  const readers = new Map<number, ChainReader>()
  return createUploadHandler({
    escrowAddresses,
    chainReader(chainId) {
      const rpcUrl = config.rpcUrls[chainId]
      const escrow = escrowAddresses[chainId]
      if (!rpcUrl || !escrow) return undefined
      let reader = readers.get(chainId)
      if (!reader) {
        reader = ethersChainReader(rpcUrl, chainId, escrow)
        readers.set(chainId, reader)
      }
      return reader
    },
    pinata,
    now,
    rateLimiter: createRateLimiter({ limit: 10, windowSeconds: 10 * 60, now }),
  })
}
