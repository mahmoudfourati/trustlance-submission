import { parseEther } from 'ethers'
import { describe, expect, it } from 'vitest'
import {
  arbitrationDeadline,
  arbitratorQueue,
  isProjectParty,
  maxFreelancerShare,
  raisedByRole,
  disputeActions,
  disputePhase,
  expiredSettlementPreview,
  parseShareInput,
  raiseDisputePreview,
  resolutionPreview,
  shareAtFraction,
  validateReason,
} from './disputes'
import { ARBITRATION_PERIOD, MAX_NOTE_BYTES } from './limits'

const client = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const freelancer = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'
const arbitrator = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const stranger = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'
const raisedAt = 1_000_000
const deadline = raisedAt + ARBITRATION_PERIOD

const parties = { client, freelancer, arbitrator, raisedAt }
const active = { ...parties, status: 'Active' } as const
const disputed = { ...parties, status: 'Disputed' } as const

const review = 5_000
const milestones = [
  { status: 'Approved', amount: 1n, reviewDeadline: 0 },
  { status: 'Submitted', amount: 2n, reviewDeadline: review },
  { status: 'Submitted', amount: 4n, reviewDeadline: review + 100 },
  { status: 'Pending', amount: 8n, reviewDeadline: 0 },
  { status: 'Refunded', amount: 16n, reviewDeadline: 0 },
] as const

describe('arbitration deadline', () => {
  it('is 30 days after the dispute was raised', () => {
    expect(ARBITRATION_PERIOD).toBe(30 * 24 * 60 * 60)
    expect(arbitrationDeadline({ raisedAt })).toBe(raisedAt + 2_592_000)
  })

  it('is half-open: arbitration until deadline - 1, expired-dispute settlement from exactly the deadline', () => {
    expect(disputePhase({ raisedAt }, deadline - 1)).toBe('arbitration')
    expect(disputePhase({ raisedAt }, deadline)).toBe('expired')
  })
})

describe('raiseDisputePreview', () => {
  it('credits expired reviews to the freelancer first and freezes every other open milestone, like the contract', () => {
    expect(raiseDisputePreview(milestones, review)).toEqual({ credited: 2n, frozenPending: 8n, frozenSubmitted: 4n, frozen: 12n })
  })

  it('still freezes a submission at reviewDeadline - 1', () => {
    expect(raiseDisputePreview(milestones, review - 1)).toEqual({ credited: 0n, frozenPending: 8n, frozenSubmitted: 6n, frozen: 14n })
  })

  it('freezes nothing when every open milestone has passed its review window', () => {
    const allExpired = milestones.filter((m) => m.status !== 'Pending')
    expect(raiseDisputePreview(allExpired, review + 100).frozen).toBe(0n)
  })
})

describe('resolutionPreview', () => {
  it('rounds the fee down with the snapshot rate and gives the client the rest', () => {
    // 2.5% of 1 ETH + 1 wei = 0.025 ETH + 0.025 wei, rounded down.
    const frozen = parseEther('1') + 1n
    const preview = resolutionPreview(frozen, 250, parseEther('0.5'))
    expect(preview.fee).toBe(parseEther('0.025'))
    expect(preview.maxShare).toBe(parseEther('0.975') + 1n)
    expect(preview.freelancer).toBe(parseEther('0.5'))
    expect(preview.client).toBe(parseEther('0.475') + 1n)
    expect(preview.fee + preview.freelancer + preview.client).toBe(frozen)
  })

  it('rounds a sub-wei fee down to zero and allows a zero fee', () => {
    expect(resolutionPreview(39n, 250, 0n)).toEqual({ fee: 0n, maxShare: 39n, freelancer: 0n, client: 39n })
    expect(resolutionPreview(40n, 250, 0n).fee).toBe(1n)
    expect(resolutionPreview(10n ** 18n, 0, 10n ** 18n)).toEqual({ fee: 0n, maxShare: 10n ** 18n, freelancer: 10n ** 18n, client: 0n })
  })

  it('accepts the whole remainder for the freelancer and rejects one wei more, like ShareTooLarge', () => {
    const { maxShare } = resolutionPreview(1001n, 1000, 0n)
    expect(maxShare).toBe(901n)
    expect(resolutionPreview(1001n, 1000, 901n).client).toBe(0n)
    expect(() => resolutionPreview(1001n, 1000, 902n)).toThrow(RangeError)
    expect(() => resolutionPreview(1001n, 1000, -1n)).toThrow(RangeError)
  })
})

describe('maxFreelancerShare', () => {
  it('is the frozen amount minus the rounded-down fee', () => {
    expect(maxFreelancerShare(1001n, 1000)).toBe(901n)
    expect(maxFreelancerShare(39n, 250)).toBe(39n)
    expect(maxFreelancerShare(parseEther('1') + 1n, 250)).toBe(resolutionPreview(parseEther('1') + 1n, 250, 0n).maxShare)
  })
})

describe('isProjectParty', () => {
  it('is true for the client and the freelancer only, in any letter case', () => {
    expect(isProjectParty(parties, client.toLowerCase())).toBe(true)
    expect(isProjectParty(parties, freelancer)).toBe(true)
    expect(isProjectParty(parties, arbitrator)).toBe(false)
    expect(isProjectParty(parties, stranger)).toBe(false)
    expect(isProjectParty(parties, undefined)).toBe(false)
    expect(raisedByRole({ ...parties, raisedBy: client.toLowerCase() })).toBe('Client')
    expect(raisedByRole({ ...parties, raisedBy: freelancer })).toBe('Freelancer')
  })
})

describe('expiredSettlementPreview', () => {
  it('refunds pending to the client and halves submissions, the odd wei to the client, with no fee', () => {
    expect(expiredSettlementPreview({ frozenPendingAmount: 3n, frozenSubmittedAmount: 5n })).toEqual({ freelancer: 2n, client: 6n })
    expect(expiredSettlementPreview({ frozenPendingAmount: 0n, frozenSubmittedAmount: 1n })).toEqual({ freelancer: 0n, client: 1n })
    expect(expiredSettlementPreview({ frozenPendingAmount: 0n, frozenSubmittedAmount: 4n })).toEqual({ freelancer: 2n, client: 2n })
  })

  it('stays exact for ETH-sized amounts', () => {
    const submitted = parseEther('2') + 1n
    expect(expiredSettlementPreview({ frozenPendingAmount: parseEther('3'), frozenSubmittedAmount: submitted })).toEqual({
      freelancer: parseEther('1'),
      client: parseEther('4') + 1n,
    })
  })
})

describe('shareAtFraction', () => {
  it('maps the slider position (0 to 10 000) onto the share in integer wei', () => {
    expect(shareAtFraction(901n, 0)).toBe(0n)
    expect(shareAtFraction(901n, 10_000)).toBe(901n)
    expect(shareAtFraction(901n, 5_000)).toBe(450n)
    expect(shareAtFraction(parseEther('1'), 3_333)).toBe(parseEther('0.3333'))
  })
})

describe('parseShareInput', () => {
  const max = parseEther('0.975') + 1n

  it('parses ETH with up to 18 decimals into exact wei', () => {
    expect(parseShareInput('0.5', max)).toEqual({ share: parseEther('0.5') })
    expect(parseShareInput(' 0.975000000000000001 ', max)).toEqual({ share: max })
    expect(parseShareInput('0', max)).toEqual({ share: 0n })
  })

  it('rejects empty, malformed, negative, too precise and too large input', () => {
    for (const bad of ['', 'abc', '-1', '1e18', '0.0000000000000000001', '0x10', '1,5']) {
      expect(parseShareInput(bad, max)).toHaveProperty('error')
    }
    expect(parseShareInput('0.975000000000000002', max)).toEqual({ error: expect.stringContaining('0.975000000000000001 ETH') })
  })
})

describe('validateReason', () => {
  it('needs 1 to 1000 bytes, counted in UTF-8', () => {
    expect(validateReason('')).toBeDefined()
    expect(validateReason('   ')).toBeDefined()
    expect(validateReason('Late delivery')).toBeUndefined()
    expect(validateReason('a'.repeat(MAX_NOTE_BYTES))).toBeUndefined()
    expect(validateReason('a'.repeat(MAX_NOTE_BYTES + 1))).toBeDefined()
    // 'é' is 2 bytes in UTF-8.
    expect(validateReason('é'.repeat(MAX_NOTE_BYTES / 2 + 1))).toBeDefined()
  })
})

describe('disputeActions', () => {
  it('offers raise to the client and the freelancer of an Active project only', () => {
    expect(disputeActions(active, milestones, client.toLowerCase(), review)).toEqual([{ action: 'raise' }])
    expect(disputeActions(active, milestones, freelancer, review)).toEqual([{ action: 'raise' }])
    expect(disputeActions(active, milestones, arbitrator, review)).toEqual([])
    expect(disputeActions(active, milestones, stranger, review)).toEqual([])
    expect(disputeActions(active, milestones, undefined, review)).toEqual([])
  })

  it('disables raise when nothing would be left to freeze', () => {
    const allExpired = milestones.filter((m) => m.status !== 'Pending')
    expect(disputeActions(active, allExpired, client, review + 100)).toEqual([
      { action: 'raise', disabledReason: expect.stringContaining('nothing left to dispute') },
    ])
  })

  it('offers resolve to the arbitrator until deadline - 1 and settle to the parties from exactly the deadline', () => {
    expect(disputeActions(disputed, milestones, arbitrator.toLowerCase(), deadline - 1)).toEqual([{ action: 'resolve' }])
    expect(disputeActions(disputed, milestones, arbitrator, deadline)).toEqual([
      { action: 'resolve', disabledReason: expect.stringContaining('ended') },
    ])
    for (const party of [client, freelancer]) {
      expect(disputeActions(disputed, milestones, party, deadline - 1)).toEqual([
        { action: 'settle', disabledReason: expect.stringContaining('arbitrator') },
      ])
      expect(disputeActions(disputed, milestones, party, deadline)).toEqual([{ action: 'settle' }])
    }
  })

  it('offers nothing to outsiders of a dispute, nor on any other status', () => {
    expect(disputeActions(disputed, milestones, stranger, deadline)).toEqual([])
    expect(disputeActions(disputed, milestones, undefined, deadline)).toEqual([])
    for (const status of ['Open', 'Completed', 'Cancelled', 'Resolved'] as const) {
      for (const account of [client, freelancer, arbitrator]) {
        expect(disputeActions({ ...parties, status }, milestones, account, deadline)).toEqual([])
      }
    }
  })
})

describe('arbitratorQueue', () => {
  const at = (id: number, status: 'Active' | 'Disputed' | 'Resolved' | 'Open' | 'Completed', raised = 0) => ({
    project: { id: BigInt(id), status, raisedAt: raised },
  })

  it('lists disputes awaiting resolution by nearest deadline, then expired ones (oldest first), then settled, then the rest', () => {
    const now = raisedAt + ARBITRATION_PERIOD
    const queue = arbitratorQueue(
      [
        at(1, 'Active'),
        at(2, 'Disputed', raisedAt + 10),
        at(3, 'Resolved', 5),
        at(4, 'Disputed', raisedAt),
        at(5, 'Disputed', raisedAt + 1),
        at(6, 'Open'),
        at(7, 'Disputed', raisedAt - 50),
      ],
      now,
    )
    // Project 4 was raised at exactly now - 30 days, so its arbitration period has just ended.
    expect(queue.awaiting.map((i) => i.project.id)).toEqual([5n, 2n])
    expect(queue.expired.map((i) => i.project.id)).toEqual([7n, 4n])
    expect(queue.settled.map((i) => i.project.id)).toEqual([3n])
    expect(queue.other.map((i) => i.project.id)).toEqual([1n, 6n])
  })
})
