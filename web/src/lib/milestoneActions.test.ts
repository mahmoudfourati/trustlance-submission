import { describe, expect, it } from 'vitest'
import type { Milestone, Project } from './escrow'
import { milestoneActions, revisionsLeft } from './milestoneActions'

const CLIENT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const FREELANCER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'
const OTHER = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'
const REVIEW_DEADLINE = 2_000_000

const project: Pick<Project, 'status' | 'client' | 'freelancer'> = { status: 'Active', client: CLIENT, freelancer: FREELANCER }
const DELIVERY_DEADLINE = 1_000_000
const pending: Pick<Milestone, 'status' | 'reviewDeadline' | 'revisionCount' | 'deliveryDeadline'> = {
  status: 'Pending',
  reviewDeadline: 0,
  revisionCount: 0,
  deliveryDeadline: DELIVERY_DEADLINE,
}
const submitted = { ...pending, status: 'Submitted' as const, reviewDeadline: REVIEW_DEADLINE }

const names = (actions: { action: string }[]) => actions.map((a) => a.action)

describe('milestoneActions', () => {
  it('offers submission of a Pending milestone to the freelancer only', () => {
    expect(names(milestoneActions(project, pending, FREELANCER.toLowerCase(), 0))).toEqual(['submit'])
    expect(milestoneActions(project, pending, CLIENT, 0)).toEqual([])
    expect(milestoneActions(project, pending, OTHER, 0)).toEqual([])
  })

  it('offers an overdue refund to the client from exactly the delivery deadline', () => {
    expect(milestoneActions(project, pending, CLIENT, DELIVERY_DEADLINE - 1)).toEqual([])
    expect(milestoneActions(project, pending, CLIENT.toLowerCase(), DELIVERY_DEADLINE)).toEqual([{ action: 'refund' }])
    expect(milestoneActions(project, pending, OTHER, DELIVERY_DEADLINE)).toEqual([])
  })

  it('keeps submission open for the freelancer after the delivery deadline', () => {
    expect(milestoneActions(project, pending, FREELANCER, DELIVERY_DEADLINE + 1)).toEqual([{ action: 'submit' }])
  })

  it('offers approve and revise to the client until reviewDeadline - 1', () => {
    expect(milestoneActions(project, submitted, CLIENT, REVIEW_DEADLINE - 1)).toEqual([{ action: 'approve' }, { action: 'revise' }])
    expect(milestoneActions(project, submitted, FREELANCER, REVIEW_DEADLINE - 1)).toEqual([])
    expect(milestoneActions(project, submitted, OTHER, REVIEW_DEADLINE - 1)).toEqual([])
  })

  it('offers only auto-approval, to anyone, from exactly reviewDeadline', () => {
    for (const account of [CLIENT, FREELANCER, OTHER]) {
      expect(milestoneActions(project, submitted, account, REVIEW_DEADLINE)).toEqual([{ action: 'autoApprove' }])
    }
  })

  it('shows revise as unavailable once both revision requests are used', () => {
    const actions = milestoneActions(project, { ...submitted, revisionCount: 2 }, CLIENT, REVIEW_DEADLINE - 1)
    expect(actions[0]).toEqual({ action: 'approve' })
    expect(actions[1].action).toBe('revise')
    expect(actions[1].disabledReason).toMatch(/both revision requests/)
  })

  it('offers nothing on Approved or Refunded milestones', () => {
    for (const status of ['Approved', 'Refunded'] as const) {
      expect(milestoneActions(project, { ...submitted, status }, CLIENT, REVIEW_DEADLINE)).toEqual([])
    }
  })

  it('offers nothing unless the project is Active, and nothing without a wallet', () => {
    for (const status of ['Open', 'Completed', 'Cancelled', 'Disputed', 'Resolved'] as const) {
      expect(milestoneActions({ ...project, status }, pending, FREELANCER, 0)).toEqual([])
      expect(milestoneActions({ ...project, status }, submitted, CLIENT, REVIEW_DEADLINE)).toEqual([])
    }
    expect(milestoneActions(project, submitted, undefined, REVIEW_DEADLINE)).toEqual([])
  })
})

describe('revisionsLeft', () => {
  it('counts down from two and never goes below zero', () => {
    expect(revisionsLeft({ revisionCount: 0 })).toBe(2)
    expect(revisionsLeft({ revisionCount: 1 })).toBe(1)
    expect(revisionsLeft({ revisionCount: 2 })).toBe(0)
    expect(revisionsLeft({ revisionCount: 3 })).toBe(0)
  })
})
