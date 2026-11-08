/** Fetches the items for one inclusive block range, e.g. an `eth_getLogs` call. */
export type RangeFetcher<T> = (fromBlock: number, toBlock: number) => Promise<T[]>

const RANGE_LIMIT_PATTERN = /range|more than [\d,]+ results|response size/i
// Rate limiting shares wording and even codes with range limits (Infura uses -32005 for both), but smaller pages
// would only mean more requests, so it must surface as an error instead.
const RATE_LIMIT_PATTERN = /rate|too many requests|429/i

/**
 * Whether an RPC error means "ask for fewer blocks". Providers word this differently (Infura and publicnode use
 * -32005, Alchemy a "range" message, geth "more than 10000 results"), and ethers nests the original error.
 */
export function isRangeLimitError(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== 'object' || error === null) return false
  const e = error as Record<string, unknown>
  const message = typeof e.message === 'string' ? e.message : ''
  if (RATE_LIMIT_PATTERN.test(message)) return false
  if (e.code === -32005 || RANGE_LIMIT_PATTERN.test(message)) return true
  return ['error', 'info', 'cause'].some((key) => isRangeLimitError(e[key], depth + 1))
}

/**
 * Fetches an inclusive block range in consecutive pages of at most `maxRange` blocks, halving the page size whenever
 * the RPC rejects a range as too large. Results keep block order; any other error is rethrown at once.
 */
export async function fetchInPages<T>(
  fetchRange: RangeFetcher<T>,
  { fromBlock, toBlock, maxRange }: { fromBlock: number; toBlock: number; maxRange: number },
): Promise<T[]> {
  const results: T[] = []
  let size = Math.max(1, maxRange)
  let cursor = fromBlock
  while (cursor <= toBlock) {
    const end = Math.min(toBlock, cursor + size - 1)
    try {
      results.push(...(await fetchRange(cursor, end)))
      cursor = end + 1
    } catch (error) {
      if (size === 1 || !isRangeLimitError(error)) throw error
      size = Math.ceil(size / 2)
    }
  }
  return results
}
