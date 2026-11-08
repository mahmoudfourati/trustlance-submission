import type { IncomingMessage, ServerResponse } from 'node:http'
import { createUploadHandlerFromEnv } from './config'
import { createLocalPinningSigner } from './localPinningSigner'
import { handleNodeRequest } from './nodeAdapter'

let cached: { env: Record<string, string>; handler: (request: Request) => Promise<Response> } | undefined

/**
 * Serves the upload proxy from the Vite dev server, with server-only settings from web/.env.local.
 * E2E_PINNING_STORE_URL (set only by the end-to-end suite) swaps Pinata for its local pinning store.
 */
export function serveUploadProxy(env: Record<string, string>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (cached?.env !== env) {
    const store = env.E2E_PINNING_STORE_URL?.trim()
    cached = { env, handler: createUploadHandlerFromEnv(env, store ? createLocalPinningSigner(store) : undefined) }
  }
  return handleNodeRequest(cached.handler, req, res)
}
