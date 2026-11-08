// Shared by the browser (which signs) and the upload proxy (which verifies). Keep this module free of imports
// so the proxy can load it outside the Vite app.

/** How far ahead an upload authorization may expire; the proxy rejects anything older or further out. */
export const SIGNATURE_MAX_AGE = 5 * 60
/** Lifetime the browser signs for. Shorter than the maximum so a client clock a few minutes fast still passes. */
export const SIGNATURE_LIFETIME = 2 * 60

export type UploadAuthorization = {
  chainId: number
  /** Escrow contract address on that chain. */
  escrow: string
  /** Decimal project id. */
  projectId: string
  milestoneIndex: number
  account: string
  /** Unix seconds; the first second at which the authorization is no longer valid. */
  expires: number
}

/** The exact text the freelancer signs (EIP-191 personal_sign) to get upload URLs. */
export function uploadAuthorizationMessage(auth: UploadAuthorization): string {
  return [
    'TrustLance deliverable upload',
    '',
    'Sign to upload a deliverable for this milestone. This costs no gas.',
    '',
    `Chain ID: ${auth.chainId}`,
    `Escrow: ${auth.escrow.toLowerCase()}`,
    `Project: ${auth.projectId}`,
    `Milestone index: ${auth.milestoneIndex}`,
    `Account: ${auth.account.toLowerCase()}`,
    `Expires: ${auth.expires}`,
  ].join('\n')
}
