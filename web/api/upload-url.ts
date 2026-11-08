// Vercel Function entry for the upload proxy (ADR 0004). Settings come from the host environment.
import { createUploadHandlerFromEnv } from '../server/config'

const handler = createUploadHandlerFromEnv(process.env)

export function POST(request: Request): Promise<Response> {
  return handler(request)
}
