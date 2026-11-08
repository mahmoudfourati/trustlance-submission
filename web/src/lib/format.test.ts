import { parseEther } from 'ethers'
import { describe, expect, it } from 'vitest'
import { formatEth, formatEthExact, formatFeeRate } from './format'

describe('formatEthExact', () => {
  it('shows every wei, unlike the rounded formatEth', () => {
    const amount = parseEther('4') + 1n
    expect(formatEth(amount)).toBe('4 ETH')
    expect(formatEthExact(amount)).toBe('4.000000000000000001 ETH')
    expect(formatEthExact(parseEther('0.025'))).toBe('0.025 ETH')
    expect(formatEthExact(0n)).toBe('0 ETH')
    expect(formatEthExact(1n)).toBe('0.000000000000000001 ETH')
  })
})

describe('formatFeeRate', () => {
  it('shows basis points as a percentage', () => {
    expect(formatFeeRate(100)).toBe('1%')
    expect(formatFeeRate(250)).toBe('2.5%')
    expect(formatFeeRate(1)).toBe('0.01%')
    expect(formatFeeRate(0)).toBe('0%')
  })
})
