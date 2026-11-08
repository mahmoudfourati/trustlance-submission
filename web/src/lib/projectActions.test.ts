import { describe, expect, it } from 'vitest'
import { availableActions, forfeitPreview } from './projectActions'

const client = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const freelancer = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'
const stranger = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const deadline = 1_000_000

const open = { status: 'Open', client, freelancer, acceptanceDeadline: deadline } as const

describe('availableActions', () => {
  it('offers accept and decline to the freelancer of an Open project before the deadline', () => {
    expect(availableActions(open, freelancer.toLowerCase(), deadline - 1)).toEqual([{ action: 'accept' }, { action: 'decline' }])
  })

  it('disables accept from exactly the acceptance deadline but keeps decline', () => {
    expect(availableActions(open, freelancer, deadline)).toEqual([
      { action: 'accept', disabledReason: 'The acceptance deadline has passed.' },
      { action: 'decline' },
    ])
  })

  it('offers cancel to the client, before and after the deadline', () => {
    expect(availableActions(open, client, deadline - 1)).toEqual([{ action: 'cancel' }])
    expect(availableActions(open, client, deadline + 1)).toEqual([{ action: 'cancel' }])
  })

  it('offers nothing to other accounts or without a wallet', () => {
    expect(availableActions(open, stranger, 0)).toEqual([])
    expect(availableActions(open, undefined, 0)).toEqual([])
  })

  it('offers forfeit to the freelancer of an Active project only', () => {
    const active = { ...open, status: 'Active' } as const
    expect(availableActions(active, freelancer.toLowerCase(), 0)).toEqual([{ action: 'forfeit' }])
    expect(availableActions(active, client, 0)).toEqual([])
    expect(availableActions(active, stranger, 0)).toEqual([])
  })

  it('offers nothing on a finished or disputed project', () => {
    for (const status of ['Cancelled', 'Completed', 'Disputed', 'Resolved'] as const) {
      expect(availableActions({ ...open, status }, freelancer, 0)).toEqual([])
      expect(availableActions({ ...open, status }, client, 0)).toEqual([])
    }
  })
})

describe('forfeitPreview', () => {
  const review = 2_000
  const milestones = [
    { status: 'Approved', amount: 1n, reviewDeadline: 0 },
    { status: 'Submitted', amount: 2n, reviewDeadline: review },
    { status: 'Submitted', amount: 4n, reviewDeadline: review + 100 },
    { status: 'Pending', amount: 8n, reviewDeadline: 0 },
    { status: 'Refunded', amount: 16n, reviewDeadline: 0 },
  ] as const

  it('credits submitted milestones whose review window has ended and refunds every other open one', () => {
    expect(forfeitPreview(milestones, review)).toEqual({ credited: 2n, refunded: 12n })
  })

  it('refunds a submitted milestone at reviewDeadline - 1, like the contract', () => {
    expect(forfeitPreview(milestones, review - 1)).toEqual({ credited: 0n, refunded: 14n })
  })

  it('never counts Approved or Refunded milestones', () => {
    expect(forfeitPreview(milestones.filter((m) => m.status === 'Approved' || m.status === 'Refunded'), review)).toEqual({
      credited: 0n,
      refunded: 0n,
    })
  })
})
