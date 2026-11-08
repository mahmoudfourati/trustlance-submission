import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { DeliverableError, MAX_DELIVERABLE_BYTES, uploadDeliverable } from '../lib/deliverable'
import { describeError } from '../lib/errors'
import { getInjectedProvider } from '../lib/ethereum'
import { escrowAddressFor } from '../lib/chains'
import { escrowContract, walletSigner, type Milestone, type Project } from '../lib/escrow'
import { requestUploadTargets, UploadProxyError } from '../lib/uploadProxyClient'
import { useTransaction } from '../lib/useTransaction'
import { buttonClass, inputClass } from './styles'
import { TxStatus } from './TxStatus'
import { Alert, Spinner } from './ui'

const MAX_MB = MAX_DELIVERABLE_BYTES / 1024 / 1024

type UploadPhase =
  | { phase: 'idle' }
  | { phase: 'authorizing' }
  | { phase: 'uploading' }
  | { phase: 'failed'; message: string }
  | { phase: 'uploaded'; manifestCid: string }

/**
 * The freelancer's one flow for a Pending milestone: sign an upload authorization, optionally encrypt and upload the
 * file and its manifest to IPFS, then submit the manifest CID on-chain. A failed submission can be retried without
 * uploading again.
 */
export function SubmitDeliverable({
  project,
  milestone,
  chainId,
  onClose,
}: {
  project: Project
  milestone: Milestone
  chainId: number
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const tx = useTransaction()
  const [file, setFile] = useState<File>()
  const [passphrase, setPassphrase] = useState('')
  const [confirmPassphrase, setConfirmPassphrase] = useState('')
  const [upload, setUpload] = useState<UploadPhase>({ phase: 'idle' })

  const tooLarge = file !== undefined && file.size > MAX_DELIVERABLE_BYTES
  const mismatch = passphrase !== confirmPassphrase
  const working = upload.phase === 'authorizing' || upload.phase === 'uploading' || tx.busy
  const canSubmit = upload.phase === 'uploaded' || (file !== undefined && !tooLarge && !mismatch)

  async function submitCid(manifestCid: string) {
    const receipt = await tx.run((signer) => escrowContract(chainId, signer).submitMilestone(project.id, milestone.index, manifestCid))
    if (receipt) await queryClient.invalidateQueries()
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (upload.phase === 'uploaded') return submitCid(upload.manifestCid)
    if (!file || tooLarge || mismatch) return

    const provider = getInjectedProvider()
    const escrow = escrowAddressFor(chainId)
    if (!provider || !escrow) {
      setUpload({ phase: 'failed', message: 'Connect your wallet on a network where TrustLance is deployed.' })
      return
    }
    try {
      setUpload({ phase: 'authorizing' })
      const signer = await walletSigner(provider)
      const targets = await requestUploadTargets({ signer, chainId, escrow, projectId: project.id, milestoneIndex: milestone.index })
      setUpload({ phase: 'uploading' })
      const { manifestCid } = await uploadDeliverable({
        file: { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) },
        passphrase,
        targets,
      })
      setUpload({ phase: 'uploaded', manifestCid })
      await submitCid(manifestCid)
    } catch (error) {
      const message = error instanceof UploadProxyError || error instanceof DeliverableError ? error.message : describeError(error)
      setUpload({ phase: 'failed', message })
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
      <h3 className="font-medium">Submit milestone {milestone.index + 1}</h3>
      <fieldset disabled={working || upload.phase === 'uploaded'} className="space-y-3">
        <label className="block text-sm">
          Deliverable file (up to {MAX_MB} MB)
          <input type="file" required className={inputClass} onChange={(e) => setFile(e.target.files?.[0])} />
        </label>
        {tooLarge && <p className="text-sm text-red-600 dark:text-red-400">This file is larger than {MAX_MB} MB.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            Passphrase (optional)
            <input
              type="password"
              autoComplete="new-password"
              className={inputClass}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            Repeat passphrase
            <input
              type="password"
              autoComplete="new-password"
              className={inputClass}
              value={confirmPassphrase}
              onChange={(e) => setConfirmPassphrase(e.target.value)}
            />
          </label>
        </div>
        {mismatch && <p className="text-sm text-red-600 dark:text-red-400">The passphrases don't match.</p>}
      </fieldset>

      {passphrase ? (
        <Alert tone="info">
          The file is encrypted in your browser before upload. Share the passphrase with the client privately; it can't be
          recovered. The file name, type, size and SHA-256 are still public in the manifest, so give confidential files a
          neutral name.
        </Alert>
      ) : (
        <Alert tone="warning">
          <strong className="font-semibold">This file will be public.</strong> Without a passphrase, anyone who finds the
          IPFS link can download it, and it can't be deleted from IPFS. Add a passphrase for confidential work.
        </Alert>
      )}

      {upload.phase === 'authorizing' && (
        <Alert tone="info">
          <span className="inline-flex items-center gap-2">
            <Spinner /> Sign the upload authorization in your wallet (no gas)…
          </span>
        </Alert>
      )}
      {upload.phase === 'uploading' && (
        <Alert tone="info">
          <span className="inline-flex items-center gap-2">
            <Spinner /> {passphrase ? 'Encrypting and uploading' : 'Uploading'} to IPFS…
          </span>
        </Alert>
      )}
      {upload.phase === 'failed' && <Alert tone="error">{upload.message}</Alert>}
      {upload.phase === 'uploaded' && tx.state.phase !== 'confirmed' && (
        <p className="break-all text-xs text-slate-500">Uploaded. Manifest CID: {upload.manifestCid}</p>
      )}
      <TxStatus state={tx.state} chainId={chainId} confirmedText="Milestone submitted. The client's review window has started." />

      {tx.state.phase === 'confirmed' ? (
        <button type="button" className={buttonClass.secondary} onClick={onClose}>
          Close
        </button>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={buttonClass.primary} disabled={working || !canSubmit}>
            {working && <Spinner />}
            {upload.phase === 'uploaded' ? 'Retry submission' : 'Upload and submit'}
          </button>
          <button type="button" className={buttonClass.secondary} disabled={working} onClick={onClose}>
            Cancel
          </button>
        </div>
      )}
    </form>
  )
}
