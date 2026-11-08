import { useEffect, useState } from 'react'

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** Current unix time in seconds, refreshed on an interval so countdowns stay live. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(nowSeconds)
  useEffect(() => {
    const id = setInterval(() => setNow(nowSeconds()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
