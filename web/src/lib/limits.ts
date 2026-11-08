// Mirrors the constants in TrustLanceEscrow.sol. Keep in sync with the contract.
export const HOUR = 60 * 60
export const DAY = 24 * HOUR

export const MAX_MILESTONES = 20
export const MIN_DELIVERY_PERIOD = HOUR
export const MAX_DELIVERY_PERIOD = 365 * DAY
export const MIN_REVIEW_WINDOW = DAY
export const MAX_REVIEW_WINDOW = 30 * DAY
export const MAX_ACCEPTANCE_WINDOW = 90 * DAY
export const MAX_TITLE_BYTES = 100
export const MAX_DESCRIPTION_BYTES = 1000
export const MAX_NOTE_BYTES = 1000
export const MAX_REVISIONS = 2
/** After this, the arbitrator can no longer resolve and either party can trigger expired-dispute settlement. */
export const ARBITRATION_PERIOD = 30 * DAY
/** Divides `feeBps`; 10 000 basis points are 100%. */
export const BPS_DENOMINATOR = 10_000n

/** Client-side margin so an acceptance deadline is still in the future when the transaction is mined. */
export const MIN_ACCEPTANCE_LEAD = 10 * 60

/** Human-readable limits, derived from the constants above so messages never drift from the rules. */
export const LIMIT_TEXT = {
  title: `1 to ${MAX_TITLE_BYTES} bytes`,
  description: `at most ${MAX_DESCRIPTION_BYTES} bytes`,
  note: `at most ${MAX_NOTE_BYTES} bytes`,
  milestones: `1 to ${MAX_MILESTONES} milestones`,
  acceptanceWindow: `at most ${MAX_ACCEPTANCE_WINDOW / DAY} days away`,
  acceptanceLead: `at least ${MIN_ACCEPTANCE_LEAD / 60} minutes from now`,
  reviewWindow: `${MIN_REVIEW_WINDOW / DAY} to ${MAX_REVIEW_WINDOW / DAY} days`,
  deliveryPeriod: `between ${MIN_DELIVERY_PERIOD / HOUR} hour and ${MAX_DELIVERY_PERIOD / DAY} days`,
  arbitrationPeriod: `${ARBITRATION_PERIOD / DAY} days`,
} as const
