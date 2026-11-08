# IPFS uploads through a signed-URL proxy, with optional passphrase encryption

Deliverables go to IPFS through Pinata. The Pinata API key lives only in one serverless function, which gives out short-lived, size-limited signed upload URLs to a wallet that signs a fresh message and is, on-chain, the freelancer of an active project. The browser uploads the file directly with that URL. Before uploading, the freelancer can encrypt the file in the browser (AES-GCM, key derived from a passphrase with PBKDF2); the passphrase is shared with the client off-chain. Unencrypted deliverables are labelled public in the UI.

## Considered Options

- **Storacha client-only uploads**: no server, but every uploader has to sign up with an email account.
- **User-supplied Pinata keys**: no server, but poor UX and keys leak easily.
- **Wallet-based encryption (MetaMask `eth_getEncryptionPublicKey`)**: removes the off-chain passphrase, but that API is deprecated.

## Consequences

- The proxy is the only backend. It has no database and stores no files; Pinata keeps the pins.
- A CID guarantees integrity, not confidentiality or availability. The UI must handle gateway failures, and pins must be kept for the life of the demo.
