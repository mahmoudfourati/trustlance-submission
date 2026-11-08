import type { Signer } from 'ethers'
import type { Fetch, UploadTarget } from './deliverable'
import { SIGNATURE_LIFETIME, uploadAuthorizationMessage } from './uploadMessage'

export const UPLOAD_PROXY_PATH = '/api/upload-url'

export class UploadProxyError extends Error {
  /** The proxy's error code (e.g. `not-freelancer`), or `network` when it couldn't be reached. */
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'UploadProxyError'
    this.code = code
  }
}

/**
 * Asks the freelancer's wallet to sign an upload authorization (no gas), then exchanges it at the upload
 * proxy for two short-lived signed upload URLs: one for the deliverable, one for its manifest.
 */
export async function requestUploadTargets({
  signer,
  chainId,
  escrow,
  projectId,
  milestoneIndex,
  now = Math.floor(Date.now() / 1000),
  endpoint = UPLOAD_PROXY_PATH,
  fetch = globalThis.fetch,
}: {
  signer: Signer
  chainId: number
  escrow: string
  projectId: bigint
  milestoneIndex: number
  now?: number
  endpoint?: string
  fetch?: Fetch
}): Promise<{ file: UploadTarget; manifest: UploadTarget }> {
  const account = await signer.getAddress()
  const auth = { chainId, escrow, projectId: projectId.toString(), milestoneIndex, account, expires: now + SIGNATURE_LIFETIME }
  const signature = await signer.signMessage(uploadAuthorizationMessage(auth))

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chainId, projectId: auth.projectId, milestoneIndex, account, expires: auth.expires, signature }),
    })
  } catch {
    throw new UploadProxyError('network', "Couldn't reach the upload service. Check your connection and try again.")
  }
  const body = (await response.json().catch(() => undefined)) as
    | { file?: UploadTarget; manifest?: UploadTarget; error?: { code?: string; message?: string } }
    | undefined
  if (!response.ok || !body?.file || !body.manifest) {
    throw new UploadProxyError(
      body?.error?.code ?? 'unknown',
      body?.error?.message ?? `The upload service answered with HTTP ${response.status}.`,
    )
  }
  return { file: body.file, manifest: body.manifest }
}
