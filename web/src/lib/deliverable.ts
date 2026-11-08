// Deliverable upload and retrieval (ADR 0004). Runs in the browser and in Node: it uses only WebCrypto,
// fetch and Blob, and has no imports so the upload proxy can share its limits.

export const MAX_DELIVERABLE_BYTES = 50 * 1024 * 1024
export const MAX_MANIFEST_BYTES = 16 * 1024
/** PBKDF2 work factor for new encryptions. Manifests asking for less are rejected as a downgrade. */
export const PBKDF2_ITERATIONS = 600_000
/** Upper bound accepted from a manifest, so a hostile manifest can't make the browser hash for minutes. */
export const MAX_PBKDF2_ITERATIONS = 2_000_000
/** Fallback gateways tried after the configured Pinata gateway. */
export const PUBLIC_GATEWAYS = ['https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/']

const SALT_BYTES = 16
const IV_BYTES = 12
const GCM_TAG_BYTES = 16
const DEFAULT_TIMEOUT_MS = 15_000

export type Encryption = {
  algorithm: 'AES-256-GCM'
  kdf: 'PBKDF2-SHA-256'
  iterations: number
  /** Base64. */
  salt: string
  /** Base64. */
  iv: string
  /**
   * Hex check value from the second half of the PBKDF2 output, so a wrong passphrase is told apart from altered
   * ciphertext (AES-GCM alone fails the same way for both). It gives an attacker nothing the ciphertext doesn't:
   * either one lets them test passphrase guesses offline.
   */
  keyCheck: string
}

/** The JSON document pinned next to each deliverable; its CID is what a submission records on-chain. */
export type DeliverableManifest = {
  schema: 'trustlance.deliverable'
  version: 1
  name: string
  mimeType: string
  /** Plaintext size in bytes. */
  size: number
  /** Hex SHA-256 of the plaintext. */
  sha256: string
  fileCid: string
  encryption: Encryption | null
}

export type DeliverableErrorKind =
  | 'too-large'
  | 'upload-failed'
  | 'not-found'
  | 'timeout'
  | 'unavailable'
  | 'invalid-manifest'
  | 'passphrase-required'
  | 'wrong-passphrase'
  | 'hash-mismatch'

const ERROR_MESSAGES: Record<DeliverableErrorKind, string> = {
  'too-large': 'The file is larger than the upload limit.',
  'upload-failed': "The upload to IPFS didn't go through. Try again.",
  'not-found': "IPFS gateways can't find this deliverable yet. It may still be propagating; retry in a minute.",
  timeout: 'IPFS gateways took too long to answer. Retry, or try again later.',
  unavailable: "IPFS gateways couldn't serve this deliverable right now. Retry in a moment.",
  'invalid-manifest': "The deliverable's manifest is missing or malformed.",
  'passphrase-required': 'This deliverable is encrypted. Enter the passphrase the freelancer shared with you.',
  'wrong-passphrase': "That passphrase doesn't unlock this deliverable. Check it with the freelancer.",
  'hash-mismatch': "The file doesn't match the hash the freelancer committed to. Don't trust its contents.",
}

export class DeliverableError extends Error {
  readonly kind: DeliverableErrorKind
  constructor(kind: DeliverableErrorKind) {
    super(ERROR_MESSAGES[kind])
    this.name = 'DeliverableError'
    this.kind = kind
  }
}

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type UploadTarget = { url: string; maxFileSize: number }
/** Uploads one blob to a signed URL and returns its CID. */
export type Uploader = (target: UploadTarget, body: Blob, name: string) => Promise<string>

// CIDv0 (base58btc "Qm…") or CIDv1 in lowercase base32 ("b…"). Anything else never reaches a gateway URL.
const CID_PATTERN = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})$/
export const isCid = (value: unknown): value is string => typeof value === 'string' && CID_PATTERN.test(value)

// Copy into a fresh ArrayBuffer-backed view so WebCrypto and Blob accept it in every runtime.
const arrayBufferView = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes)

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
  } catch {
    return undefined
  }
}

/** Gateway base URLs to read from: the configured Pinata gateway host first, then the public fallbacks. */
export function gatewayList(pinataGatewayHost: string | undefined): string[] {
  const host = pinataGatewayHost?.trim()
  const valid = host !== undefined && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)
  return valid ? [`https://${host}/ipfs/`, ...PUBLIC_GATEWAYS] : [...PUBLIC_GATEWAYS]
}

/** Reads a response body, giving up as soon as it passes `maxBytes` even when no content-length was sent. */
async function readCapped(response: Response, maxBytes: number, oversize: DeliverableErrorKind): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) throw new DeliverableError(oversize)
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new DeliverableError(oversize)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', arrayBufferView(bytes)))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** PBKDF2 to 64 bytes: the first 32 are the AES-256 key, the last 32 feed the passphrase check value. */
async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<{ key: CryptoKey; keyCheck: string }> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits'])
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: arrayBufferView(salt), iterations }, material, 512),
  )
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt'])
  return { key, keyCheck: (await sha256Hex(bits.slice(32))).slice(0, 32) }
}

async function encrypt(plaintext: Uint8Array, passphrase: string): Promise<{ ciphertext: Uint8Array; encryption: Encryption }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const { key, keyCheck } = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS)
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBufferView(plaintext)))
  return {
    ciphertext,
    encryption: { algorithm: 'AES-256-GCM', kdf: 'PBKDF2-SHA-256', iterations: PBKDF2_ITERATIONS, salt: toBase64(salt), iv: toBase64(iv), keyCheck },
  }
}

async function decrypt(ciphertext: Uint8Array, key: CryptoKey, encryption: Encryption): Promise<Uint8Array> {
  try {
    const iv = arrayBufferView(fromBase64(encryption.iv)!)
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, arrayBufferView(ciphertext)))
  } catch {
    // The passphrase was already verified against keyCheck, so a failed GCM tag means the bytes were altered.
    throw new DeliverableError('hash-mismatch')
  }
}

/** Uploads to a Pinata signed URL as a public IPFS file. */
export function pinataUploader(fetch: Fetch = globalThis.fetch): Uploader {
  return async (target, body, name) => {
    const form = new FormData()
    form.append('file', body, name)
    form.append('network', 'public')
    let response: Response
    try {
      response = await fetch(target.url, { method: 'POST', body: form })
    } catch {
      throw new DeliverableError('upload-failed')
    }
    if (!response.ok) throw new DeliverableError('upload-failed')
    const json = (await response.json().catch(() => undefined)) as { data?: { cid?: unknown } } | undefined
    const cid = json?.data?.cid
    if (typeof cid !== 'string' || cid.length === 0) throw new DeliverableError('upload-failed')
    return cid
  }
}

/**
 * Optionally encrypts the file, uploads it, then uploads its manifest.
 * An empty or missing passphrase means the deliverable is public.
 */
export async function uploadDeliverable({
  file,
  passphrase,
  targets,
  upload = pinataUploader(),
}: {
  file: { name: string; type: string; bytes: Uint8Array }
  passphrase?: string
  targets: { file: UploadTarget; manifest: UploadTarget }
  upload?: Uploader
}): Promise<{ manifestCid: string; manifest: DeliverableManifest }> {
  const encrypted = passphrase ? await encrypt(file.bytes, passphrase) : undefined
  const payload = encrypted?.ciphertext ?? file.bytes
  if (payload.byteLength > Math.min(targets.file.maxFileSize, MAX_DELIVERABLE_BYTES)) throw new DeliverableError('too-large')

  const blobType = encrypted ? 'application/octet-stream' : file.type || 'application/octet-stream'
  const fileCid = await upload(targets.file, new Blob([arrayBufferView(payload)], { type: blobType }), encrypted ? 'deliverable.bin' : file.name)
  if (!isCid(fileCid)) throw new DeliverableError('upload-failed')

  const manifest: DeliverableManifest = {
    schema: 'trustlance.deliverable',
    version: 1,
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.bytes.byteLength,
    sha256: await sha256Hex(file.bytes),
    fileCid,
    encryption: encrypted?.encryption ?? null,
  }
  const json = new TextEncoder().encode(JSON.stringify(manifest))
  if (json.byteLength > Math.min(targets.manifest.maxFileSize, MAX_MANIFEST_BYTES)) throw new DeliverableError('too-large')
  const manifestCid = await upload(targets.manifest, new Blob([json], { type: 'application/json' }), 'manifest.json')
  if (!isCid(manifestCid)) throw new DeliverableError('upload-failed')
  return { manifestCid, manifest }
}

export type FetchOptions = {
  /** Gateway base URLs ending in `/ipfs/`, tried in order. */
  gateways: string[]
  fetch?: Fetch
  /** Per-gateway timeout. */
  timeoutMs?: number
}

/**
 * Fetches a CID from the first gateway whose content `accept` takes. Content that is too large or that `accept`
 * rejects counts against that gateway only, since a gateway can serve wrong bytes; the next one is tried.
 * When none succeeds, a content error wins over transport errors because it is the more specific finding.
 */
async function fetchFromGateways<T>(
  cid: string,
  limit: { maxBytes: number; oversize: DeliverableErrorKind },
  accept: (bytes: Uint8Array) => Promise<T>,
  { gateways, fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }: FetchOptions,
): Promise<T> {
  const failures: ('not-found' | 'timeout' | 'other')[] = []
  let contentError: DeliverableError | undefined
  for (const gateway of gateways) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${gateway}${cid}`, { signal: controller.signal })
      if (response.status === 404) {
        failures.push('not-found')
        continue
      }
      if (!response.ok) {
        failures.push('other')
        continue
      }
      const bytes = await readCapped(response, limit.maxBytes, limit.oversize)
      return await accept(bytes)
    } catch (error) {
      if (error instanceof DeliverableError) contentError = error
      else failures.push(controller.signal.aborted ? 'timeout' : 'other')
    } finally {
      clearTimeout(timer)
    }
  }
  if (contentError) throw contentError
  if (failures.length > 0 && failures.every((f) => f === 'not-found')) throw new DeliverableError('not-found')
  if (failures.length > 0 && failures.every((f) => f === 'timeout')) throw new DeliverableError('timeout')
  throw new DeliverableError('unavailable')
}

function parseManifest(bytes: Uint8Array): DeliverableManifest {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new DeliverableError('invalid-manifest')
  }
  const m = value as Partial<DeliverableManifest> | null
  const e = m?.encryption
  const encryptionValid =
    e === null ||
    (typeof e === 'object' &&
      e !== undefined &&
      e.algorithm === 'AES-256-GCM' &&
      e.kdf === 'PBKDF2-SHA-256' &&
      Number.isInteger(e.iterations) &&
      e.iterations >= PBKDF2_ITERATIONS &&
      e.iterations <= MAX_PBKDF2_ITERATIONS &&
      typeof e.salt === 'string' &&
      fromBase64(e.salt)?.byteLength === SALT_BYTES &&
      typeof e.iv === 'string' &&
      fromBase64(e.iv)?.byteLength === IV_BYTES &&
      typeof e.keyCheck === 'string' &&
      /^[0-9a-f]{32}$/.test(e.keyCheck))
  const valid =
    typeof m === 'object' &&
    m !== null &&
    m.schema === 'trustlance.deliverable' &&
    m.version === 1 &&
    typeof m.name === 'string' &&
    m.name.length <= 255 &&
    typeof m.mimeType === 'string' &&
    m.mimeType.length <= 255 &&
    Number.isSafeInteger(m.size) &&
    m.size! >= 0 &&
    m.size! <= MAX_DELIVERABLE_BYTES &&
    typeof m.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(m.sha256) &&
    isCid(m.fileCid) &&
    encryptionValid
  if (!valid) throw new DeliverableError('invalid-manifest')
  return m as DeliverableManifest
}

/**
 * A manifest's file name is chosen by the freelancer. Before showing or saving it, drop control and bidi formatting
 * characters (which can disguise `fdp.exe` as `exe.pdf`) and replace path separators.
 */
export function safeFileName(name: string): string {
  const cleaned = name
    // oxlint-disable-next-line no-control-regex -- matching control characters is the point here
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[/\\]/g, '_')
    .trim()
  return cleaned === '' || /^\.+$/.test(cleaned) ? 'deliverable' : cleaned
}

/** Fetches and validates a manifest, e.g. to learn whether a passphrase is needed before asking for it. */
export async function fetchManifest(manifestCid: string, options: FetchOptions): Promise<DeliverableManifest> {
  if (!isCid(manifestCid)) throw new DeliverableError('invalid-manifest')
  return fetchFromGateways(manifestCid, { maxBytes: MAX_MANIFEST_BYTES, oversize: 'invalid-manifest' }, async (bytes) => parseManifest(bytes), options)
}

/** Fetches the file a manifest describes, decrypts it if needed, and checks its size and SHA-256. */
export async function fetchDeliverableFile(
  manifest: DeliverableManifest,
  options: FetchOptions & { passphrase?: string },
): Promise<Uint8Array> {
  if (manifest.encryption && !options.passphrase) throw new DeliverableError('passphrase-required')
  const { encryption } = manifest
  // Derived once, outside the gateway loop: PBKDF2 is deliberately slow. A wrong passphrase stops here,
  // before any download.
  const derived = encryption ? await deriveKey(options.passphrase!, fromBase64(encryption.salt)!, encryption.iterations) : undefined
  if (encryption && derived!.keyCheck !== encryption.keyCheck) throw new DeliverableError('wrong-passphrase')
  const key = derived?.key
  const overhead = encryption ? GCM_TAG_BYTES : 0
  return fetchFromGateways(
    manifest.fileCid,
    { maxBytes: manifest.size + overhead, oversize: 'hash-mismatch' },
    async (payload) => {
      const bytes = encryption ? await decrypt(payload, key!, encryption) : payload
      if (bytes.byteLength !== manifest.size || (await sha256Hex(bytes)) !== manifest.sha256) throw new DeliverableError('hash-mismatch')
      return bytes
    },
    options,
  )
}

export async function fetchDeliverable(
  manifestCid: string,
  options: FetchOptions & { passphrase?: string },
): Promise<{ manifest: DeliverableManifest; bytes: Uint8Array }> {
  const manifest = await fetchManifest(manifestCid, options)
  return { manifest, bytes: await fetchDeliverableFile(manifest, options) }
}
