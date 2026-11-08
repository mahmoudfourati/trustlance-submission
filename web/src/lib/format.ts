import { formatEther } from 'ethers'
import { DAY, HOUR } from './limits'

export function formatEth(wei: bigint, maxDecimals = 4): string {
  const [whole, fraction = ''] = formatEther(wei).split('.')
  const trimmed = fraction.slice(0, maxDecimals).replace(/0+$/, '')
  const shown = trimmed ? `${whole}.${trimmed}` : whole
  return `${wei > 0n && shown === '0' ? '< 0.0001' : shown} ETH`
}

/** Every wei, for amounts that must match the contract exactly (formatEth rounds to 4 decimals). */
export function formatEthExact(wei: bigint): string {
  return `${formatEther(wei).replace(/\.0$/, '')} ETH`
}

/** A fee rate in basis points as a percentage, e.g. 250 → "2.5%". */
export function formatFeeRate(bps: number): string {
  return `${bps / 100}%`
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function formatDuration(seconds: number): string {
  if (seconds % DAY === 0) return `${seconds / DAY} day${seconds === DAY ? '' : 's'}`
  if (seconds % HOUR === 0) return `${seconds / HOUR} hour${seconds === HOUR ? '' : 's'}`
  return `${(seconds / DAY).toFixed(1)} days`
}

export function formatDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** "in 3 days" / "2 hours ago", rounded to the largest whole unit. */
export function formatRelative(unixSeconds: number, nowSeconds: number): string {
  const diff = unixSeconds - nowSeconds
  const abs = Math.abs(diff)
  const [value, unit] =
    abs >= DAY ? [Math.floor(abs / DAY), 'day'] : abs >= HOUR ? [Math.floor(abs / HOUR), 'hour'] : [Math.max(1, Math.floor(abs / 60)), 'minute']
  const label = `${value} ${unit}${value === 1 ? '' : 's'}`
  return diff >= 0 ? `in ${label}` : `${label} ago`
}
