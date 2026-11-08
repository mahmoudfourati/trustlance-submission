import { useState, type FormEvent } from 'react'
import { DeliverableError, fetchDeliverableFile, fetchManifest, safeFileName, type DeliverableManifest } from '../lib/deliverable'
import { ipfsGateways } from '../lib/ipfsGateways'
import { buttonClass, inputClass } from './styles'
import { Alert, Spinner } from './ui'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function errorMessage(error: unknown): string {
  return error instanceof DeliverableError ? error.message : "Couldn't load the deliverable. Retry in a moment."
}

/** Saves bytes as a download. Always typed as a generic binary so the browser never renders it inline. */
function saveFile(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * Loads a submission's manifest from IPFS, asks for the passphrase if it's encrypted, then downloads, decrypts and
 * hash-checks the file before saving it.
 */
export function DeliverableDownload({ manifestCid }: { manifestCid: string }) {
  const [manifest, setManifest] = useState<DeliverableManifest>()
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)

  async function loadManifest() {
    setBusy(true)
    setError(undefined)
    try {
      setManifest(await fetchManifest(manifestCid, { gateways: ipfsGateways }))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function download(event: FormEvent) {
    event.preventDefault()
    if (!manifest) return
    setBusy(true)
    setError(undefined)
    setSaved(false)
    try {
      const bytes = await fetchDeliverableFile(manifest, { gateways: ipfsGateways, passphrase })
      saveFile(bytes, safeFileName(manifest.name))
      setSaved(true)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (!manifest) {
    return (
      <div className="space-y-2">
        <button type="button" className={buttonClass.secondary} disabled={busy} onClick={() => void loadManifest()}>
          {busy && <Spinner />} Open deliverable
        </button>
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    )
  }

  return (
    <form onSubmit={(e) => void download(e)} className="space-y-2 rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/50">
      <p>
        <span className="font-medium break-all">{safeFileName(manifest.name)}</span>{' '}
        <span className="text-slate-500">
          · {formatBytes(manifest.size)} · {manifest.encryption ? 'encrypted' : 'public file'}
        </span>
      </p>
      {manifest.encryption && (
        <label className="block">
          Passphrase from the freelancer
          <input
            type="password"
            autoComplete="off"
            required
            className={`${inputClass} max-w-sm`}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
        </label>
      )}
      <button type="submit" className={buttonClass.secondary} disabled={busy}>
        {busy && <Spinner />} {manifest.encryption ? 'Decrypt and download' : 'Download'}
      </button>
      {error && <Alert tone="error">{error}</Alert>}
      {saved && <Alert tone="success">Downloaded. The file matched the SHA-256 the freelancer committed to.</Alert>}
    </form>
  )
}
