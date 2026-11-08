import { describe, expect, it } from 'vitest'
import { validateProjectDraft, type ProjectDraft, type ValidationContext } from './projectForm'

const NOW = 1_800_000_000
const CLIENT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const ARBITRATOR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const FREELANCER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'

const ctx: ValidationContext = { client: CLIENT, arbitrator: ARBITRATOR, now: NOW }

function draft(overrides: Partial<ProjectDraft> = {}): ProjectDraft {
  return {
    title: 'Landing page',
    description: 'Design and build',
    freelancer: FREELANCER.toLowerCase(),
    acceptanceDeadline: NOW + 7 * 86400,
    reviewWindowDays: '7',
    milestones: [
      { title: 'Wireframes', amountEth: '1', deliveryValue: '10', deliveryUnit: 'days' },
      { title: 'Build', amountEth: '2.5', deliveryValue: '36', deliveryUnit: 'hours' },
    ],
    ...overrides,
  }
}

const errorsOf = (d: ProjectDraft) => {
  const result = validateProjectDraft(d, ctx)
  return result.ok ? {} : result.errors
}

describe('validateProjectDraft', () => {
  it('builds createProject arguments and the exact total for a valid draft', () => {
    const result = validateProjectDraft(draft(), ctx)

    expect(result).toEqual({
      ok: true,
      total: 3_500_000_000_000_000_000n,
      params: {
        freelancer: FREELANCER,
        acceptanceDeadline: BigInt(NOW + 604800),
        reviewWindow: 604800n,
        title: 'Landing page',
        description: 'Design and build',
        milestones: [
          { amount: 1_000_000_000_000_000_000n, deliveryPeriod: 864000n, title: 'Wireframes' },
          { amount: 2_500_000_000_000_000_000n, deliveryPeriod: 129600n, title: 'Build' },
        ],
      },
    })
  })

  it.each([
    ['not an address', '0x1234'],
    ['the zero address', '0x0000000000000000000000000000000000000000'],
    ['the client', CLIENT],
    ['the arbitrator', ARBITRATOR.toLowerCase()],
  ])('rejects a freelancer that is %s', (_, freelancer) => {
    expect(errorsOf(draft({ freelancer }))).toHaveProperty('freelancer')
  })

  it('rejects an arbitrator creating a project', () => {
    const result = validateProjectDraft(draft(), { ...ctx, client: ARBITRATOR })
    expect(result.ok ? {} : result.errors).toHaveProperty('client')
  })

  it.each([
    ['missing', undefined],
    ['less than 10 minutes away', NOW + 599],
    ['more than 90 days away', NOW + 90 * 86400 + 1],
  ])('rejects an acceptance deadline that is %s', (_, acceptanceDeadline) => {
    expect(errorsOf(draft({ acceptanceDeadline }))).toHaveProperty('acceptanceDeadline')
  })

  it('accepts an acceptance deadline exactly 90 days away', () => {
    expect(errorsOf(draft({ acceptanceDeadline: NOW + 90 * 86400 }))).toEqual({})
  })

  it.each(['0', '31', '1.5', 'abc'])('rejects a review window of %s days', (reviewWindowDays) => {
    expect(errorsOf(draft({ reviewWindowDays }))).toHaveProperty('reviewWindowDays')
  })

  it('rejects titles that are empty or over 100 bytes, counting multi-byte characters', () => {
    expect(errorsOf(draft({ title: '   ' }))).toHaveProperty('title')
    expect(errorsOf(draft({ title: 'é'.repeat(51) }))).toHaveProperty('title')
    expect(errorsOf(draft({ title: 'é'.repeat(50) }))).toEqual({})
  })

  it('rejects a description over 1000 bytes', () => {
    expect(errorsOf(draft({ description: 'a'.repeat(1001) }))).toHaveProperty('description')
  })

  it('rejects zero, negative and malformed milestone amounts per milestone', () => {
    const d = draft()
    d.milestones[0].amountEth = '0'
    d.milestones[1].amountEth = '1.2.3'
    const errors = errorsOf(d)
    expect(errors).toHaveProperty(['milestones.0.amountEth'])
    expect(errors).toHaveProperty(['milestones.1.amountEth'])
  })

  it('enforces the delivery period bounds of 1 hour to 365 days', () => {
    const d = draft()
    d.milestones[0] = { ...d.milestones[0], deliveryValue: '0.5', deliveryUnit: 'hours' }
    d.milestones[1] = { ...d.milestones[1], deliveryValue: '366', deliveryUnit: 'days' }
    const errors = errorsOf(d)
    expect(errors).toHaveProperty(['milestones.0.deliveryValue'])
    expect(errors).toHaveProperty(['milestones.1.deliveryValue'])

    d.milestones[0] = { ...d.milestones[0], deliveryValue: '1', deliveryUnit: 'hours' }
    d.milestones[1] = { ...d.milestones[1], deliveryValue: '365', deliveryUnit: 'days' }
    expect(errorsOf(d)).toEqual({})
  })

  it('requires 1 to 20 milestones', () => {
    expect(errorsOf(draft({ milestones: [] }))).toHaveProperty('milestones')
    const many = Array.from({ length: 21 }, () => draft().milestones[0])
    expect(errorsOf(draft({ milestones: many }))).toHaveProperty('milestones')
  })
})
