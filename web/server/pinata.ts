import type { PinataSigner } from './uploadProxy'

const SIGN_URL = 'https://uploads.pinata.cloud/v3/files/sign'

/**
 * Pinata client that only creates signed upload URLs. The JWT is sent to Pinata and nowhere else;
 * errors never include Pinata's response body, which could echo it.
 */
export function createPinataSigner({
  jwt,
  fetch = globalThis.fetch,
  now = () => Math.floor(Date.now() / 1000),
}: {
  jwt: string
  fetch?: typeof globalThis.fetch
  now?: () => number
}): PinataSigner {
  return {
    async createSignedUploadUrl({ expiresInSeconds, maxFileSize, mimeTypes, fileName, keyvalues }) {
      const response = await fetch(SIGN_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          network: 'public',
          date: now(),
          expires: expiresInSeconds,
          max_file_size: maxFileSize,
          ...(mimeTypes ? { allow_mime_types: mimeTypes } : {}),
          filename: fileName,
          keyvalues,
        }),
      })
      if (!response.ok) throw new Error(`Pinata refused to sign an upload URL (HTTP ${response.status}).`)
      const body = (await response.json()) as { data?: unknown }
      if (typeof body.data !== 'string' || !body.data.startsWith('https://')) {
        throw new Error('Pinata returned an unexpected signed-URL response.')
      }
      return body.data
    },
  }
}
