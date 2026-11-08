import { Wallet, type HDNodeWallet } from 'ethers'
import { describe, expect, it, vi } from 'vitest'
import { uploadAuthorizationMessage } from '../src/lib/uploadMessage'
import {
  MAX_DELIVERABLE_BYTES,
  MAX_MANIFEST_BYTES,
  SIGNATURE_MAX_AGE,
  UPLOAD_URL_TTL,
  createRateLimiter,
  createUploadHandler,
  type ChainReader,
  type PinataSigner,
} from './uploadProxy'

const NOW = 1_800_000_000
const CHAIN_ID = 31337
const ESCROW = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const ProjectStatus = { Open: 0, Active: 1, Cancelled: 3 }
const MilestoneStatus = { Pending: 0, Submitted: 1 }

const freelancer = Wallet.createRandom()
const client = Wallet.createRandom()

function fakeChain(overrides: Partial<{ status: number; freelancer: string; milestones: number[] }> = {}): ChainReader {
  const project = { status: ProjectStatus.Active, freelancer: freelancer.address, milestones: [MilestoneStatus.Pending, MilestoneStatus.Submitted], ...overrides }
  return {
    async getProject(projectId) {
      if (projectId !== 7n) return undefined
      return { status: project.status, freelancer: project.freelancer, milestoneStatuses: project.milestones }
    },
  }
}

function setup(options: { chain?: ChainReader; pinata?: PinataSigner; limit?: number } = {}) {
  const pinata = options.pinata ?? { createSignedUploadUrl: vi.fn(async ({ fileName }) => `https://uploads.pinata.cloud/v3/files/signed/${fileName}`) }
  const handler = createUploadHandler({
    escrowAddresses: { [CHAIN_ID]: ESCROW },
    chainReader: (chainId) => (chainId === CHAIN_ID ? (options.chain ?? fakeChain()) : undefined),
    pinata,
    now: () => NOW,
    rateLimiter: createRateLimiter({ limit: options.limit ?? 100, windowSeconds: 600, now: () => NOW }),
  })
  return { handler, pinata }
}

type Fields = { chainId: number; projectId: string; milestoneIndex: number; account: string; expires: number }

async function signedBody(signer: HDNodeWallet, overrides: Partial<Fields> = {}, signedOverrides: Partial<Fields> = {}) {
  const fields: Fields = { chainId: CHAIN_ID, projectId: '7', milestoneIndex: 0, account: signer.address, expires: NOW + SIGNATURE_MAX_AGE, ...overrides }
  const signature = await signer.signMessage(uploadAuthorizationMessage({ ...fields, escrow: ESCROW, ...signedOverrides }))
  return { ...fields, signature }
}

function post(body: unknown, init: RequestInit = {}) {
  return new Request('http://localhost/api/upload-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  })
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  const body = (await response.json()) as { error: { code: string; message: string } }
  expect(body.error.code).toBe(code)
  expect(body.error.message.length).toBeGreaterThan(0)
}

describe('upload proxy: happy path', () => {
  it('returns a file URL and a manifest URL with the size and time limits', async () => {
    const { handler, pinata } = setup()
    const response = await handler(post(await signedBody(freelancer)))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      file: { url: expect.stringMatching(/^https:\/\//), maxFileSize: MAX_DELIVERABLE_BYTES, expiresAt: NOW + UPLOAD_URL_TTL },
      manifest: { url: expect.stringMatching(/^https:\/\//), maxFileSize: MAX_MANIFEST_BYTES, expiresAt: NOW + UPLOAD_URL_TTL },
    })
    expect(UPLOAD_URL_TTL).toBeLessThanOrEqual(60)
    expect(MAX_DELIVERABLE_BYTES).toBe(50 * 1024 * 1024)

    expect(pinata.createSignedUploadUrl).toHaveBeenCalledTimes(2)
    expect(pinata.createSignedUploadUrl).toHaveBeenCalledWith({
      expiresInSeconds: UPLOAD_URL_TTL,
      maxFileSize: MAX_DELIVERABLE_BYTES,
      fileName: 'trustlance-31337-p7-m0-deliverable',
      keyvalues: { app: 'trustlance', chainId: '31337', projectId: '7', milestoneIndex: '0' },
    })
    expect(pinata.createSignedUploadUrl).toHaveBeenCalledWith({
      expiresInSeconds: UPLOAD_URL_TTL,
      maxFileSize: MAX_MANIFEST_BYTES,
      mimeTypes: ['application/json'],
      fileName: 'trustlance-31337-p7-m0-manifest.json',
      keyvalues: { app: 'trustlance', chainId: '31337', projectId: '7', milestoneIndex: '0' },
    })
  })

  it('accepts a message whose expiry is one second away', async () => {
    const { handler } = setup()
    const response = await handler(post(await signedBody(freelancer, { expires: NOW + 1 })))
    expect(response.status).toBe(200)
  })
})

describe('upload proxy: signature checks', () => {
  it('rejects a signature that is not valid hex', async () => {
    const { handler, pinata } = setup()
    const body = { ...(await signedBody(freelancer)), signature: '0x1234' }
    await expectError(await handler(post(body)), 401, 'invalid-signature')
    expect(pinata.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('rejects a signature made by another account than the one claimed', async () => {
    const { handler } = setup()
    const body = { ...(await signedBody(client)), account: freelancer.address }
    await expectError(await handler(post(body)), 401, 'invalid-signature')
  })

  it('rejects a signature over different fields than the request', async () => {
    const { handler } = setup()
    for (const signed of [{ milestoneIndex: 1 }, { projectId: '8' }, { expires: NOW + 10 }, { chainId: 11155111 }]) {
      await expectError(await handler(post(await signedBody(freelancer, {}, signed))), 401, 'invalid-signature')
    }
  })

  it('rejects a message signed for another escrow contract', async () => {
    const { handler } = setup()
    const fields = { chainId: CHAIN_ID, projectId: '7', milestoneIndex: 0, account: freelancer.address, expires: NOW + 60 }
    const signature = await freelancer.signMessage(
      uploadAuthorizationMessage({ ...fields, escrow: '0x0000000000000000000000000000000000000001' }),
    )
    await expectError(await handler(post({ ...fields, signature })), 401, 'invalid-signature')
  })

  it('rejects an expired message, at exactly its expiry', async () => {
    const { handler } = setup()
    await expectError(await handler(post(await signedBody(freelancer, { expires: NOW }))), 401, 'expired')
    await expectError(await handler(post(await signedBody(freelancer, { expires: NOW - 3600 }))), 401, 'expired')
  })

  it('rejects an expiry more than five minutes away, so a signature stays short-lived', async () => {
    const { handler } = setup()
    await expectError(await handler(post(await signedBody(freelancer, { expires: NOW + SIGNATURE_MAX_AGE + 1 }))), 401, 'invalid-expiry')
  })
})

describe('upload proxy: on-chain checks', () => {
  it('rejects a valid signer who is not the project freelancer', async () => {
    const { handler, pinata } = setup()
    await expectError(await handler(post(await signedBody(client))), 403, 'not-freelancer')
    expect(pinata.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('rejects a project that is not Active', async () => {
    for (const status of [ProjectStatus.Open, ProjectStatus.Cancelled]) {
      const { handler } = setup({ chain: fakeChain({ status }) })
      await expectError(await handler(post(await signedBody(freelancer))), 403, 'project-not-active')
    }
  })

  it('rejects a milestone that is not Pending', async () => {
    const { handler } = setup()
    await expectError(await handler(post(await signedBody(freelancer, { milestoneIndex: 1 }))), 403, 'milestone-not-pending')
  })

  it('rejects an unknown project or milestone index', async () => {
    const { handler } = setup()
    await expectError(await handler(post(await signedBody(freelancer, { projectId: '8' }))), 404, 'unknown-project')
    await expectError(await handler(post(await signedBody(freelancer, { milestoneIndex: 2 }))), 404, 'unknown-milestone')
  })

  it('rejects a chain the proxy is not configured for', async () => {
    const { handler } = setup()
    await expectError(await handler(post(await signedBody(freelancer, { chainId: 1 }))), 400, 'unsupported-chain')
  })
})

describe('upload proxy: request handling', () => {
  it('only accepts POST', async () => {
    const { handler } = setup()
    const response = await handler(new Request('http://localhost/api/upload-url', { method: 'GET' }))
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  it('rejects malformed bodies', async () => {
    const { handler } = setup()
    const valid = await signedBody(freelancer)
    const malformed: unknown[] = [
      'not json',
      [],
      { ...valid, projectId: '-1' },
      { ...valid, projectId: '0' },
      { ...valid, projectId: 7 },
      { ...valid, milestoneIndex: 1.5 },
      { ...valid, milestoneIndex: 20 },
      { ...valid, account: 'not-an-address' },
      { ...valid, expires: '1800000300' },
      { ...valid, signature: undefined },
    ]
    for (const body of malformed) {
      await expectError(await handler(post(body)), 400, 'invalid-request')
    }
  })

  it('rejects an oversized body without parsing it', async () => {
    const { handler } = setup()
    await expectError(await handler(post('x'.repeat(5000))), 413, 'invalid-request')
  })

  it('rate-limits each account after verifying its signature', async () => {
    const { handler } = setup({ limit: 2 })
    expect((await handler(post(await signedBody(freelancer)))).status).toBe(200)
    expect((await handler(post(await signedBody(freelancer)))).status).toBe(200)
    await expectError(await handler(post(await signedBody(freelancer))), 429, 'rate-limited')
    // A forged request for the same account doesn't count against it.
    const { handler: other } = setup({ limit: 1 })
    await expectError(await other(post({ ...(await signedBody(client)), account: freelancer.address })), 401, 'invalid-signature')
    expect((await other(post(await signedBody(freelancer)))).status).toBe(200)
  })

  it('answers 502 without details when Pinata fails', async () => {
    const pinata = { createSignedUploadUrl: vi.fn(async () => Promise.reject(new Error('401 from Pinata: invalid JWT eyJhbGci'))) }
    const { handler } = setup({ pinata })
    const response = await handler(post(await signedBody(freelancer)))
    await expectError(response.clone(), 502, 'upstream-failed')
    expect(await response.text()).not.toContain('eyJ')
  })

  it('answers 502 when the chain cannot be read', async () => {
    const chain: ChainReader = { getProject: async () => Promise.reject(new Error('ECONNREFUSED')) }
    const { handler } = setup({ chain })
    await expectError(await handler(post(await signedBody(freelancer))), 502, 'upstream-failed')
  })
})

describe('createRateLimiter', () => {
  it('allows `limit` requests per window per key and resets after the window', () => {
    let now = 1000
    const limiter = createRateLimiter({ limit: 2, windowSeconds: 60, now: () => now })
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a'), limiter.take('b')]).toEqual([true, true, false, true])
    now += 59
    expect(limiter.take('a')).toBe(false)
    now += 1
    expect(limiter.take('a')).toBe(true)
  })
})
