# Supply chain security

How ClawRouter keeps its dependencies and releases trustworthy (security roadmap phase 6:
SEC-018, SEC-019, SEC-020). Users checking a download want
[release verification](security/release-verification.md).

```bash
bun run deps:check            # lockfile, Bun pins, licenses, vulnerabilities (CI, weekly)
bun run deps:check --offline  # the same without the vulnerability audit (needs the npm registry)
bun run sbom                  # SPDX and CycloneDX SBOMs for this checkout, in sbom/
bun run release               # a release in release/: archive, SBOMs, SHA256SUMS (unsigned)
bun run release --ephemeral-key && bun run release:verify release --public-key release-ephemeral.pub
bun run release:keygen <file> # once: the release signing key pair
```

The code is in `scripts/supply-chain/`; the policy (allowed licenses, exceptions) in
[`scripts/supply-chain/policy.ts`](../scripts/supply-chain/policy.ts). Regression tests:
`tests/security/supply-chain/`.

## Dependencies (SEC-018)

ClawRouter has 13 third-party packages: 5 ship in the release (React, React DOM, scheduler,
lucide-react, the vendored ENTERPRISE-UI) and 8 only build and test it (TypeScript and type
definitions). `bun run deps:check` fails when:

| Check | Fails when |
|---|---|
| Lockfile | a package has no sha512 integrity hash; comes from anywhere but the npm registry or `vendor/` (git, GitHub, URLs, another registry); a vendored tarball no longer matches its hash; a `package.json` disagrees with `bun.lock`; a version is a range instead of exact; `trustedDependencies` lets a dependency run install scripts; `.npmrc` or `bunfig.toml` sets a registry |
| Bun pins | the Bun version in `ci.yml`, `release.yml`, `dependencies.yml`, the `Dockerfile` and `@types/bun` differ |
| Licenses | an installed package's license (SPDX expression from its `package.json`) cannot be satisfied with `ALLOWED_LICENSES` (permissive licenses compatible with AGPL-3.0-or-later), or states none |
| Vulnerabilities | `bun audit` reports a **high or critical** advisory not in `AUDIT_EXCEPTIONS`, or an exception has expired; an unknown severity counts as critical, and an unreadable answer fails |

Low and moderate advisories are printed as warnings (GitHub annotations in CI). `bun audit
--json` exits 0 whatever it finds, so the decision is made by the script, not the exit code.
`bun install --frozen-lockfile` in CI additionally refuses a lockfile that is out of date.

**Accepting an advisory** (only when it cannot be reached or fixed yet): add
`{ id: 'GHSA-…', package, reason, expires: 'YYYY-MM-DD' }` to `AUDIT_EXCEPTIONS`. After the date
it fails again; an exception that no longer matches anything is reported for removal.

**A new license**: review it, then add it to `ALLOWED_LICENSES`. A package without a license
field gets an entry in `LICENSE_OVERRIDES` with the reason (ENTERPRISE-UI has one: its tarball's
`LICENSE` is MIT).

**Updates**: Dependabot ([`.github/dependabot.yml`](../.github/dependabot.yml)) proposes npm
(Bun), GitHub Actions and Docker updates weekly, grouped, after a 7-day cooldown so a hijacked
release has time to be found. Every update goes through CI. ENTERPRISE-UI is updated by hand
(`vendor/README.md`). Bun itself is pinned in five places: update them in one pull request, or
`deps:check` fails. New advisories appear without any commit, so
[`dependencies.yml`](../.github/workflows/dependencies.yml) runs the check every Monday.

## Software bill of materials (SEC-019)

Every release carries `clawrouter-<version>.spdx.json` (SPDX 2.3) and
`clawrouter-<version>.cdx.json` (CycloneDX 1.6), built from `bun.lock` and the installed
packages. Both list:

- the application: name, version, license, repository, commit;
- every dependency with its exact version, SHA-512 (from the lockfile), declared license,
  package URL and download location;
- whether it is a **runtime** dependency (reached from a workspace's `dependencies`, so bundled
  into the release) or a **development** one (CycloneDX `scope: excluded`, SPDX
  `DEV_DEPENDENCY_OF`), and the dependency graph;
- the runtime: Bun (the version the release was built and tested with) and the SQLite built
  into it.

Timestamps come from the commit and ids are derived from it, so one commit always gives the
same SBOM. Both were checked with the reference validators (`pyspdxtools` from spdx-tools and
cyclonedx-python-lib's strict 1.6 JSON schema) on 2026-11-20.

## Signed releases (SEC-020)

```
source (tag vX.Y.Z) -> build -> archive -> SHA-256 -> Ed25519 signature -> GitHub release -> verify again
```

- **Archive**: `clawrouter-<version>.tar.gz` holds `dist/` (the self-contained production
  build), `deploy/`, `LICENSE`, `README.md` and `BUILD-INFO.json` (version, commit, Bun). It is
  written by ClawRouter's own tar writer: sorted entries, the commit's time, owner 0, no links,
  gzip without a timestamp. The same commit gives byte-identical archives on any machine (checked
  from two different checkout paths).
- **Checksums**: `SHA256SUMS`, in `sha256sum -c` format, lists the archive and both SBOMs.
- **Signature**: `SHA256SUMS.sig` is an Ed25519 signature (64 raw bytes) of `SHA256SUMS`, so
  it covers every file. Ed25519 through Bun's built-in crypto needs no extra tool to sign, and
  OpenSSL 3 verifies it.
- **Verification** (`bun run release:verify`): the signature against
  [`docs/security/release-signing-key.pub`](security/), every checksum, no file in the folder
  that is not listed, the expected version, archive entries only plain files and folders inside
  `clawrouter-<version>/` (no `..`, no links), and SBOMs for the same version.

**In CI** ([`ci.yml`](../.github/workflows/ci.yml)), every push and pull request builds a full
release, signs it with a throwaway key and verifies it, with ClawRouter's verifier and with
`sha256sum` and OpenSSL. **On a tag** ([`release.yml`](../.github/workflows/release.yml)):
the tag must equal `package.json`'s version; all checks and tests run; the build happens
before the key is given to the packaging step; the result is verified against the committed
public key; the GitHub release is created; a second job downloads it and verifies it again.
`--sign` refuses an uncommitted tree and a key that does not match the committed public key.

### The signing key (maintainer, once)

```bash
bun run release:keygen ~/clawrouter-release-signing.key
```

writes the private key outside the repository (mode 0600) and the public key to
`docs/security/release-signing-key.pub`. Commit the public key; add the private key's content as
the secret `CLAWROUTER_RELEASE_SIGNING_KEY` of a GitHub environment named `release` (Settings →
Environments; restrict it to `v*` tags), and keep an offline copy. Until then the release
workflow stops at signing: releases are never published unsigned. To replace the key, generate a
new pair, commit the new public key and say so in the release notes; older releases verify with
the public key at their own tag.
