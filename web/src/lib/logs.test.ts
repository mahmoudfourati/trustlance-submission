import { describe, expect, it, vi } from 'vitest'
import { fetchInPages, isRangeLimitError } from './logs'

/** A fake RPC that returns one item per block and rejects ranges wider than `limit` blocks. */
function fakeRpc(limit: number, error: unknown = { code: -32005, message: 'query exceeds max block range 1000' }) {
  const calls: [number, number][] = []
  const served: [number, number][] = []
  const fetchRange = vi.fn(async (from: number, to: number) => {
    calls.push([from, to])
    if (to - from + 1 > limit) throw error
    served.push([from, to])
    return Array.from({ length: to - from + 1 }, (_, i) => from + i)
  })
  return { fetchRange, calls, served }
}

describe('fetchInPages', () => {
  it('fetches the whole range in one call when it fits', async () => {
    const { fetchRange, calls } = fakeRpc(1_000)
    expect(await fetchInPages(fetchRange, { fromBlock: 10, toBlock: 19, maxRange: 100 })).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    expect(calls).toEqual([[10, 19]])
  })

  it('splits a long range into consecutive pages with no gaps or overlaps', async () => {
    const { fetchRange, calls } = fakeRpc(1_000)
    const result = await fetchInPages(fetchRange, { fromBlock: 0, toBlock: 249, maxRange: 100 })
    expect(result).toEqual(Array.from({ length: 250 }, (_, i) => i))
    expect(calls).toEqual([
      [0, 99],
      [100, 199],
      [200, 249],
    ])
  })

  it('halves the page size when the RPC rejects a range, and keeps every result in order', async () => {
    const { fetchRange, served } = fakeRpc(30)
    const result = await fetchInPages(fetchRange, { fromBlock: 5, toBlock: 204, maxRange: 100 })
    expect(result).toEqual(Array.from({ length: 200 }, (_, i) => 5 + i))
    for (const [from, to] of served) expect(to - from + 1).toBeLessThanOrEqual(30)
    // Once a page size works it is kept: 100 -> 50 -> 25, then 25-block pages to the end.
    expect(served[0]).toEqual([5, 29])
  })

  it('returns nothing for an empty range', async () => {
    const { fetchRange } = fakeRpc(10)
    expect(await fetchInPages(fetchRange, { fromBlock: 10, toBlock: 9, maxRange: 10 })).toEqual([])
    expect(fetchRange).not.toHaveBeenCalled()
  })

  it('rethrows errors that are not about the range, without retrying', async () => {
    const fetchRange = vi.fn(async () => {
      throw new Error('connection refused')
    })
    await expect(fetchInPages(fetchRange, { fromBlock: 0, toBlock: 999, maxRange: 1_000 })).rejects.toThrow('connection refused')
    expect(fetchRange).toHaveBeenCalledTimes(1)
  })

  it('gives up when even a single block is rejected', async () => {
    const { fetchRange } = fakeRpc(0)
    await expect(fetchInPages(fetchRange, { fromBlock: 0, toBlock: 7, maxRange: 8 })).rejects.toMatchObject({ code: -32005 })
  })
})

describe('isRangeLimitError', () => {
  it('recognises the usual provider messages and codes', () => {
    expect(isRangeLimitError({ code: -32005, message: 'query returned more than 10000 results' })).toBe(true)
    expect(isRangeLimitError({ error: { code: -32701, message: 'exceed maximum block range: 50000' } })).toBe(true)
    expect(isRangeLimitError({ info: { responseBody: '{"error":{"message":"ranges over 10000 blocks are not supported on free plan"}}' }, message: 'server response 400 Bad Request (ranges over 10000 blocks are not supported)' })).toBe(true)
    expect(isRangeLimitError(new Error('query returned more than 10000 results'))).toBe(true)
    expect(isRangeLimitError({ error: { code: -32600, message: 'eth_getLogs is limited to a 10,000 range' } })).toBe(true)
    expect(isRangeLimitError({ message: 'block range is too wide' })).toBe(true)
    expect(isRangeLimitError({ info: { error: { message: 'Log response size exceeded.' } } })).toBe(true)
  })

  it('does not treat network or contract failures as range limits', () => {
    expect(isRangeLimitError(new Error('connection refused'))).toBe(false)
    expect(isRangeLimitError({ code: 'CALL_EXCEPTION' })).toBe(false)
    expect(isRangeLimitError(undefined)).toBe(false)
  })

  it('does not treat rate limiting as a range limit, so a busy RPC is not hammered with ever smaller pages', () => {
    expect(isRangeLimitError({ code: -32005, message: 'daily request count exceeded, request rate limited' })).toBe(false)
    expect(isRangeLimitError(new Error('server response 429 Too Many Requests'))).toBe(false)
    expect(isRangeLimitError({ error: { message: 'rate limit exceeded' } })).toBe(false)
    expect(isRangeLimitError({ error: { code: 4444, message: 'pruned history unavailable' } })).toBe(false)
  })
})
