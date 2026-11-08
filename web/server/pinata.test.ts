import { describe, expect, it, vi } from 'vitest'
import { createPinataSigner } from './pinata'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.test.jwt'

function fakeFetch(response: Response) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response)
}

describe('createPinataSigner', () => {
  it('signs a public upload URL with the JWT as a bearer token', async () => {
    const fetch = fakeFetch(Response.json({ data: 'https://uploads.pinata.cloud/v3/files/signed?sig=abc' }))
    const signer = createPinataSigner({ jwt: JWT, fetch, now: () => 1_800_000_000 })

    const url = await signer.createSignedUploadUrl({
      expiresInSeconds: 60,
      maxFileSize: 16384,
      mimeTypes: ['application/json'],
      fileName: 'manifest.json',
      keyvalues: { app: 'trustlance' },
    })

    expect(url).toBe('https://uploads.pinata.cloud/v3/files/signed?sig=abc')
    const [input, init] = fetch.mock.calls[0]
    expect(String(input)).toBe('https://uploads.pinata.cloud/v3/files/sign')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${JWT}`)
    expect(JSON.parse(String(init?.body))).toEqual({
      network: 'public',
      date: 1_800_000_000,
      expires: 60,
      max_file_size: 16384,
      allow_mime_types: ['application/json'],
      filename: 'manifest.json',
      keyvalues: { app: 'trustlance' },
    })
  })

  it('omits the MIME filter when none is given', async () => {
    const fetch = fakeFetch(Response.json({ data: 'https://uploads.pinata.cloud/v3/files/signed?sig=abc' }))
    await createPinataSigner({ jwt: JWT, fetch, now: () => 0 }).createSignedUploadUrl({
      expiresInSeconds: 60,
      maxFileSize: 1,
      fileName: 'f',
      keyvalues: {},
    })
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).not.toHaveProperty('allow_mime_types')
  })

  it('fails without echoing the JWT when Pinata rejects the request or answers oddly', async () => {
    for (const response of [
      new Response(`invalid token ${JWT}`, { status: 401 }),
      Response.json({ data: 42 }),
      Response.json({ data: 'http://insecure.example/upload' }),
    ]) {
      const signer = createPinataSigner({ jwt: JWT, fetch: fakeFetch(response), now: () => 0 })
      const error = await signer
        .createSignedUploadUrl({ expiresInSeconds: 60, maxFileSize: 1, fileName: 'f', keyvalues: {} })
        .then(() => undefined, (e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      expect(String((error as Error).message)).not.toContain(JWT)
    }
  })
})
