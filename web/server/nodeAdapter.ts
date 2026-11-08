import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

type Handler = (request: Request) => Promise<Response>

/** Runs a Fetch-API handler behind a Node HTTP server (the Vite dev server's middleware stack). */
export async function handleNodeRequest(handler: Handler, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) for (const v of value) headers.append(name, v)
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  const request = new Request(new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`), {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    duplex: 'half',
  } as RequestInit)

  const response = await handler(request)
  res.statusCode = response.status
  response.headers.forEach((value, name) => res.setHeader(name, value))
  res.end(Buffer.from(await response.arrayBuffer()))
}
