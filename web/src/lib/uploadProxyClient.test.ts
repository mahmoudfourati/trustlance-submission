import { Wallet } from 'ethers'
import { describe, expect, it } from 'vitest'
import { createRateLimiter, createUploadHandler } from '../../server/uploadProxy'
import { UploadProxyError, requestUploadTargets } from './uploadProxyClient'

const NOW = 1_800_000_000
const ESCROW = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const freelancer = Wallet.createRandom()

function proxyFetch(freelancerAddress = freelancer.address) {
  const handler = createUploadHandler({
    escrowAddresses: { 31337: ESCROW },
    chainReader: () => ({
      getProject: async () => ({ status: 1, freelancer: freelancerAddress, milestoneStatuses: [0] }),
    }),
    pinata: { createSignedUploadUrl: async ({ fileName }) => `https://uploads.test/${fileName}` },
    now: () => NOW,
    rateLimiter: createRateLimiter({ limit: 10, windowSeconds: 600, now: () => NOW }),
  })
  return (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(new URL(String(input), 'http://localhost'), init))
}

describe('requestUploadTargets', () => {
  it('signs the authorization message and gets upload targets the proxy accepts', async () => {
    const targets = await requestUploadTargets({
      signer: freelancer,
      chainId: 31337,
      escrow: ESCROW,
      projectId: 7n,
      milestoneIndex: 0,
      now: NOW,
      fetch: proxyFetch(),
    })
    expect(targets.file.url).toBe('https://uploads.test/trustlance-31337-p7-m0-deliverable')
    expect(targets.manifest.url).toBe('https://uploads.test/trustlance-31337-p7-m0-manifest.json')
  })

  it('signs a shorter lifetime than the proxy allows, so a client clock a few minutes ahead still works', async () => {
    const targets = await requestUploadTargets({
      signer: freelancer,
      chainId: 31337,
      escrow: ESCROW,
      projectId: 7n,
      milestoneIndex: 0,
      now: NOW + 170,
      fetch: proxyFetch(),
    })
    expect(targets.file.url).toMatch(/deliverable$/)
  })

  it("surfaces the proxy's error code and message", async () => {
    const error = await requestUploadTargets({
      signer: freelancer,
      chainId: 31337,
      escrow: ESCROW,
      projectId: 7n,
      milestoneIndex: 0,
      now: NOW,
      fetch: proxyFetch(Wallet.createRandom().address),
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(UploadProxyError)
    expect((error as UploadProxyError).code).toBe('not-freelancer')
    expect((error as UploadProxyError).message).toBe("Only the project's freelancer can upload deliverables.")
  })

  it('reports an unreachable proxy as a network failure', async () => {
    const error = await requestUploadTargets({
      signer: freelancer,
      chainId: 31337,
      escrow: ESCROW,
      projectId: 7n,
      milestoneIndex: 0,
      now: NOW,
      fetch: async () => Promise.reject(new TypeError('fetch failed')),
    }).catch((e: unknown) => e)
    expect((error as UploadProxyError).code).toBe('network')
  })
})
