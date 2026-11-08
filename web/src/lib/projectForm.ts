import { getAddress, isAddress, parseEther } from 'ethers'
import {
  DAY,
  HOUR,
  MAX_ACCEPTANCE_WINDOW,
  MAX_DELIVERY_PERIOD,
  MAX_DESCRIPTION_BYTES,
  MAX_MILESTONES,
  MAX_REVIEW_WINDOW,
  MAX_TITLE_BYTES,
  MIN_ACCEPTANCE_LEAD,
  MIN_DELIVERY_PERIOD,
  MIN_REVIEW_WINDOW,
  LIMIT_TEXT,
} from './limits'
import { sameAddress } from './address'

export type DeliveryUnit = 'hours' | 'days'

export type MilestoneDraft = {
  title: string
  amountEth: string
  deliveryValue: string
  deliveryUnit: DeliveryUnit
}

export type ProjectDraft = {
  title: string
  description: string
  freelancer: string
  /** Unix seconds; the form converts its date-time input before validating. */
  acceptanceDeadline: number | undefined
  reviewWindowDays: string
  milestones: MilestoneDraft[]
}

/** Argument shape of TrustLanceEscrow.createProject. */
export type CreateProjectParams = {
  freelancer: string
  acceptanceDeadline: bigint
  reviewWindow: bigint
  title: string
  description: string
  milestones: { amount: bigint; deliveryPeriod: bigint; title: string }[]
}

export type ValidationContext = {
  client: string | undefined
  arbitrator: string | undefined
  /** Current time in unix seconds. */
  now: number
}

/** Field path -> message, e.g. `title`, `milestones.1.amountEth`. */
export type DraftErrors = Record<string, string>

export type ValidationResult =
  | { ok: true; params: CreateProjectParams; total: bigint }
  | { ok: false; errors: DraftErrors }

const byteLength = (value: string) => new TextEncoder().encode(value).length

export function emptyMilestone(): MilestoneDraft {
  return { title: '', amountEth: '', deliveryValue: '7', deliveryUnit: 'days' }
}

/** Applies the contract's creation rules so invalid projects are caught before signing. */
export function validateProjectDraft(draft: ProjectDraft, ctx: ValidationContext): ValidationResult {
  const errors: DraftErrors = {}
  const title = draft.title.trim()

  if (!title) errors.title = 'Give the project a title.'
  else if (byteLength(title) > MAX_TITLE_BYTES) errors.title = `The title must be ${LIMIT_TEXT.title}.`

  if (byteLength(draft.description) > MAX_DESCRIPTION_BYTES) {
    errors.description = `The description must be ${LIMIT_TEXT.description}.`
  }

  const freelancer = draft.freelancer.trim()
  if (!isAddress(freelancer)) errors.freelancer = 'Enter a valid Ethereum address.'
  else if (/^0x0{40}$/i.test(freelancer)) errors.freelancer = 'The zero address cannot be the freelancer.'
  else if (sameAddress(ctx.client, freelancer)) errors.freelancer = "You can't hire yourself."
  else if (sameAddress(ctx.arbitrator, freelancer)) errors.freelancer = "The project's arbitrator can't be the freelancer."

  if (ctx.client && sameAddress(ctx.arbitrator, ctx.client)) {
    errors.client = "The arbitrator account can't create projects."
  }

  const deadline = draft.acceptanceDeadline
  if (deadline === undefined || Number.isNaN(deadline)) {
    errors.acceptanceDeadline = 'Pick an acceptance deadline.'
  } else if (deadline < ctx.now + MIN_ACCEPTANCE_LEAD) {
    errors.acceptanceDeadline = `Pick a deadline ${LIMIT_TEXT.acceptanceLead}.`
  } else if (deadline > ctx.now + MAX_ACCEPTANCE_WINDOW) {
    errors.acceptanceDeadline = `The deadline can be ${LIMIT_TEXT.acceptanceWindow}.`
  }

  const reviewDays = Number(draft.reviewWindowDays)
  const reviewWindow = reviewDays * DAY
  if (!Number.isInteger(reviewDays) || reviewWindow < MIN_REVIEW_WINDOW || reviewWindow > MAX_REVIEW_WINDOW) {
    errors.reviewWindowDays = `The review window must be ${LIMIT_TEXT.reviewWindow}, in whole days.`
  }

  if (draft.milestones.length === 0) errors.milestones = 'Add at least one milestone.'
  else if (draft.milestones.length > MAX_MILESTONES) errors.milestones = `Use ${LIMIT_TEXT.milestones}.`

  let total = 0n
  const milestones = draft.milestones.map((m, i) => {
    const mTitle = m.title.trim()
    if (!mTitle) errors[`milestones.${i}.title`] = 'Name this milestone.'
    else if (byteLength(mTitle) > MAX_TITLE_BYTES) errors[`milestones.${i}.title`] = `The title must be ${LIMIT_TEXT.title}.`

    let amount = 0n
    try {
      amount = parseEther(m.amountEth.trim())
    } catch {
      errors[`milestones.${i}.amountEth`] = 'Enter an amount in ETH, e.g. 0.5.'
    }
    if (amount <= 0n && !errors[`milestones.${i}.amountEth`]) {
      errors[`milestones.${i}.amountEth`] = 'The amount must be more than 0.'
    }
    total += amount

    const period = Number(m.deliveryValue) * (m.deliveryUnit === 'hours' ? HOUR : DAY)
    if (!Number.isInteger(period) || period < MIN_DELIVERY_PERIOD || period > MAX_DELIVERY_PERIOD) {
      errors[`milestones.${i}.deliveryValue`] = `Delivery must be ${LIMIT_TEXT.deliveryPeriod}.`
    }

    return { amount, deliveryPeriod: BigInt(Number.isInteger(period) ? period : 0), title: mTitle }
  })

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  return {
    ok: true,
    total,
    params: {
      freelancer: getAddress(freelancer),
      acceptanceDeadline: BigInt(deadline!),
      reviewWindow: BigInt(reviewWindow),
      title,
      description: draft.description,
      milestones,
    },
  }
}
