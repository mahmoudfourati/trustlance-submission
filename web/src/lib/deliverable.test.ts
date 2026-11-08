import { describe, expect, it, vi } from 'vitest'
import {
  DeliverableError,
  MAX_PBKDF2_ITERATIONS,
  PBKDF2_ITERATIONS,
  PUBLIC_GATEWAYS,
  fetchDeliverable,
  fetchManifest,
  gatewayList,
  pinataUploader,
  safeFileName,
  sha256Hex,
  uploadDeliverable,
  type DeliverableManifest,
  type Uploader,
} from './deliverable'

const PRIMARY = 'https://primary.test/ipfs/'
const FALLBACK = 'https://fallback.test/ipfs/'
const targets = {
  file: { url: 'https://uploads.test/signed-file', maxFileSize: 50 * 1024 * 1024 },
  manifest: { url: 'https://uploads.test/signed-manifest', maxFileSize: 16 * 1024 },
}

const encoder = new TextEncoder()
const sampleFile = () => ({ name: 'design-v1.pdf', type: 'application/pdf', bytes: encoder.encode('%PDF-1.7 the real deliverable') })

/** In-memory IPFS: uploads return a fake CID, gateway fetches serve the stored bytes. */
function fakeIpfs() {
  const store = new Map<string, Uint8Array>()
  const upload: Uploader = async (_target, body) => {
    const bytes = new Uint8Array(await body.arrayBuffer())
    const cid = 'b' + [...(await sha256Hex(bytes))].map((c) => 'abcdefghijklmnop'[parseInt(c, 16)]).join('')
    store.set(cid, bytes)
    return cid
  }
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const cid = url.slice(url.lastIndexOf('/') + 1)
    const bytes = store.get(cid)
    return bytes ? new Response(bytes.slice()) : new Response('not found', { status: 404 })
  })
  return { store, upload, fetch }
}

describe('deliverable round trip', () => {
  it('encrypts with a passphrase, uploads file and manifest, then fetches, decrypts and hash-checks', async () => {
    const ipfs = fakeIpfs()
    const file = sampleFile()

    const { manifestCid, manifest } = await uploadDeliverable({ file, passphrase: 'correct horse', targets, upload: ipfs.upload })

    expect(manifest).toMatchObject({
      schema: 'trustlance.deliverable',
      version: 1,
      name: 'design-v1.pdf',
      mimeType: 'application/pdf',
      size: file.bytes.length,
      sha256: await sha256Hex(file.bytes),
      encryption: { algorithm: 'AES-256-GCM', kdf: 'PBKDF2-SHA-256', iterations: PBKDF2_ITERATIONS },
    })
    // What was pinned is ciphertext, not the plaintext.
    const pinned = ipfs.store.get(manifest.fileCid)!
    expect(new TextDecoder().decode(pinned)).not.toContain('real deliverable')

    const result = await fetchDeliverable(manifestCid, { passphrase: 'correct horse', gateways: [PRIMARY], fetch: ipfs.fetch })
    expect(result.bytes).toEqual(file.bytes)
    expect(result.manifest).toEqual(manifest)
  })

  it('uses a fresh salt and IV for every encryption', async () => {
    const ipfs = fakeIpfs()
    const a = await uploadDeliverable({ file: sampleFile(), passphrase: 'p', targets, upload: ipfs.upload })
    const b = await uploadDeliverable({ file: sampleFile(), passphrase: 'p', targets, upload: ipfs.upload })
    expect(a.manifest.encryption!.salt).not.toBe(b.manifest.encryption!.salt)
    expect(a.manifest.encryption!.iv).not.toBe(b.manifest.encryption!.iv)
    expect(a.manifest.fileCid).not.toBe(b.manifest.fileCid)
  })

  it('stores an unencrypted deliverable as is, with a null encryption block', async () => {
    const ipfs = fakeIpfs()
    const file = sampleFile()
    const { manifestCid, manifest } = await uploadDeliverable({ file, targets, upload: ipfs.upload })
    expect(manifest.encryption).toBeNull()
    expect(ipfs.store.get(manifest.fileCid)).toEqual(file.bytes)
    expect((await fetchDeliverable(manifestCid, { gateways: [PRIMARY], fetch: ipfs.fetch })).bytes).toEqual(file.bytes)
  })

  it('treats an empty passphrase as no encryption', async () => {
    const ipfs = fakeIpfs()
    const { manifest } = await uploadDeliverable({ file: sampleFile(), passphrase: '', targets, upload: ipfs.upload })
    expect(manifest.encryption).toBeNull()
  })
})

describe('deliverable failures', () => {
  async function failure(promise: Promise<unknown>): Promise<DeliverableError> {
    const error = await promise.then(() => undefined, (e: unknown) => e)
    expect(error).toBeInstanceOf(DeliverableError)
    return error as DeliverableError
  }

  it('fails cleanly with the wrong passphrase', async () => {
    const ipfs = fakeIpfs()
    const { manifestCid } = await uploadDeliverable({ file: sampleFile(), passphrase: 'right', targets, upload: ipfs.upload })
    const error = await failure(fetchDeliverable(manifestCid, { passphrase: 'wrong', gateways: [PRIMARY], fetch: ipfs.fetch }))
    expect(error.kind).toBe('wrong-passphrase')
  })

  it('asks for a passphrase when the deliverable is encrypted and none was given', async () => {
    const ipfs = fakeIpfs()
    const { manifestCid } = await uploadDeliverable({ file: sampleFile(), passphrase: 'right', targets, upload: ipfs.upload })
    expect((await failure(fetchDeliverable(manifestCid, { gateways: [PRIMARY], fetch: ipfs.fetch }))).kind).toBe('passphrase-required')
  })

  it('fails the hash check when an unencrypted file was swapped', async () => {
    const ipfs = fakeIpfs()
    const { manifestCid, manifest } = await uploadDeliverable({ file: sampleFile(), targets, upload: ipfs.upload })
    ipfs.store.set(manifest.fileCid, encoder.encode('%PDF-1.7 something else entirely'))
    expect((await failure(fetchDeliverable(manifestCid, { gateways: [PRIMARY], fetch: ipfs.fetch }))).kind).toBe('hash-mismatch')
  })

  it('fails the hash check when the decrypted content does not match the manifest', async () => {
    const ipfs = fakeIpfs()
    const { manifestCid, manifest } = await uploadDeliverable({ file: sampleFile(), passphrase: 'p', targets, upload: ipfs.upload })
    const forged: DeliverableManifest = { ...manifest, sha256: await sha256Hex(encoder.encode('another file')) }
    const forgedCid = await ipfs.upload(targets.manifest, new Blob([JSON.stringify(forged)]), 'manifest.json')
    expect(manifestCid).not.toBe(forgedCid)
    expect((await failure(fetchDeliverable(forgedCid, { passphrase: 'p', gateways: [PRIMARY], fetch: ipfs.fetch }))).kind).toBe('hash-mismatch')
  })

  it('reports a wrong passphrase before downloading the file', async () => {
    const ipfs = fakeIpfs()
    const { manifestCid, manifest } = await uploadDeliverable({ file: sampleFile(), passphrase: 'right', targets, upload: ipfs.upload })
    await fetchDeliverable(manifestCid, { passphrase: 'wrong', gateways: [PRIMARY], fetch: ipfs.fetch }).catch(() => undefined)
    expect(ipfs.fetch.mock.calls.map(([url]) => String(url))).not.toContain(`${PRIMARY}${manifest.fileCid}`)
  })

  it('reports tampered ciphertext as a hash mismatch, distinct from a wrong passphrase', async () => {
    const ipfs = fakeIpfs()
    const { manifestCid, manifest } = await uploadDeliverable({ file: sampleFile(), passphrase: 'p', targets, upload: ipfs.upload })
    const tampered = ipfs.store.get(manifest.fileCid)!.slice()
    tampered[0] ^= 0xff
    ipfs.store.set(manifest.fileCid, tampered)
    expect((await failure(fetchDeliverable(manifestCid, { passphrase: 'p', gateways: [PRIMARY], fetch: ipfs.fetch }))).kind).toBe('hash-mismatch')
  })

  it('rejects a manifest whose key derivation is weaker or far costlier than allowed', async () => {
    const ipfs = fakeIpfs()
    const { manifest } = await uploadDeliverable({ file: sampleFile(), passphrase: 'p', targets, upload: ipfs.upload })
    for (const iterations of [1000, MAX_PBKDF2_ITERATIONS + 1]) {
      const bad = { ...manifest, encryption: { ...manifest.encryption!, iterations } }
      const cid = await ipfs.upload(targets.manifest, new Blob([JSON.stringify(bad)]), 'manifest.json')
      expect((await failure(fetchManifest(cid, { gateways: [PRIMARY], fetch: ipfs.fetch }))).kind).toBe('invalid-manifest')
    }
  })

  it('rejects malformed manifests and CIDs that could escape the gateway path', async () => {
    const ipfs = fakeIpfs()
    for (const content of ['not json', JSON.stringify({ schema: 'other' }), JSON.stringify({ schema: 'trustlance.deliverable', version: 1, fileCid: '../etc' })]) {
      const cid = await ipfs.upload(targets.manifest, new Blob([content]), 'manifest.json')
      expect((await failure(fetchManifest(cid, { gateways: [PRIMARY], fetch: ipfs.fetch }))).kind).toBe('invalid-manifest')
    }
    expect((await failure(fetchManifest('../../admin', { gateways: [PRIMARY], fetch: ipfs.fetch }))).kind).toBe('invalid-manifest')
    expect(ipfs.fetch).toHaveBeenCalledTimes(3)
  })

  it('refuses to upload a file over the signed size limit', async () => {
    const ipfs = fakeIpfs()
    const file = { ...sampleFile(), bytes: new Uint8Array(101) }
    const small = { ...targets, file: { ...targets.file, maxFileSize: 100 } }
    expect((await failure(uploadDeliverable({ file, targets: small, upload: ipfs.upload }))).kind).toBe('too-large')
    expect(ipfs.store.size).toBe(0)
  })
})

describe('gateway fallback', () => {
  it('falls back to the next gateway when the first fails', async () => {
    const ipfs = fakeIpfs()
    const { manifestCid } = await uploadDeliverable({ file: sampleFile(), targets, upload: ipfs.upload })
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith(PRIMARY) ? new Response('bad gateway', { status: 502 }) : ipfs.fetch(input),
    )
    const result = await fetchDeliverable(manifestCid, { gateways: [PRIMARY, FALLBACK], fetch })
    expect(result.bytes).toEqual(sampleFile().bytes)
    expect(fetch.mock.calls.some(([url]) => String(url).startsWith(FALLBACK))).toBe(true)
  })

  it('skips a gateway that serves altered bytes and uses the next one that serves the real file', async () => {
    const ipfs = fakeIpfs()
    const { manifestCid, manifest } = await uploadDeliverable({ file: sampleFile(), passphrase: 'p', targets, upload: ipfs.upload })
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === `${PRIMARY}${manifest.fileCid}`) return new Response(new Uint8Array(manifest.size + 16))
      return ipfs.fetch(input)
    })
    const result = await fetchDeliverable(manifestCid, { passphrase: 'p', gateways: [PRIMARY, FALLBACK], fetch })
    expect(result.bytes).toEqual(sampleFile().bytes)
  })

  it('stops reading a response without content-length once it passes the size limit', async () => {
    let pulled = 0
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled++
            controller.enqueue(new Uint8Array(64 * 1024))
          },
        }),
      )
    const fetch = vi.fn(async () => endless())
    const error = await fetchManifest('b' + 'a'.repeat(64), { gateways: [PRIMARY], fetch }).catch((e: unknown) => e)
    expect((error as DeliverableError).kind).toBe('invalid-manifest')
    expect(pulled).toBeLessThan(10)
  })

  it('reports not-found when every gateway answers 404', async () => {
    const ipfs = fakeIpfs()
    const error = await fetchManifest('b' + 'a'.repeat(64), { gateways: [PRIMARY, FALLBACK], fetch: ipfs.fetch }).catch((e: unknown) => e)
    expect((error as DeliverableError).kind).toBe('not-found')
  })

  it('reports a timeout when every gateway is too slow', async () => {
    const hang = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const error = await fetchManifest('b' + 'a'.repeat(64), { gateways: [PRIMARY, FALLBACK], fetch: hang, timeoutMs: 20 }).catch(
      (e: unknown) => e,
    )
    expect((error as DeliverableError).kind).toBe('timeout')
    expect(hang).toHaveBeenCalledTimes(2)
  })

  it('reports unavailable when gateways fail in other ways', async () => {
    const fetch = vi.fn(async () => new Response('oops', { status: 500 }))
    const error = await fetchManifest('b' + 'a'.repeat(64), { gateways: [PRIMARY], fetch }).catch((e: unknown) => e)
    expect((error as DeliverableError).kind).toBe('unavailable')
  })
})

describe('safeFileName', () => {
  it('keeps an ordinary name', () => {
    expect(safeFileName('Final report v2.pdf')).toBe('Final report v2.pdf')
  })

  it('removes bidi overrides that disguise an extension', () => {
    expect(safeFileName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe')
    expect(safeFileName('a\u2066b\u2069\u200Fc.txt')).toBe('abc.txt')
  })

  it('removes control characters and path separators', () => {
    expect(safeFileName('../../etc/passwd')).toBe('.._.._etc_passwd')
    expect(safeFileName('C:\\temp\\x.txt')).toBe('C:_temp_x.txt')
    expect(safeFileName('line\nbreak\u0000.txt')).toBe('linebreak.txt')
  })

  it('falls back to a neutral name when nothing usable is left', () => {
    expect(safeFileName('')).toBe('deliverable')
    expect(safeFileName('\u202E\u0000')).toBe('deliverable')
    expect(safeFileName('..')).toBe('deliverable')
  })
})

describe('gatewayList', () => {
  it('puts the configured Pinata gateway first, then the public ones', () => {
    expect(gatewayList('example.mypinata.cloud')).toEqual(['https://example.mypinata.cloud/ipfs/', ...PUBLIC_GATEWAYS])
    expect(gatewayList(undefined)).toEqual(PUBLIC_GATEWAYS)
  })

  it('ignores a value that is not a bare host name', () => {
    for (const bad of ['', 'https://x.example', 'x.example/ipfs', 'evil.example?x=', 'a b']) expect(gatewayList(bad)).toEqual(PUBLIC_GATEWAYS)
  })
})

describe('pinataUploader', () => {
  it('posts the file to the signed URL as public and returns the CID', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ data: { cid: 'bafkreiexample' } }))
    const cid = await pinataUploader(fetch)(targets.file, new Blob(['x']), 'deliverable')
    expect(cid).toBe('bafkreiexample')
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe(targets.file.url)
    expect(init?.method).toBe('POST')
    const form = init?.body as FormData
    expect(form.get('network')).toBe('public')
    expect(form.get('file')).toBeInstanceOf(Blob)
  })

  it('fails with upload-failed on an error response', async () => {
    const fetch = vi.fn(async () => new Response('expired', { status: 401 }))
    const error = await pinataUploader(fetch)(targets.file, new Blob(['x']), 'deliverable').catch((e: unknown) => e)
    expect((error as DeliverableError).kind).toBe('upload-failed')
  })
})
