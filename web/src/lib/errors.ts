import { Interface, formatEther } from 'ethers'
import { escrowAbi } from '../contracts/generated/escrowAbi'
import { RpcErrorCode, rpcErrorCode } from './ethereum'
import { MILESTONE_STATUSES, PROJECT_STATUSES } from './escrow'
import { LIMIT_TEXT } from './limits'

const escrowInterface = new Interface(escrowAbi)

type DecodedRevert = { name: string; args: readonly unknown[] }

/** Plain-language text for each contract custom error. */
const CONTRACT_ERRORS: Record<string, (args: readonly unknown[]) => string> = {
  IncorrectDeposit: ([expected, received]) =>
    `The payment must equal the milestone total exactly: expected ${formatEther(expected as bigint)} ETH, sent ${formatEther(received as bigint)} ETH.`,
  InvalidFreelancer: () => "That freelancer address isn't allowed (zero address, yourself, or the arbitrator).",
  ClientIsArbitrator: () => "The platform arbitrator can't create projects.",
  InvalidAcceptanceDeadline: () => `The acceptance deadline must be in the future and ${LIMIT_TEXT.acceptanceWindow}.`,
  InvalidReviewWindow: () => `The review window must be ${LIMIT_TEXT.reviewWindow}.`,
  InvalidTitle: () => `The project title must be ${LIMIT_TEXT.title}.`,
  DescriptionTooLong: () => `The description must be ${LIMIT_TEXT.description}.`,
  InvalidMilestoneCount: () => `A project needs ${LIMIT_TEXT.milestones}.`,
  ZeroMilestoneAmount: ([index]) => `Milestone ${Number(index) + 1} needs an amount above 0.`,
  InvalidDeliveryPeriod: ([index]) => `Milestone ${Number(index) + 1} needs a delivery period ${LIMIT_TEXT.deliveryPeriod}.`,
  InvalidMilestoneTitle: ([index]) => `Milestone ${Number(index) + 1} needs a title of ${LIMIT_TEXT.title}.`,
  MilestoneTotalOverflow: () => 'The milestone amounts add up to more than the contract can hold.',
  UnknownProject: ([id]) => `Project #${String(id)} doesn't exist on this network.`,
  NotClient: () => "Only the project's client can do this.",
  NotFreelancer: () => "Only the project's freelancer can do this.",
  ProjectNotOpen: ([status]) =>
    `This can only be done while the project is waiting for acceptance. It is ${PROJECT_STATUSES[Number(status)] ?? 'no longer Open'} now.`,
  AcceptanceDeadlinePassed: () => 'The acceptance deadline has passed, so the project can no longer be accepted.',
  ProjectNotActive: ([status]) =>
    `This can only be done while the project is Active. It is ${PROJECT_STATUSES[Number(status)] ?? 'not Active'} now.`,
  UnknownMilestone: ([index]) => `Milestone ${Number(index) + 1} doesn't exist on this project.`,
  MilestoneNotPending: ([status]) =>
    `Only a Pending milestone can be submitted. This one is ${MILESTONE_STATUSES[Number(status)] ?? 'not Pending'}.`,
  MilestoneNotSubmitted: ([status]) =>
    `This needs a submitted milestone. This one is ${MILESTONE_STATUSES[Number(status)] ?? 'not Submitted'}.`,
  InvalidCid: () => 'The deliverable reference must be 1 to 100 bytes.',
  NoteTooLong: () => `The revision note must be ${LIMIT_TEXT.note}.`,
  ReviewWindowClosed: () => 'The review window has ended, so the milestone counts as approved and can no longer be sent back.',
  ReviewWindowOpen: () => "The review window hasn't ended yet, so the milestone can't be auto-approved.",
  RevisionLimitReached: () =>
    'Both revision requests for this milestone are used. Approve it, let it auto-approve, or raise a dispute.',
  DeliveryWindowOpen: () =>
    "The milestone's delivery deadline hasn't passed yet, so it can't be refunded. (After a revision request, the freelancer always gets at least one more review window to deliver.)",
  NotProjectParty: () => "Only the project's client or freelancer can do this.",
  NotArbitrator: () => "Only the project's arbitrator can do this.",
  InvalidReason: () => `The dispute needs a reason, ${LIMIT_TEXT.note}.`,
  NothingToDispute: () =>
    'There is nothing left to dispute: every open milestone has passed its review window and counts as approved.',
  NotDisputed: ([status]) => `This project has no open dispute. It is ${PROJECT_STATUSES[Number(status)] ?? 'not Disputed'} now.`,
  ArbitrationPeriodEnded: () =>
    `The arbitration period of ${LIMIT_TEXT.arbitrationPeriod} has ended, so the arbitrator can no longer resolve this dispute.`,
  ArbitrationPeriodOpen: () =>
    `The arbitrator still has time to resolve this dispute. Expired-dispute settlement opens once the arbitration period of ${LIMIT_TEXT.arbitrationPeriod} has ended.`,
  ShareTooLarge: ([, max]) =>
    `The freelancer's share can be at most ${formatEther(max as bigint)} ETH (the frozen funds minus the arbitration fee).`,
  EnforcedPause: () => 'Creating new projects is paused by the platform admin. Existing projects are not affected.',
  NothingToWithdraw: () => 'You have no withdrawable balance on this network.',
  WithdrawalFailed: () => 'Your account refused the ETH transfer. Your balance is unchanged; try again from an account that can receive ETH.',
}

function findRevertData(error: unknown, depth = 0): string | undefined {
  if (depth > 5 || typeof error !== 'object' || error === null) return undefined
  const e = error as Record<string, unknown>
  if (typeof e.data === 'string' && e.data.startsWith('0x') && e.data.length >= 10) return e.data
  for (const key of ['error', 'info', 'data', 'cause']) {
    const found = findRevertData(e[key], depth + 1)
    if (found) return found
  }
  return undefined
}

/** Returns the contract custom error behind a failed call or transaction, if there is one. */
export function decodeContractError(error: unknown): DecodedRevert | undefined {
  if (typeof error === 'object' && error !== null && 'revert' in error) {
    const revert = (error as { revert?: { name?: string; args?: readonly unknown[] } }).revert
    if (revert?.name) return { name: revert.name, args: revert.args ?? [] }
  }
  const data = findRevertData(error)
  if (!data) return undefined
  try {
    const parsed = escrowInterface.parseError(data)
    return parsed ? { name: parsed.name, args: [...parsed.args] } : undefined
  } catch {
    return undefined
  }
}

function isUserRejection(error: unknown): boolean {
  if (rpcErrorCode(error) === RpcErrorCode.UserRejected) return true
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ACTION_REJECTED') return true
  const inner = (error as { error?: unknown } | null)?.error
  return inner !== undefined && rpcErrorCode(inner) === RpcErrorCode.UserRejected
}

/** Turns wallet, network and contract failures into one sentence a user can act on. */
export function describeError(error: unknown): string {
  if (isUserRejection(error)) return 'You rejected the request in your wallet.'
  if (rpcErrorCode(error) === RpcErrorCode.RequestPending) {
    return 'Your wallet already has a request waiting. Open MetaMask to finish it.'
  }

  const decoded = decodeContractError(error)
  if (decoded) {
    const describe = CONTRACT_ERRORS[decoded.name]
    return describe ? describe(decoded.args) : `The contract rejected the transaction (${decoded.name}).`
  }

  const code = (error as { code?: unknown } | null)?.code
  if (code === 'INSUFFICIENT_FUNDS') return "Your account doesn't have enough ETH for this amount plus gas."
  if (code === 'NETWORK_ERROR' || code === 'SERVER_ERROR' || code === 'TIMEOUT') {
    return "Couldn't reach the network. Check your connection and that the RPC node is running."
  }
  if (code === 'CALL_EXCEPTION') return 'The contract rejected the transaction.'

  const message = (error as { shortMessage?: unknown; message?: unknown } | null)
  if (typeof message?.shortMessage === 'string') return message.shortMessage
  if (typeof message?.message === 'string') return message.message
  return 'Something went wrong.'
}
