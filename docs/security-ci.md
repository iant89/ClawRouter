# Security CI pipeline

The security pipeline (SEC-026, [security roadmap](security-roadmap.md#phase-9-continuous-security))
runs on every pull request, every push to `main`, every Monday (new advisories appear without a
push) and before every release. It is one reusable workflow,
[`.github/workflows/security-pipeline.yml`](../.github/workflows/security-pipeline.yml), called
by `ci.yml` and by `release.yml` (where the release job `needs` it, so nothing is built for a tag
that fails it). The stages are `bun run security:ci` ([`scripts/security-ci.ts`](../scripts/security-ci.ts)),
so a developer runs exactly what CI runs:

```bash
bun run security:ci                 # every stage in order, then the summary (~40 s)
bun run security:ci sast secrets    # some stages only
bun run security:ci summary         # the result so far (fails if a stage failed or has no report)
bun run sast                        # static analysis alone (--json <file> for the report)
```

## Stages

| # | Stage | What runs | Fails on |
|---|---|---|---|
| 1 | TypeScript typecheck | `tsc --noEmit` | any type error |
| 2 | Unit tests | every test file outside the integration and security folders | a failing test |
| 3 | Integration tests | `packages/api/test` (the whole HTTP pipeline) and `apps/server/test` (real servers) | a failing test |
| 4 | Security tests | `tests/security/` with a JUnit report | a failing test, **any skipped, focused or todo security test**, a security test file that did not run |
| 5 | Dependency audit | `bun run deps:check` (SEC-018); the full `bun audit --json` is kept | a lockfile or license problem, a high or critical advisory |
| 6 | Secret scanning | `scan-secrets` on the tracked files, and on the **pull request's commits** (`--range base..head`; `--history` on `main`) | a credential-shaped string, a forbidden file |
| 7 | SAST | `scripts/security/sast.ts` on the shipped source | a critical finding, an unwaived high one, a stale waiver |
| 8 | Container scanning | the Dockerfile and `deploy/compose.yaml` hardening (SEC-004); the built image scanned by Trivy | a weakened image definition; a **fixable critical** vulnerability (policy below) |
| 9 | SBOM generation | `bun run sbom` (SEC-019) into the reports | the SBOM cannot be written |
| 10 | Build verification | `bun run build`, `release:package --skip-build`, `release:verify` (SEC-020) | the build or the release artifacts fail |

Every test file in the repository belongs to exactly one of stages 2–4 (a test checks it), so a
new test folder can never fall outside the pipeline.

## Nothing is skipped silently

- Each stage writes `security-reports/stages/NN-<stage>.json`. The summary step fails when a stage
  **failed or left no report**: a stage removed from the workflow, skipped by a condition, or one
  that crashed before writing shows up as "no report", not as green.
- Every stage after the first runs even when an earlier one failed (`if: !cancelled()`), so the
  reports are complete; the job still fails.
- Security tests: `.only`, `.skip`, `.todo`, `.skipIf`, `.todoIf`, `.if` and `.failing` in
  `tests/security/` fail stage 4, as does a skipped test in its JUnit report. The only exceptions
  are listed in `CONDITIONAL_SECURITY_TESTS` (`scripts/security/pipeline.ts`) with a reason, and
  **in CI even they must run** (today: the `systemd-analyze` rating, installed on the runners).
- Container scanning without an image report is "not run": accepted on a developer machine, a
  failure in CI.

## Severity and waivers

**SAST** ([`scripts/security/sast.ts`](../scripts/security/sast.ts)): rules on the TypeScript
syntax tree, written for ClawRouter (no scanner dependency, spec §47):

| Severity | Rules | Effect |
|---|---|---|
| critical | `no-eval` (eval, `new Function`, string timers) | always fails; cannot be waived |
| high | `html-injection`, `tls-verification-disabled`, `shell-command`, `sqlite-outside-database`, `unguarded-outbound-fetch` (domain packages must use the outbound guard), `insecure-random`, `wildcard-cors`, `debugger-statement` | fails unless waived |
| medium | `sql-interpolation`, `weak-hash`, `console-in-library` | reported only |

A high finding is waived **in the code**, on its line or the line above, with a reason of at
least 15 characters, so the exception is reviewed with the change that needs it:

```ts
// security-waiver: insecure-random -- weighted routing draws pick a model, they are not secrets
const random = snap.random ?? Math.random;
```

Waived findings stay in `sast.json`; a waiver that matches no finding fails the stage (remove
it). Four waivers exist today: the routing weights, the console's reconnect jitter, the
`doctor --security` loopback probe that does not verify its own certificate, and the SBOM
script reading `sqlite_version()`. The 34 `sql-interpolation` findings were reviewed when the
rule was added: they interpolate placeholders, fixed column names or `WHERE` clauses the code
built, never a value.

**Dependencies**: `supply-chain.json` `audit` (high and critical fail; exceptions need a reason
and an `expires` date). Every advisory, also below that level, is in `audit.json`.

**Container image**: `supply-chain.json` `container`: `failOn: ["critical"]` with
`fixedOnly: true`: a critical vulnerability with a fixed version fails (rebuild on a newer base
image), one without a fix yet is reported. Every vulnerability is in `container-scan.json` and
Trivy's own `trivy-image.json`. An exception names the vulnerability and package, with a reason
and an `expires` date:

```json
"container": { "failOn": ["critical"], "fixedOnly": true, "exceptions": [
  { "vulnerability": "CVE-2026-0000", "package": "libexample", "reason": "not reachable: …", "expires": "2026-12-31" }
] }
```

## Reports

The `security-reports-<run>-<attempt>` artifact of every run (kept 90 days): `summary.md` and
`summary.json`, one JSON report and one log per stage, the JUnit reports of the three test
stages, `audit.json`, `sast.json`, `trivy-image.json`, `container-scan.json` and both SBOMs. The
summary table also appears on the run's page.

## Blocking merges

The pipeline fails the check; GitHub blocks the merge only when the check is **required**. The
repository owner sets this once: Settings → Branches (or Rules) → protect `main` → require status
checks → add **"security / Security pipeline"**. Until then a red pipeline is visible but does
not stop a merge.

## Not covered

- Trivy downloads its vulnerability database at run time; the image is scanned for OS and
  language packages, not for secrets or misconfiguration (those are stages 6 and 8's own checks).
- The SAST rules are pattern rules on single files, not data-flow analysis: they catch the
  listed constructs, not every way of building one.
- The pipeline never ran on GitHub from this branch before review (no workflow run is possible
  from the development session); the stages were run locally, the Trivy step was not.
