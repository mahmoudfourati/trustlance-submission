// Local stand-in for Pinata used by the end-to-end suite: signs single-file upload URLs with Pinata's limits, stores the
// uploads under real CIDv1 (raw, sha2-256) identifiers and serves them back as an IPFS gateway. In memory only.
// Run with `node e2e/pinningStore.ts [port]`; the Playwright config starts it.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'

type SignOptions = { expiresInSeconds: number; maxFileSize: number; mimeTypes?: string[]; fileName: string }
type Grant = SignOptions & { expiresAt: number }
type Pin = { cid: string; name: string; type: string; bytes: Uint8Array }

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

function base32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** CIDv1, raw codec, sha2-256 multihash, base32 multibase: what Pinata returns for a single small file. */
export function rawCid(bytes: Uint8Array): string {
  const digest = createHash('sha256').update(bytes).digest()
  return 'b' + base32(new Uint8Array([0x01, 0x55, 0x12, 0x20, ...digest]))
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const isBytes = body instanceof Uint8Array
  res.writeHead(status, { ...CORS, 'content-type': isBytes ? 'application/octet-stream' : 'application/json', ...headers })
  res.end(isBytes ? body : JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

export function startPinningStore(port: number) {
  const grants = new Map<string, Grant>()
  const pins = new Map<string, Pin>()
  const now = () => Math.floor(Date.now() / 1000)
  const origin = `http://127.0.0.1:${port}`

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => send(res, 500, { error: String(error) }))
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', origin)
    if (req.method === 'OPTIONS') return send(res, 204, '')
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true })

    // What the upload proxy calls instead of https://uploads.pinata.cloud/v3/files/sign.
    if (req.method === 'POST' && url.pathname === '/sign') {
      const options = JSON.parse((await readBody(req)).toString('utf8')) as SignOptions
      const token = randomBytes(16).toString('hex')
      grants.set(token, { ...options, expiresAt: now() + options.expiresInSeconds })
      return send(res, 200, { data: `${origin}/upload/${token}` })
    }

    // What the browser posts the deliverable or manifest to, with Pinata's FormData shape and response.
    const upload = /^\/upload\/([0-9a-f]{32})$/.exec(url.pathname)
    if (req.method === 'POST' && upload) {
      const grant = grants.get(upload[1])
      if (!grant) return send(res, 403, { error: 'unknown upload URL' })
      if (now() >= grant.expiresAt) return send(res, 403, { error: 'upload URL expired' })
      const request = new Request(url, { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: new Uint8Array(await readBody(req)) })
      const file = (await request.formData()).get('file')
      if (!(file instanceof File)) return send(res, 400, { error: 'missing file' })
      if (file.size > grant.maxFileSize) return send(res, 413, { error: 'file too large' })
      if (grant.mimeTypes && !grant.mimeTypes.includes(file.type)) return send(res, 415, { error: 'mime type not allowed' })
      const bytes = new Uint8Array(await file.arrayBuffer())
      const cid = rawCid(bytes)
      pins.set(cid, { cid, name: file.name, type: file.type, bytes })
      return send(res, 200, { data: { id: upload[1], cid, name: file.name, size: file.size, mime_type: file.type } })
    }

    const ipfs = /^\/ipfs\/([a-z0-9]+)$/.exec(url.pathname)
    if (req.method === 'GET' && ipfs) {
      const pin = pins.get(ipfs[1])
      return pin ? send(res, 200, pin.bytes, { 'content-length': String(pin.bytes.byteLength) }) : send(res, 404, { error: 'not found' })
    }

    // Test-only inspection: what was pinned, so a test can check that an encrypted deliverable left the browser encrypted.
    if (req.method === 'GET' && url.pathname === '/pins') {
      return send(res, 200, [...pins.values()].map(({ cid, name, type, bytes }) => ({ cid, name, type, size: bytes.byteLength, base64: Buffer.from(bytes).toString('base64') })))
    }

    send(res, 404, { error: 'not found' })
  }

  return new Promise<{ url: string; close(): Promise<void> }>((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({ url: origin, close: () => new Promise<void>((done) => server.close(() => done())) }),
    )
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 8547)
  void startPinningStore(port).then(({ url }) => console.log(`[e2e] Local pinning store at ${url}`))
}
