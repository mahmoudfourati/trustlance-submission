import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, loadEnv, type Plugin } from 'vite'

type DevMiddlewareModule = {
  serveUploadProxy(env: Record<string, string>, req: IncomingMessage, res: ServerResponse): Promise<void>
}

/**
 * Serves the upload proxy at /api/upload-url next to the dev server, as Vercel does in production.
 * Server-only settings (PINATA_JWT, UPLOAD_PROXY_RPC_URL_*) are read here and never reach the browser bundle,
 * which only sees VITE_-prefixed variables.
 */
function uploadProxy(mode: string): Plugin {
  return {
    name: 'trustlance-upload-proxy',
    configureServer(server) {
      const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env } as Record<string, string>
      // The end-to-end suite's local pinning store replaces Pinata only in test-wallet mode, like the other test seams.
      if (mode !== 'testwallet') delete env.E2E_PINNING_STORE_URL
      server.middlewares.use('/api/upload-url', (req, res, next) => {
        server
          .ssrLoadModule('/server/devMiddleware.ts')
          .then((mod) => (mod as DevMiddlewareModule).serveUploadProxy(env, req, res))
          .catch(next)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), uploadProxy(mode)],
}))
