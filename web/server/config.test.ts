import { describe, expect, it } from 'vitest'
import { createUploadHandlerFromEnv, readProxyConfig } from './config'

describe('readProxyConfig', () => {
  it('reads the Pinata JWT and per-chain RPC URLs from the environment only', () => {
    const config = readProxyConfig({
      PINATA_JWT: 'jwt-from-env',
      UPLOAD_PROXY_RPC_URL_11155111: 'https://sepolia.example',
    })
    expect(config.pinataJwt).toBe('jwt-from-env')
    expect(config.rpcUrls).toEqual({ 31337: 'http://127.0.0.1:8545', 11155111: 'https://sepolia.example' })
  })

  it('lets the local RPC URL be overridden and treats a missing JWT as unset', () => {
    const config = readProxyConfig({ UPLOAD_PROXY_RPC_URL_31337: 'http://127.0.0.1:9999', PINATA_JWT: '  ' })
    expect(config.pinataJwt).toBeUndefined()
    expect(config.rpcUrls).toEqual({ 31337: 'http://127.0.0.1:9999' })
  })
})

describe('createUploadHandlerFromEnv', () => {
  it('answers 503 when the Pinata JWT is not configured', async () => {
    const handler = createUploadHandlerFromEnv({})
    const response = await handler(new Request('http://localhost/api/upload-url', { method: 'POST', body: '{}' }))
    expect(response.status).toBe(503)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not-configured')
  })
})
