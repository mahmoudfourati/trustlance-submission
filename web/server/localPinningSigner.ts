import type { PinataSigner } from './uploadProxy'

/**
 * Dev-only stand-in for Pinata's signing endpoint: asks the end-to-end suite's local pinning store (web/e2e) for a
 * signed upload URL with the same limits. The dev server uses it when E2E_PINNING_STORE_URL is set; the Vercel
 * function never does.
 */
export function createLocalPinningSigner(storeUrl: string, fetch = globalThis.fetch): PinataSigner {
  return {
    async createSignedUploadUrl(options) {
      const response = await fetch(new URL('/sign', storeUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(options),
      })
      if (!response.ok) throw new Error(`The local pinning store refused to sign an upload URL (HTTP ${response.status}).`)
      const body = (await response.json()) as { data?: unknown }
      if (typeof body.data !== 'string') throw new Error('The local pinning store returned an unexpected response.')
      return body.data
    },
  }
}
