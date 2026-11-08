# Upload proxy and deliverables

How deliverables reach IPFS (ADR 0004), how to run the proxy locally, and the manual smoke test against real Pinata.

## How it works

1. The freelancer's wallet signs an upload authorization (EIP-191, no gas). The text comes from `uploadAuthorizationMessage` in `web/src/lib/uploadMessage.ts` and binds the chain id, escrow address, project, milestone index, account and an expiry. The browser signs a 2-minute expiry; the proxy accepts up to 5 minutes, which leaves room for a client clock that runs fast.
2. The browser posts it to `POST /api/upload-url`. The proxy (`web/server/uploadProxy.ts`):
   - recovers the signer and checks it matches the claimed account and the expiry;
   - rate-limits per account (10 per 10 minutes, per warm instance; best effort);
   - reads the chain: the signer must be the project's freelancer, the project Active, the milestone Pending;
   - asks Pinata for two signed upload URLs that live 60 seconds: one for the deliverable (≤ 50 MB) and one for the manifest (≤ 16 KB, JSON only).
3. The browser (`web/src/lib/deliverable.ts`) optionally encrypts the file (AES-256-GCM, key from PBKDF2-SHA-256 with 600 000 iterations, fresh salt and IV), uploads it, then uploads the manifest. The manifest's encryption block also carries a `keyCheck` (from the second half of the PBKDF2 output), so a wrong passphrase is reported before any download and is never confused with an altered file. The manifest CID is what Ticket 05 records on-chain.
4. Reading back fetches the manifest and file from the gateways in order (`VITE_PINATA_GATEWAY` first, then public ones; `web/src/lib/ipfsGateways.ts`), decrypts if needed, and checks size and SHA-256. Reads are capped at the expected size even without a `content-length` header. A gateway that serves wrong bytes is skipped in favour of the next one. Failure states: not found, timed out, unavailable, wrong passphrase, hash mismatch (altered or swapped file), invalid manifest.

Error codes the proxy returns: `invalid-request` (400/405/413), `unsupported-chain` (400), `expired`, `invalid-expiry` and `invalid-signature` (401), `not-freelancer`, `project-not-active`, `milestone-not-pending` (403), `unknown-project`, `unknown-milestone` (404), `rate-limited` (429), `upstream-failed` (502), `not-configured` (503).

## Configuration

Server-only settings live in the host environment, never in the repo. Locally, copy `web/.env.example` to `web/.env.local` (git-ignored) and fill in:

- `PINATA_JWT`: a Pinata API key JWT with the `org:files:write` scope. Without it the proxy answers 503 `not-configured`.
- `UPLOAD_PROXY_RPC_URL_<chainId>`: RPC per chain. `31337` defaults to `http://127.0.0.1:8545`; set `11155111` for Sepolia.

Never prefix these with `VITE_`: Vite bundles `VITE_` variables into public JavaScript.

The browser side has one optional setting: `VITE_PINATA_GATEWAY`, the bare host of a dedicated Pinata gateway (for example `example.mypinata.cloud`). It is public by design.

## Running locally

```bash
npm run chain
```

```bash
npm run deploy:local
```

```bash
npm run dev
```

The Vite dev server serves the proxy at http://localhost:5173/api/upload-url (`uploadProxy` plugin in `web/vite.config.ts`). In production the same handler runs as the Vercel Function `web/api/upload-url.ts`. Restart the dev server after changing `web/.env.local`.

## Manual smoke test against real Pinata

With the three commands above running and `PINATA_JWT` set in `web/.env.local`:

```bash
npm run smoke:upload -w @trustlance/web
```

It creates and accepts a project with Hardhat's local accounts 2 and 3, asks the running proxy for upload URLs, uploads a small encrypted file and its manifest to Pinata, then fetches both back through public gateways (or `SMOKE_GATEWAY=<your-gateway>.mypinata.cloud`), decrypts and hash-checks. It prints the manifest and file CIDs. The pins stay in your Pinata account; delete them there afterwards if you like.

### Smoke log

| Date | Who | Result | Manifest CID |
|---|---|---|---|
| 2026-10-28 | Project owner, local machine with their own `PINATA_JWT` | Passed: 1/1 in 8.76 s, project #2. Real Pinata upload of an encrypted file and its manifest, gateway read-back, decryption and SHA-256 check all succeeded. | `bafkreih762l3z5ot4sc3yaz4fj7gid4o7ox7yrvv4iwf63jcqxvpkldqxa` |

Verified without a real JWT on 2026-10-26, against the local node and the dev-server proxy:

- Live on-chain checks returned `project-not-active` for an Open project, `unknown-project`, `not-freelancer` for the client's signature and `unknown-milestone`.
- `npm run smoke:upload` with a placeholder JWT created and accepted a project, signed the authorization, passed every proxy check and stopped at Pinata with `upstream-failed`. The real run on 2026-10-28 (above) covered the Pinata upload and gateway read-back.

The smoke test drives the proxy and the deliverable module from Node, not the browser UI. The browser flow (submitting a milestone through `SubmitDeliverable`, then downloading and decrypting through `DeliverableDownload`) is covered by the ticket 12 end-to-end suite (`docs/e2e.md`): on every run against a local pinning store, and with `npm run test:e2e:pinata` against real Pinata, which passed on 2026-10-28.

Gateways: `ipfs.io` and `dweb.link` sometimes answer HTTP 429 without CORS headers, which a browser reports as a network error. Set `VITE_PINATA_GATEWAY` (a dedicated gateway, or `gateway.pinata.cloud`) so downloads don't depend on them.

## Known limits

- The manifest is public even when the file is encrypted: it shows the original file name, MIME type, size and the plaintext SHA-256 (the spec lists these fields). Anyone who can guess the exact file can confirm the guess with the hash. Freelancers should give confidential files neutral names.
- Gateways are trusted to serve the right manifest for a CID (the browser does not recompute CIDs). The file itself is checked against the manifest's SHA-256.
- The rate limit is in memory, so it only applies per warm serverless instance.
- A signed authorization can be reused until it expires (≤ 5 minutes) to get more URLs; the rate limit bounds this.
