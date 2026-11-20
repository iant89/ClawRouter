# Releases and the supply chain

Security roadmap phase 6 (SEC-018 to SEC-020): what ClawRouter is built from is
checked on every change, every release carries a software bill of materials, and
every release file is signed and checksummed.

## Dependency checks (SEC-018)

`bun run deps:check` runs three checks; CI runs it on every push, pull request and
weekly (new advisories appear without a push). The policy is
[`supply-chain.json`](../supply-chain.json).

| Check | Fails when |
|---|---|
| `lockfile` | a `bun.lock` package comes from anywhere but the npm registry, a workspace or a committed tarball (git, URLs, links, other registries); a registry package has no sha512 hash; a committed tarball (`vendor/enterprise-ui-react.tgz`) does not match its hash in `bun.lock`; a direct dependency is a range or a tag instead of an exact version; `trustedDependencies` lets a package run install scripts |
| `licenses` | a package's license is not in `licenses.allowed` (permissive licenses compatible with AGPL-3.0-or-later), or it has none. A package without a license field is read from its LICENSE file; one that cannot be read is set by hand in `licenses.packages`, with the reason |
| `audit` | `bun audit` reports a **high** or **critical** advisory (`audit.failOn`) not covered by an unexpired exception, or cannot reach the advisory database (fail closed). Moderate and low advisories are printed, not failed |

`bun install --frozen-lockfile` (CI and the Docker build) refuses a lockfile that does
not match `package.json`, and Bun checks every download against its hash.

An advisory that cannot be fixed yet, or does not reach ClawRouter, gets an exception
with a reason and an end date; after that date it fails again:

```json
"exceptions": [
  { "advisory": "GHSA-xxxx-xxxx-xxxx", "package": "name", "reason": "only in the tests; no fix yet", "expires": "2027-01-31" }
]
```

**Updates:** Dependabot ([`.github/dependabot.yml`](../.github/dependabot.yml)) proposes
weekly pull requests for npm packages, GitHub Actions and the Docker base image; CI runs
on each, and nothing merges without review. The vendored ENTERPRISE-UI tarball is
updated by hand ([`vendor/README.md`](../vendor/README.md)). Bun is pinned in three
places (the Dockerfile, the workflows and `@types/bun`): update them together; the
release refuses to build with a Bun other than the Dockerfile's, and a test checks the
workflows.

## Software bill of materials (SEC-019)

`bun run sbom` writes `release/clawrouter-<version>.spdx.json` (SPDX 2.3) and
`release/clawrouter-<version>.cdx.json` (CycloneDX 1.6). Each lists:

- ClawRouter itself: version, license, commit;
- every third-party package with its version, package URL, sha512 hash, license and
  dependencies, marked **runtime** (in the release bundle: CycloneDX scope `required`,
  SPDX `DEPENDS_ON`) or **development** (build and tests only: `excluded`,
  `DEV_DEPENDENCY_OF`);
- the runtime: Bun and the SQLite it embeds.

The SBOMs are deterministic: the same commit gives the same bytes (times come from
`SOURCE_DATE_EPOCH` or the commit). Both were checked against the reference validators
(`pyspdxtools` and the CycloneDX 1.6 JSON schema, strict) on 2026-11-20.

## Signed releases (SEC-020)

Pushing a tag `vX.Y.Z` that matches `package.json` runs
[`.github/workflows/release.yml`](../.github/workflows/release.yml):

```
source ─▶ build ─▶ artifacts ─▶ SHA-256 ─▶ signature ─▶ verify ─▶ GitHub release ─▶ verify the download
```

1. Install with the frozen lockfile, `scan-secrets`, `deps:check`, `bun run check`.
2. `bun run release:package`: a fresh build, then `clawrouter-<version>.tar.gz` (the
   production `dist/`, `deploy/`, `LICENSE`, `README.md`), both SBOMs, and `SHA256SUMS`.
   The tarball is reproducible: sorted entries, fixed times, owners and modes, no gzip
   timestamp (two clean builds of the same commit gave the same SHA-256 on 2026-11-20).
3. Every file, `SHA256SUMS` included, is signed with **cosign keyless signing**
   (Sigstore): the signature is bound to this workflow run for this tag and recorded in
   the public transparency log (Rekor). There is no long-lived signing key to protect.
   Each signature is a `<file>.sigstore.json` bundle next to the file.
4. `bun run release:verify release --version X.Y.Z --signed` checks everything before
   anything is published; then `gh release create` publishes the files.
5. A second job downloads the published release and verifies it again, with the
   commands below and with the release tool.

CI also builds the tarball, SBOMs and `SHA256SUMS` on every change and verifies them
(unsigned), so a broken release pipeline shows up before a tag.

### Verifying a release you downloaded

Download the files of a release (for example `gh release download v1.0.0 --repo iant89/ClawRouter`), then, with [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) 2.4 or later:

```bash
TAG=v1.0.0
# 1. SHA256SUMS was signed by ClawRouter's release workflow, for this tag:
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity "https://github.com/iant89/ClawRouter/.github/workflows/release.yml@refs/tags/$TAG" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
# 2. Every file matches it:
sha256sum -c SHA256SUMS
```

Both must succeed. Each file also has its own signature
(`cosign verify-blob --bundle clawrouter-1.0.0.tar.gz.sigstore.json ... clawrouter-1.0.0.tar.gz`).
From a source checkout, `bun run release:verify <dir> --version 1.0.0 --signed` does all
of this. A signature from any other workflow, branch or repository fails, and so does
a changed, missing or added file.

To rebuild a release and compare: check out the tag, `bun install --frozen-lockfile`,
`SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) bun run release:package` with the
Dockerfile's Bun version, and compare `release/SHA256SUMS`.

### Not covered yet

- The Docker image is not built or signed by the release workflow (only the tarball).
- The release workflow has not run yet: no tag has been pushed. Signing and the
  published-release check were written from cosign's documentation (cosign v3.1.4,
  `sigstore/cosign-installer` v4.1.3) and are exercised by the first release.
- Build provenance (SLSA attestations) and a reproducibility check in CI belong to
  SEC-044 and SEC-045.
