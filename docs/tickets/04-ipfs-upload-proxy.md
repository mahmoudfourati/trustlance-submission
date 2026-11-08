# 04: IPFS upload proxy and deliverable manifest

**What to build:** The serverless upload proxy issues short-lived Pinata signed upload URLs to a wallet that signs a fresh message and is the freelancer of an Active project with that milestone Pending. In the browser, a deliverable module can optionally encrypt a file with a passphrase, upload the file and its manifest, and later fetch, decrypt and hash-check it.

**Blocked by:** 03

**Status:** ready-for-human

- [x] Proxy handler tests (Pinata and chain reader injected): bad signature, expired message, wrong signer, non-Active project and non-Pending milestone are rejected; the happy path returns a URL with the size and time limits
- [x] Encryption round-trip tests: right passphrase decrypts, wrong passphrase fails cleanly, a tampered file fails the hash check
- [x] The Pinata JWT only comes from the proxy's environment; an `.example` file documents the variable names
- [x] Runs locally next to the Vite dev server; one manual smoke upload against real Pinata is documented

## Comments

**2026-10-26, built; one manual step left.**

- The proxy handler, Pinata signer, environment config, deliverable module and proxy client were written test-first, with the proxy client's tests written alongside it. That's 53 new web unit tests, and 84 web tests now pass in total.
- The proxy runs inside the Vite dev server and was checked live against the local node. `npm run smoke:upload` was run with a placeholder JWT: it got through every step up to Pinata. The results are in `docs/upload-proxy.md`.
- ~~The one unchecked item is the **real Pinata smoke upload**~~ Done on 2026-10-28 (below); every item is now checked.

**2026-10-28, real Pinata smoke test passed.** The project owner ran `npm run smoke:upload -w @trustlance/web` with their own JWT: 1/1 in 8.76 s, project #2, manifest CID `bafkreih762l3z5ot4sc3yaz4fj7gid4o7ox7yrvv4iwf63jcqxvpkldqxa`. Upload, gateway read-back, decryption and the hash check succeeded against real Pinata, and the result is in the smoke log in `docs/upload-proxy.md`. The browser flow is ticket 12's end-to-end suite.

Decisions:

- **Two signed URLs per request** (file and manifest), because Pinata doesn't say whether a signed URL can be used twice.
- **One shared message format** (`uploadMessage.ts`) that binds the chain and escrow address, so a signature can't be replayed on another deployment.
- **Manifest PBKDF2 iterations are bounded** between 600k and 2M. This blocks downgrades and keeps a hostile manifest from making the browser hash for minutes.
- **Gateways are tried in order**, and content that fails the hash check counts against that gateway only. Reads are capped even without a `content-length` header.
- **A `keyCheck` value in the encryption block** separates a wrong passphrase from tampered ciphertext, since AES-GCM alone can't tell them apart.
- **The browser signs a 2-minute expiry while the proxy accepts 5 minutes**, which tolerates client clock skew.

These last points came from the two-axis review.

No contract changes: the milestone submission flow that records the manifest CID on-chain is ticket 05.
