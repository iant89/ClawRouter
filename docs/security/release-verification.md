# Verifying a ClawRouter release

Every release on GitHub has five files:

| File | What it is |
|---|---|
| `clawrouter-<version>.tar.gz` | the production build (`dist/`), `deploy/`, `LICENSE`, `README.md`, `BUILD-INFO.json` |
| `clawrouter-<version>.spdx.json` | software bill of materials, SPDX 2.3 |
| `clawrouter-<version>.cdx.json` | software bill of materials, CycloneDX 1.6 |
| `SHA256SUMS` | SHA-256 of the three files above |
| `SHA256SUMS.sig` | Ed25519 signature of `SHA256SUMS` |

The signature proves `SHA256SUMS` was made with the project's signing key; the checksums prove
each file is the one that was signed. Check both before installing.

## The public key

The public key is in the repository at
[`docs/security/release-signing-key.pub`](https://github.com/iant89/ClawRouter/blob/main/docs/security/release-signing-key.pub).
Take it from the repository, not from a release or a mirror: whoever could change a download
could change a key next to it.

## With OpenSSL and coreutils (no ClawRouter needed)

In the folder with the downloaded files and the public key (OpenSSL 3.0 or later):

```bash
openssl pkeyutl -verify -pubin -inkey release-signing-key.pub -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig
sha256sum -c SHA256SUMS
```

Expect `Signature Verified Successfully` and `OK` for every file. On macOS use
`shasum -a 256 -c SHA256SUMS`. Anything else: do not install it, and report it
(see the repository's security policy).

## With ClawRouter's verifier

From a checkout of the release's tag:

```bash
bun run release:verify <download folder> --version <version>
```

It checks the signature and checksums, and also that no unlisted file was added, that the
archive only unpacks plain files inside `clawrouter-<version>/` (no `..`, no links) and that
both SBOMs describe the same version.

## Reproducing a release

Releases are reproducible: building the tag gives the same archive.

```bash
git clone https://github.com/iant89/ClawRouter && cd ClawRouter && git checkout v<version>
bun install --frozen-lockfile    # with the Bun version in BUILD-INFO.json
bun run release
sha256sum release/clawrouter-<version>.tar.gz   # equals the line in the published SHA256SUMS
```
