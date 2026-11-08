import { isAddress, verifyMessage } from 'ethers'
import { MAX_DELIVERABLE_BYTES, MAX_MANIFEST_BYTES } from '../src/lib/deliverable'
import { MAX_MILESTONES } from '../src/lib/limits'
import { SIGNATURE_MAX_AGE, uploadAuthorizationMessage } from '../src/lib/uploadMessage'

export { MAX_DELIVERABLE_BYTES, MAX_MANIFEST_BYTES, SIGNATURE_MAX_AGE }

/** Lifetime of each signed Pinata upload URL. */
export const UPLOAD_URL_TTL = 60
const MAX_REQUEST_BYTES = 4 * 1024

// Mirrors the contract's ProjectStatus / MilestoneStatus enums (as src/lib/escrow.ts does; the proxy can't import
// that module because it reads Vite's import.meta.env).
const PROJECT_ACTIVE = 1
const MILESTONE_PENDING = 0

export type ChainReader = {
  /** The project's on-chain state, or undefined when the id doesn't exist. */
  getProject(projectId: bigint): Promise<{ status: number; freelancer: string; milestoneStatuses: number[] } | undefined>
}

export type PinataSigner = {
  createSignedUploadUrl(options: {
    expiresInSeconds: number
    maxFileSize: number
    mimeTypes?: string[]
    fileName: string
    keyvalues: Record<string, string>
  }): Promise<string>
}

export type RateLimiter = { take(key: string): boolean }

export type UploadProxyDeps = {
  /** Escrow address per supported chain id. */
  escrowAddresses: Record<number, string>
  /** Reader for a chain id, or undefined when the proxy has no RPC for it. */
  chainReader(chainId: number): ChainReader | undefined
  pinata: PinataSigner
  /** Unix seconds. */
  now(): number
  rateLimiter: RateLimiter
}

type ErrorCode =
  | 'invalid-request'
  | 'unsupported-chain'
  | 'expired'
  | 'invalid-expiry'
  | 'invalid-signature'
  | 'rate-limited'
  | 'unknown-project'
  | 'unknown-milestone'
  | 'not-freelancer'
  | 'project-not-active'
  | 'milestone-not-pending'
  | 'upstream-failed'
  | 'not-configured'

export function errorResponse(status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { code, message } }, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

type UploadRequest = {
  chainId: number
  projectId: string
  milestoneIndex: number
  account: string
  expires: number
  signature: string
}

function parseUploadRequest(value: unknown): UploadRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  const valid =
    Number.isSafeInteger(v.chainId) &&
    (v.chainId as number) > 0 &&
    typeof v.projectId === 'string' &&
    /^[1-9]\d{0,19}$/.test(v.projectId) &&
    Number.isInteger(v.milestoneIndex) &&
    (v.milestoneIndex as number) >= 0 &&
    (v.milestoneIndex as number) < MAX_MILESTONES &&
    typeof v.account === 'string' &&
    isAddress(v.account) &&
    Number.isSafeInteger(v.expires) &&
    typeof v.signature === 'string' &&
    /^0x[0-9a-fA-F]{2,200}$/.test(v.signature)
  if (!valid) return undefined
  return {
    chainId: v.chainId as number,
    projectId: v.projectId as string,
    milestoneIndex: v.milestoneIndex as number,
    account: v.account as string,
    expires: v.expires as number,
    signature: v.signature as string,
  }
}

/** Reads at most `limit` bytes of the body; returns undefined when it is larger. */
async function readBody(request: Request, limit: number): Promise<string | undefined> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function recoverSigner(message: string, signature: string): string | undefined {
  try {
    return verifyMessage(message, signature)
  } catch {
    return undefined
  }
}

/**
 * The upload proxy: gives a freelancer two short-lived Pinata signed upload URLs (deliverable and manifest)
 * after checking a fresh wallet signature and, on-chain, that they may submit that milestone (ADR 0004).
 * It stores nothing; the Pinata JWT stays inside `deps.pinata`.
 */
export function createUploadHandler(deps: UploadProxyDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'POST') return errorResponse(405, 'invalid-request', 'Use POST.', { allow: 'POST' })

    const text = await readBody(request, MAX_REQUEST_BYTES)
    if (text === undefined) return errorResponse(413, 'invalid-request', 'The request body is too large.')
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return errorResponse(400, 'invalid-request', 'The request body must be JSON.')
    }
    const req = parseUploadRequest(json)
    if (!req) return errorResponse(400, 'invalid-request', 'The upload request is missing fields or has invalid values.')

    const escrow = deps.escrowAddresses[req.chainId]
    const chain = deps.chainReader(req.chainId)
    if (!escrow || !chain) return errorResponse(400, 'unsupported-chain', `Uploads aren't available on chain ${req.chainId}.`)

    const now = deps.now()
    if (req.expires <= now) return errorResponse(401, 'expired', 'The upload authorization has expired. Sign a new one.')
    if (req.expires > now + SIGNATURE_MAX_AGE) {
      return errorResponse(401, 'invalid-expiry', "The upload authorization expires too far ahead. Check your computer's clock.")
    }

    const message = uploadAuthorizationMessage({ ...req, escrow })
    const signer = recoverSigner(message, req.signature)
    if (!signer || signer.toLowerCase() !== req.account.toLowerCase()) {
      return errorResponse(401, 'invalid-signature', "The signature doesn't match this upload request.")
    }

    // Counted only after the signature checks out, so nobody can use up another account's quota.
    if (!deps.rateLimiter.take(signer.toLowerCase())) {
      return errorResponse(429, 'rate-limited', 'Too many upload requests. Wait a few minutes and try again.')
    }

    let project: Awaited<ReturnType<ChainReader['getProject']>>
    try {
      project = await chain.getProject(BigInt(req.projectId))
    } catch {
      return errorResponse(502, 'upstream-failed', "Couldn't read the project from the chain. Try again.")
    }
    if (!project) return errorResponse(404, 'unknown-project', `Project #${req.projectId} doesn't exist.`)
    if (project.freelancer.toLowerCase() !== signer.toLowerCase()) {
      return errorResponse(403, 'not-freelancer', "Only the project's freelancer can upload deliverables.")
    }
    if (project.status !== PROJECT_ACTIVE) {
      return errorResponse(403, 'project-not-active', 'Deliverables can only be uploaded while the project is Active.')
    }
    const milestoneStatus = project.milestoneStatuses[req.milestoneIndex]
    if (milestoneStatus === undefined) {
      return errorResponse(404, 'unknown-milestone', `Project #${req.projectId} has no milestone ${req.milestoneIndex + 1}.`)
    }
    if (milestoneStatus !== MILESTONE_PENDING) {
      return errorResponse(403, 'milestone-not-pending', 'This milestone is not waiting for a submission.')
    }

    const baseName = `trustlance-${req.chainId}-p${req.projectId}-m${req.milestoneIndex}`
    const keyvalues = {
      app: 'trustlance',
      chainId: String(req.chainId),
      projectId: req.projectId,
      milestoneIndex: String(req.milestoneIndex),
    }
    try {
      const [fileUrl, manifestUrl] = await Promise.all([
        deps.pinata.createSignedUploadUrl({
          expiresInSeconds: UPLOAD_URL_TTL,
          maxFileSize: MAX_DELIVERABLE_BYTES,
          fileName: `${baseName}-deliverable`,
          keyvalues,
        }),
        deps.pinata.createSignedUploadUrl({
          expiresInSeconds: UPLOAD_URL_TTL,
          maxFileSize: MAX_MANIFEST_BYTES,
          mimeTypes: ['application/json'],
          fileName: `${baseName}-manifest.json`,
          keyvalues,
        }),
      ])
      const expiresAt = now + UPLOAD_URL_TTL
      return Response.json(
        {
          file: { url: fileUrl, maxFileSize: MAX_DELIVERABLE_BYTES, expiresAt },
          manifest: { url: manifestUrl, maxFileSize: MAX_MANIFEST_BYTES, expiresAt },
        },
        { headers: { 'cache-control': 'no-store' } },
      )
    } catch {
      return errorResponse(502, 'upstream-failed', "Couldn't get an upload URL from IPFS storage. Try again.")
    }
  }
}

/**
 * Fixed-window counter per key. In-memory, so on a serverless host it only limits per warm instance:
 * a best-effort brake, not a guarantee (spec: "rate-limits per address on a best-effort basis").
 */
export function createRateLimiter({ limit, windowSeconds, now }: { limit: number; windowSeconds: number; now: () => number }): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>()
  return {
    take(key) {
      const t = now()
      if (windows.size > 10_000) {
        for (const [k, w] of windows) if (t - w.start >= windowSeconds) windows.delete(k)
      }
      const current = windows.get(key)
      if (!current || t - current.start >= windowSeconds) {
        windows.set(key, { start: t, count: 1 })
        return true
      }
      if (current.count >= limit) return false
      current.count++
      return true
    },
  }
}
