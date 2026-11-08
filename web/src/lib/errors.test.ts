import { Interface, parseEther } from 'ethers'
import { describe, expect, it } from 'vitest'
import { escrowAbi } from '../contracts/generated/escrowAbi'
import { decodeContractError, describeError } from './errors'

const iface = new Interface(escrowAbi)
const freelancerLike = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'

describe('describeError', () => {
  it('recognises a wallet rejection in its EIP-1193 and ethers forms', () => {
    expect(describeError({ code: 4001, message: 'User rejected' })).toBe('You rejected the request in your wallet.')
    expect(describeError({ code: 'ACTION_REJECTED' })).toBe('You rejected the request in your wallet.')
  })

  it('explains a pending wallet request', () => {
    expect(describeError({ code: -32002 })).toMatch(/already has a request waiting/)
  })

  it('decodes a custom error from revert data nested inside an RPC error', () => {
    const data = iface.encodeErrorResult('IncorrectDeposit', [parseEther('3.5'), parseEther('3')])
    const error = { code: 'CALL_EXCEPTION', info: { error: { code: -32603, data } } }

    expect(decodeContractError(error)?.name).toBe('IncorrectDeposit')
    expect(describeError(error)).toBe(
      'The payment must equal the milestone total exactly: expected 3.5 ETH, sent 3.0 ETH.',
    )
  })

  it('uses the custom error ethers already decoded', () => {
    expect(describeError({ code: 'CALL_EXCEPTION', revert: { name: 'ZeroMilestoneAmount', args: [1n] } })).toBe(
      'Milestone 2 needs an amount above 0.',
    )
  })

  it('has a plain-language message for every custom error the contract can raise', () => {
    // Constructor, admin and OpenZeppelin internals: no user-facing flow can hit them yet.
    const notUserFacing = new Set(['ExpectedPause', 'FeeTooHigh', 'InvalidArbitrator', 'OwnableInvalidOwner', 'OwnableUnauthorizedAccount', 'ReentrancyGuardReentrantCall'])
    const unmapped: string[] = []
    iface.forEachError((fragment) => {
      if (notUserFacing.has(fragment.name)) return
      const message = describeError({ revert: { name: fragment.name, args: fragment.inputs.map(() => 0n) } })
      if (message.includes('The contract rejected the transaction')) unmapped.push(fragment.name)
    })
    expect(unmapped).toEqual([])
  })

  it('explains the review-window and revision-limit errors', () => {
    expect(describeError({ revert: { name: 'RevisionLimitReached', args: [0n] } })).toMatch(/Both revision requests/)
    expect(describeError({ revert: { name: 'ReviewWindowClosed', args: [1n] } })).toMatch(/counts as approved/)
    expect(describeError({ revert: { name: 'MilestoneNotSubmitted', args: [2n] } })).toMatch(/This one is Approved/)
  })

  it('names an unmapped custom error instead of hiding it', () => {
    expect(describeError({ revert: { name: 'SomethingNew', args: [] } })).toBe(
      'The contract rejected the transaction (SomethingNew).',
    )
  })

  it('decodes the lifecycle and withdrawal errors from revert data', () => {
    const revert = (name: string, args: unknown[] = []) => ({ data: iface.encodeErrorResult(name, args) })
    expect(describeError(revert('ProjectNotOpen', [3n]))).toMatch(/It is Cancelled now\.$/)
    expect(describeError(revert('AcceptanceDeadlinePassed', [123n]))).toMatch(/can no longer be accepted/)
    expect(describeError(revert('NotFreelancer', [freelancerLike]))).toBe("Only the project's freelancer can do this.")
    expect(describeError(revert('NothingToWithdraw'))).toMatch(/no withdrawable balance/)
    expect(describeError(revert('WithdrawalFailed'))).toMatch(/balance is unchanged/)
  })

  it('explains insufficient funds and network failures', () => {
    expect(describeError({ code: 'INSUFFICIENT_FUNDS' })).toMatch(/enough ETH/)
    expect(describeError({ code: 'NETWORK_ERROR' })).toMatch(/Couldn't reach the network/)
  })
})
