import { Interface, parseEther } from 'ethers'
import { describe, expect, it } from 'vitest'
import { escrowAbi } from '../contracts/generated/escrowAbi'
import { formatDateTime } from './format'
import { buildTimeline, describeEvent, PROJECT_EVENTS, type RawTimelineEvent } from './timeline'

const CLIENT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const FREELANCER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'
const ARBITRATOR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const titles = new Map([
  [0, 'Wireframes'],
  [1, 'Build'],
])
const roles = new Map([
  [CLIENT.toLowerCase(), 'client'],
  [FREELANCER.toLowerCase(), 'freelancer'],
  [ARBITRATOR.toLowerCase(), 'arbitrator'],
] as const)
const ctx = {
  milestoneTitle: (i: number) => titles.get(i) ?? `Milestone ${i + 1}`,
  roleOf: (address: string) => roles.get(address.toLowerCase()),
}

describe('describeEvent', () => {
  it('has a readable description for every contract event that carries a project id', () => {
    const iface = new Interface(escrowAbi)
    const withProjectId: string[] = []
    iface.forEachEvent((event) => {
      if (event.inputs.some((input) => input.name === 'projectId')) withProjectId.push(event.name)
    })
    expect([...withProjectId].sort()).toEqual([...PROJECT_EVENTS].sort())
  })

  it('describes the project lifecycle', () => {
    expect(
      describeEvent(
        'ProjectCreated',
        { client: CLIENT, freelancer: FREELANCER, arbitrator: ARBITRATOR, totalAmount: parseEther('3.5'), title: 'Site' },
        ctx,
      ).title,
    ).toBe('Project created and funded with 3.5 ETH')
    expect(describeEvent('MilestoneDefined', { index: 1n, amount: parseEther('2'), deliveryPeriod: 86_400n * 3n, title: 'Build' }, ctx).title).toBe(
      'Milestone 2 defined: Build (2 ETH, 3 days to deliver)',
    )
    expect(describeEvent('ProjectAccepted', { freelancer: FREELANCER, acceptedAt: 1n }, ctx).title).toBe(
      'Freelancer accepted; delivery periods started',
    )
    expect(describeEvent('ProjectDeclined', { freelancer: FREELANCER }, ctx).title).toBe('Freelancer declined the project')
    expect(describeEvent('ProjectCancelled', { client: CLIENT }, ctx).title).toBe('Client cancelled the project before acceptance')
    expect(describeEvent('ProjectCompleted', { client: CLIENT, freelancer: FREELANCER }, ctx).title).toBe(
      'Project completed: every milestone is settled',
    )
  })

  it('describes milestone activity with the milestone title', () => {
    const deadline = 1_800_000_000
    const submitted = describeEvent('MilestoneSubmitted', { index: 0n, cid: 'bafy', reviewDeadline: BigInt(deadline) }, ctx)
    expect(submitted.title).toBe('Milestone 1 (Wireframes) submitted for review')
    // Deadlines are half-open: the last moment inside the window is D - 1.
    expect(submitted.detail).toBe(`Deliverable manifest bafy. The client can review it until ${formatDateTime(deadline - 1)}.`)

    const revision = describeEvent(
      'RevisionRequested',
      { index: 1n, revisionCount: 2n, deliveryDeadline: BigInt(deadline), note: 'Fix the footer' },
      ctx,
    )
    expect(revision.title).toBe('Revision 2 of 2 requested on milestone 2 (Build)')
    expect(revision.detail).toBe(`Fix the footer
New delivery deadline: ${formatDateTime(deadline)}.`)
    expect(describeEvent('RevisionRequested', { index: 0n, revisionCount: 1n, deliveryDeadline: BigInt(deadline), note: '' }, ctx).detail).toBe(
      `New delivery deadline: ${formatDateTime(deadline)}.`,
    )

    // The money moves in the BalanceCredited entry that follows, so these only name the amount.
    expect(describeEvent('MilestoneApproved', { index: 0n, amount: parseEther('1'), automatic: false }, ctx).title).toBe(
      'Milestone 1 (Wireframes) approved (1 ETH)',
    )
    expect(describeEvent('MilestoneApproved', { index: 0n, amount: parseEther('1'), automatic: true }, ctx).title).toBe(
      'Milestone 1 (Wireframes) auto-approved after the review window (1 ETH)',
    )
    expect(describeEvent('MilestoneRefunded', { index: 1n, amount: parseEther('2') }, ctx).title).toBe('Milestone 2 (Build) refunded (2 ETH)')
  })

  it('treats a forfeit as the project becoming Completed', () => {
    const forfeit = describeEvent(
      'ProjectForfeited',
      { client: CLIENT, freelancer: FREELANCER, creditedAmount: parseEther('1'), refundedAmount: parseEther('2.5') },
      ctx,
    )
    expect(forfeit.title).toBe('Freelancer forfeited; project completed')
    expect(forfeit.detail).toBe('1 ETH of expired reviews credited to the freelancer, 2.5 ETH refunded to the client.')
    expect(forfeit.endsProject).toBe(true)
    expect(describeEvent('ProjectCompleted', { client: CLIENT, freelancer: FREELANCER }, ctx).endsProject).toBe(true)
    expect(describeEvent('MilestoneRefunded', { index: 0n, amount: 1n }, ctx).endsProject).toBeFalsy()
    expect(describeEvent('DisputeResolved', { arbitrator: ARBITRATOR, freelancerAmount: 1n, clientAmount: 1n, fee: 0n }, ctx).endsProject).toBe(true)
    expect(describeEvent('DisputeRaised', { raisedBy: CLIENT, frozenAmount: 1n, arbitrationDeadline: 1n, reason: 'x' }, ctx).endsProject).toBeFalsy()
  })

  it('describes disputes with who raised them, the reason, the arbitration deadline and the split', () => {
    const deadline = 1_800_000_000
    const raised = describeEvent(
      'DisputeRaised',
      { raisedBy: FREELANCER, arbitrator: ARBITRATOR, frozenAmount: parseEther('7'), arbitrationDeadline: BigInt(deadline), reason: 'Unpaid work' },
      ctx,
    )
    expect(raised.title).toBe('Freelancer raised a dispute; 7 ETH is frozen')
    expect(raised.detail).toBe(`Unpaid work\nThe arbitrator can resolve it until ${formatDateTime(deadline - 1)}.`)

    expect(
      describeEvent('DisputeResolved', { arbitrator: ARBITRATOR, freelancerAmount: parseEther('4'), clientAmount: parseEther('2.93'), fee: parseEther('0.07') }, ctx)
        .title,
    ).toBe('Arbitrator resolved the dispute: 4 ETH to the freelancer, 2.93 ETH to the client, 0.07 ETH fee')
    expect(describeEvent('BalanceCredited', { account: ARBITRATOR, amount: parseEther('0.07'), reason: 2n }, ctx).title).toBe(
      "0.07 ETH credited to the arbitrator's withdrawable balance (arbitration fee)",
    )
    expect(describeEvent('BalanceCredited', { account: CLIENT, amount: parseEther('2.93'), reason: 3n }, ctx).title).toBe(
      "2.93 ETH credited to the client's withdrawable balance (dispute settlement)",
    )
  })

  it('describes an expired-dispute settlement as the fixed fallback, ending the project', () => {
    const settled = describeEvent(
      'ExpiredDisputeSettled',
      { settledBy: CLIENT, freelancerAmount: parseEther('1'), clientAmount: parseEther('8') },
      ctx,
    )
    expect(settled.title).toBe('Client settled the expired dispute with the fixed fallback split: 1 ETH to the freelancer, 8 ETH to the client')
    expect(settled.detail).toBe('Frozen pending milestones go back to the client, frozen submissions are split in half, and no fee is charged.')
    expect(settled.endsProject).toBe(true)
  })

  it('names who was credited and why', () => {
    expect(describeEvent('BalanceCredited', { account: CLIENT, amount: parseEther('2'), reason: 0n }, ctx).title).toBe(
      "2 ETH credited to the client's withdrawable balance (refund)",
    )
    expect(describeEvent('BalanceCredited', { account: FREELANCER, amount: parseEther('1'), reason: 1n }, ctx).title).toBe(
      "1 ETH credited to the freelancer's withdrawable balance (approval)",
    )
    const stranger = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'
    expect(describeEvent('BalanceCredited', { account: stranger, amount: 1n, reason: 9n }, ctx).title).toBe(
      "< 0.0001 ETH credited to 0x15d3…6A65's withdrawable balance",
    )
  })
})

function raw(overrides: Partial<RawTimelineEvent>): RawTimelineEvent {
  return {
    name: 'ProjectAccepted',
    args: { freelancer: FREELANCER, acceptedAt: 1n },
    blockNumber: 10,
    logIndex: 0,
    transactionHash: '0xaa',
    timestamp: 1_000,
    from: FREELANCER,
    ...overrides,
  }
}

describe('buildTimeline', () => {
  it('orders events by block, then by position in the block', () => {
    const entries = buildTimeline(
      [
        raw({ blockNumber: 12, logIndex: 0, transactionHash: '0xc' }),
        raw({ blockNumber: 10, logIndex: 3, transactionHash: '0xb' }),
        raw({ blockNumber: 10, logIndex: 1, transactionHash: '0xa' }),
      ],
      { latestBlock: 20, confirmations: 1, ctx },
    )
    expect(entries.map((e) => e.transactionHash)).toEqual(['0xa', '0xb', '0xc'])
  })

  it('drops duplicates that two overlapping log queries returned', () => {
    const event = raw({ blockNumber: 10, logIndex: 1 })
    expect(buildTimeline([event, { ...event }], { latestBlock: 10, confirmations: 1, ctx })).toHaveLength(1)
  })

  it('marks events newer than the confirmation threshold as unconfirmed', () => {
    const entries = buildTimeline(
      [raw({ blockNumber: 95, logIndex: 0 }), raw({ blockNumber: 96, logIndex: 0 }), raw({ blockNumber: 100, logIndex: 0 })],
      { latestBlock: 100, confirmations: 5, ctx },
    )
    // Block 96 has 5 confirmations at block 100 (96..100), block 100 has 1.
    expect(entries.map((e) => [e.blockNumber, e.confirmed])).toEqual([
      [95, true],
      [96, true],
      [100, false],
    ])
  })

  it('treats every mined event as confirmed when the threshold is 1', () => {
    expect(buildTimeline([raw({ blockNumber: 100 })], { latestBlock: 100, confirmations: 1, ctx })[0].confirmed).toBe(true)
  })

  it('keeps the timestamp, sender and description', () => {
    const [entry] = buildTimeline([raw({ timestamp: 1234, from: CLIENT })], { latestBlock: 10, confirmations: 1, ctx })
    expect(entry.timestamp).toBe(1234)
    expect(entry.from).toBe(CLIENT)
    expect(entry.title).toBe('Freelancer accepted; delivery periods started')
  })

  it("names the sender's role in the project, if any", () => {
    const entries = buildTimeline(
      [raw({ from: CLIENT, logIndex: 0 }), raw({ from: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', logIndex: 1 })],
      { latestBlock: 10, confirmations: 1, ctx },
    )
    expect(entries.map((e) => e.actorRole)).toEqual(['client', undefined])
  })
})
