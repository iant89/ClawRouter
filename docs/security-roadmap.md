# Security roadmap

The owner's security hardening roadmap (2026-11-19): harden ClawRouter for
secure Internet-facing production use. Priority P0 → P4. Tick an item only when
it is built **and** tested, as in the [roadmap](roadmap.md). The review report and
the policy itself are in [security](security.md).

**Legend:** ✅ done · 🟡 in progress · ⬜ not started

| Item | Title | Priority | Status |
|---|---|---|---|
| SEC-001 | SSRF protection | Critical | ✅ (SMTP not yet) |
| SEC-002 | MCP security audit | Critical | ⬜ |
| SEC-003 | Backup / restore security audit | Critical | ⬜ |
| SEC-004 | Container hardening | Critical | ✅ |
| SEC-005 | Cost-based rate limiting | High | ⬜ |
| SEC-006 | Request resource limits | High | ⬜ |
| SEC-007 | Provider TLS enforcement | High | ✅ |
| SEC-008 | DNS rebinding protection | High | ✅ |
| SEC-009 | Request-data minimization (NONE / METADATA / FULL) | High | ⬜ |
| SEC-010 | Secret scrubbing test suite | High | ⬜ |
| SEC-011 | Backup credential separation | High | ⬜ |
| SEC-012 | Security regression suite (`tests/security/`) | High | ⬜ |
| SEC-013 | Authentication attack testing | Medium | ⬜ |
| SEC-014 | Authorization matrix testing | High | ⬜ |
| SEC-015 | WebSocket security | High | ⬜ |
| SEC-016 | Configuration security classification | Medium | ⬜ |
| SEC-017 | Configuration import sandbox | High | ⬜ |
| SEC-018 | Dependency security | Medium | ⬜ |
| SEC-019 | Software bill of materials | Medium | ⬜ |
| SEC-020 | Signed releases | Medium | ⬜ |
| SEC-021 | Fuzz testing | Medium | ⬜ |
| SEC-022 | CSP tightening (`style-src 'unsafe-inline'`) | Low | ⬜ |
| SEC-023 | Filesystem hardening | Medium | ⬜ |
| SEC-024 | systemd hardening | High | ⬜ |
| SEC-025 | Security health check (`doctor --security`) | Medium | ⬜ |
| SEC-026 | Security CI pipeline | High | ⬜ |
| SEC-027 | Security regression corpus (`tests/security/cases/`) | High | ⬜ |
| SEC-028 | Security event model | Medium | ⬜ |
| SEC-029 | Security alerting | Medium | ⬜ |
| SEC-030 | Security event retention | Low | ⬜ |
| SEC-031 | HTTP request smuggling review | Medium | ⬜ |
| SEC-032 | CORS security | High | ⬜ |
| SEC-033 | API error hardening | Medium | ⬜ |
| SEC-034 | HTTP method security | Low | ⬜ |
| SEC-035 | Provider isolation | High | ⬜ |
| SEC-036 | Provider response validation | High | ⬜ |
| SEC-037 | Provider timeouts | High | ⬜ |
| SEC-038 | Provider retry protection | Medium | ⬜ |
| SEC-039 | Resource ownership testing | High | ⬜ |
| SEC-040 | IDOR security audit | High | ⬜ |
| SEC-041 | Connection limits | Medium | ⬜ |
| SEC-042 | Streaming resource protection | High | ⬜ |
| SEC-043 | Memory exhaustion testing | High | ⬜ |
| SEC-044 | Reproducible release build | Medium | ⬜ |
| SEC-045 | Release security manifest | Low | ⬜ |
| SEC-046 | Security changelog | Low | ⬜ |
| SEC-047 | Threat model (`docs/security/threat-model.md`) | High | ⬜ |
| SEC-048 | Security architecture (`docs/security/architecture.md`) | High | ⬜ |
| SEC-049 | Security deployment guide | High | ⬜ |
| SEC-050 | Security policy (`SECURITY.md`) | High | ⬜ |
| SEC-051 | Security advisories | Medium | ⬜ |

**Implementation order:** the phases in sequence, 1 (network boundary) to 17
(disclosure program). **Principle:** treat every boundary as hostile: the
reverse proxy, the HTTP API, MCP and gateway input, provider URLs (untrusted
destinations) and provider responses (untrusted input) all enforce their own
controls.

### Final security gate

A release may be called "security hardened" only when all of these are done:
SEC-001 to SEC-012, SEC-014, SEC-015, SEC-017 to SEC-021, SEC-024 to SEC-029,
SEC-032, SEC-033, SEC-035 to SEC-043, and SEC-047 to SEC-051. (Not in the gate:
SEC-013, 016, 022, 023, 030, 031, 034, 044 to 046.) Status: 4 of 41.

## Phase 1: Network security boundary

### SEC-001 SSRF protection ✅

A centralized outbound-network layer, `packages/security/` (`outbound-network-policy.ts`,
`ip-classifier.ts`, `safe-dns.ts`, `ssrf-protection.ts`). See
[outbound network policy](security.md#outbound-network-policy).

- [x] Validate every provider URL (on save, and again on every call)
- [x] Resolve DNS before connecting
- [x] Reject IPv4 loopback, private, link-local, multicast and reserved addresses
- [x] Reject IPv6 loopback, private (ULA, site-local) and link-local addresses, and IPv6 forms of refused IPv4 addresses
- [x] Block cloud metadata endpoints (by address and by name), even when allowlisted
- [x] Prevent DNS rebinding; re-check the resolved IP before connecting (see SEC-008)
- [x] Explicit allowlist for trusted local providers (`CLAWROUTER_OUTBOUND_ALLOWLIST`)
- [ ] Centralize **all** outbound network policy: provider calls are covered; the SMTP client is not yet

Tests: `packages/security/test/policy.test.ts`, `guard.test.ts`,
`packages/api/test/outbound-api.test.ts`, the outbound case in
`apps/server/test/recovery.test.ts` (doctor), `packages/core/test/config.test.ts`.

### SEC-002 MCP security audit ⬜

Treat `/v1/mcp` as an independent boundary. Test authentication, API-key
authorization, tool enumeration and hidden tools, parameter validation,
permission bypass, object ownership, pagination, result-size limits, tool
chaining, error leakage, sensitive data, rate limits, concurrency and malicious
clients; as anonymous, signed-in user, Viewer, Operator, Administrator, keys with
and without MCP access, expired and revoked keys, and a disabled user.

### SEC-003 Backup / restore security audit ⬜

Audit creation, listing, download, import, restore, configuration export and
import, and secret-key handling for path traversal (`../`, absolute paths,
symlinks), arbitrary file creation or overwrite, permission changes, malicious,
corrupted or oversized SQLite files, archive bombs, malicious configuration and
secret-key exposure. Rule: canonicalize the path, verify it is inside the backup
directory, then touch the filesystem.

### SEC-004 Container hardening ✅

`deploy/compose.yaml` and the `docker run` example in
[deployment](deployment.md#container-hardening). Checked in a real container on
2026-11-19.

- [x] Non-root user (uid 1000, `bun`)
- [x] Read-only root filesystem (`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` in the image)
- [x] `no-new-privileges`
- [x] Drop all Linux capabilities
- [x] No privileged mode, no Docker socket, no host PID namespace, no host networking (documented as never to add)
- [x] Minimal writable volumes (`/data` only) and a `noexec` tmpfs for `/tmp`
- [x] Seccomp: Docker's default profile stays on (seen in filter mode)
- [ ] AppArmor / SELinux compatibility: nothing in the setup turns them off, but the test host had neither, so not verified

## Phase 2: AI gateway abuse protection

### SEC-005 Cost-based rate limiting ⬜

Cost limits per API key, user, model and provider; per hour, day and month:
`maxTokensPerRequest`, `maxEstimatedCostPerRequest`, `maxHourlyCost`,
`maxDailyCost`, `maxMonthlyCost`, `maxConcurrentRequests`, `maxStreamingDuration`.
(Request and token windows and user quotas exist: [rate limits](rate-limits.md).)

### SEC-006 Request resource limits ⬜

Beyond the byte limit: JSON depth, messages, content parts, tool definitions,
tool schema bytes, images, image bytes and dimensions, input and output tokens,
stream duration.

### SEC-007 Provider TLS enforcement ✅

- [x] HTTPS required by default; plain HTTP provider URLs rejected by default
- [x] HTTP only for explicitly trusted (allowlisted) endpoints, through one explicit configuration option
- [x] TLS certificates validated normally, also when the connection is pinned to an address (verified against the hostname)
- [x] TLS verification is never disabled (`rejectUnauthorized: true` is forced)

### SEC-008 DNS rebinding protection ✅

- [x] Validate the DNS result (every address)
- [x] Bind the connection to the validated address (IP in the URL, hostname in `Host` and TLS SNI)
- [x] No resolution change between validation and connect (one lookup per request)
- [x] Tested with IPv4 and IPv6 answers, and with multiple and mixed DNS answers
- Behind an egress proxy the proxy resolves names; the checks still run (documented)

## Phase 3: Data protection

- **SEC-009** ⬜ Logging modes NONE / METADATA (default) / FULL. FULL stores
  prompts, responses, tool calls and attachment metadata, behind a clear privacy
  warning. (Today: metadata only, plus opt-in [captures](captures.md).)
- **SEC-010** ⬜ Redaction tests for API keys, bearer tokens, cookies, passwords,
  provider and SMTP credentials, session ids, setup tokens, OAuth tokens, private
  keys, JWTs and MCP credentials, embedded in JSON, nested JSON, arrays, URLs,
  query parameters, headers, exceptions, stack traces, tool arguments and
  provider errors.
- **SEC-011** ⬜ Normal backups (database, configuration, operational data) apart
  from credential backups (plus the secret key): explicit confirmation and a
  warning, never listed in normal listings, restrictive permissions. (Today:
  `--include-secret-key`.)

## Phase 4: Security testing

- **SEC-012** ⬜ `tests/security/` with authentication, authorization, sessions,
  csrf, api-keys, rate-limits, mcp, ssrf, backup, restore, logging, websocket,
  provider and configuration.
- **SEC-013** ⬜ Credential stuffing, brute force, username enumeration, session
  fixation and replay, expired and revoked sessions, disabled accounts,
  concurrent sessions, setup-token replay and brute force, password-reset abuse,
  two-factor bypass, recovery-code replay.
- **SEC-014** ⬜ A machine-readable authorization matrix (routes × Administrator,
  Operator, Viewer, API key, anonymous), tested automatically. (Today: the
  authorization sweep in `packages/api/test/authorization-api.test.ts`.)
- **SEC-015** ⬜ WebSocket: authentication, session expiry and revocation,
  origin, message validation and size, connection limits, idle timeout,
  reconnection storms, subscription authorization; tested with valid, expired,
  revoked and invalid sessions, cross-origin, oversized and malformed frames,
  rapid reconnects.

## Phase 5: Configuration security

- **SEC-016** ⬜ Classify configuration values PUBLIC / SENSITIVE / SECRET /
  SECURITY_CRITICAL; the last two never logged, never in the normal API, MCP,
  errors or exports.
- **SEC-017** ⬜ Imported configuration as untrusted input: schema, types,
  ranges, URLs, paths, providers, rate limits, roles, permissions; reject
  malformed input and unknown security-sensitive fields; no privilege
  escalation, traversal or command execution. (Provider endpoints in imports
  already pass the outbound policy, through the provider service.)

## Phase 6: Supply chain security

- **SEC-018** ⬜ Automated auditing, lockfile verification, automated updates,
  license scanning, CI failure on high and critical vulnerabilities. (Today:
  `bun audit` and `--frozen-lockfile` in CI.)
- **SEC-019** ⬜ An SPDX and CycloneDX SBOM per release (version, dependencies
  and versions, runtime dependencies).
- **SEC-020** ⬜ Signed release artifacts, published SHA-256 checksums, a
  documented verification process, verification in CI.

## Phase 7: Advanced security

- **SEC-021** ⬜ Fuzz JSON parsing, request validation, provider responses, MCP
  messages, configuration imports, backups, routing configuration, model
  metadata and streams.
- **SEC-022** ⬜ Investigate removing `style-src 'unsafe-inline'` (ENTERPRISE-UI
  compatibility, fewer inline styles, CSP regression tests).
- **SEC-023** ⬜ Owner, group, permissions and umask of `data/`, the database,
  `secret.key`, `setup-token`, `backups/` and logs. Baseline: files 0600,
  `backups/` 0700. (Seen 2026-11-19: in the container the database is created
  0644.)

## Phase 8: Host / systemd hardening

- **SEC-024** ⬜ Evaluate `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`,
  `ProtectHome`, `ProtectKernelTunables`, `ProtectKernelModules`,
  `ProtectControlGroups`, `RestrictSUIDSGID`, `LockPersonality`,
  `RestrictRealtime`, `RestrictNamespaces`; allow only the directories ClawRouter
  needs.
- **SEC-025** ⬜ `bun run doctor --security`: HTTPS, secure cookies, CSRF,
  trusted proxies, hashed keys, encrypted credentials, key and database
  permissions, MCP off, no insecure provider URLs, no wildcard CORS, non-root
  container; warnings for broad backup permissions and prompt logging. (Doctor
  already reports refused provider endpoints and a catch-all outbound allowlist.)

## Phase 9: Continuous security

- **SEC-026** ⬜ Every pull request runs, in order: typecheck, unit tests,
  integration tests, security tests, dependency audit, secret scanning, SAST,
  container scanning, SBOM generation, build verification. Security tests cannot
  be skipped silently; critical failures block merge; high-severity findings
  block merge unless explicitly waived; dependency and container vulnerabilities
  are reported; secrets in commits fail CI; security reports are kept as CI
  artifacts; release builds use the same pipeline. (Today CI runs typecheck,
  tests, `bun audit` and `scan-secrets`.)
- **SEC-027** ⬜ `tests/security/cases/`: every discovered vulnerability becomes
  a permanent regression test (fix, add the test, merge the fix only with it).
  Cases for SSRF, CSRF, XSS, path traversal, authorization bypass, session
  fixation, API-key and secret leakage, MCP privilege escalation, request
  smuggling, HTTP desynchronization, DNS rebinding, denial of service,
  configuration injection, backup/restore attacks, WebSocket authorization and
  provider credential leakage.

## Phase 10: Security observability

- **SEC-028** ⬜ Standard security event names (`AUTH_LOGIN_SUCCESS`,
  `AUTH_LOGIN_FAILURE`, `AUTH_ACCOUNT_LOCKED`, `AUTH_SESSION_CREATED/REVOKED/EXPIRED`,
  `API_KEY_CREATED/REVOKED/SUSPENDED`, `USER_CREATED/DISABLED/ROLE_CHANGED`,
  `MCP_ACCESS_GRANTED/DENIED`, `MCP_TOOL_DENIED`, `SSRF_BLOCKED`,
  `INVALID_PROVIDER_URL`, `RATE_LIMIT_EXCEEDED`, `COST_LIMIT_EXCEEDED`,
  `BACKUP_CREATED/RESTORED`, `CREDENTIAL_BACKUP_CREATED`, `CONFIG_IMPORT`,
  `CONFIG_IMPORT_REJECTED`), each with timestamp, request id, actor where
  available, source IP where appropriate, result and reason; never secrets.
  (The audit log already records most of these under its own action names.)
- **SEC-029** ⬜ Alerts (INFO / WARNING / HIGH / CRITICAL) for repeated sign-in
  failures, API-key brute force, many denied requests, repeated SSRF attempts,
  repeated MCP authorization failures, excessive provider failures, cost-limit
  violations, request-volume spikes, configuration changes, new administrators,
  provider credential changes and backup restores.
- **SEC-030** ⬜ Retention for security events: configurable period, automatic
  expiry, bounded growth, protected from ordinary users, critical events kept
  longer, documented.

## Phase 11: API security

- **SEC-031** ⬜ Request smuggling review: Content-Length, Transfer-Encoding,
  HTTP/1.1 parsing, HTTP/2, reverse-proxy interaction, connection reuse, chunked
  encoding, malformed headers; tested directly, behind nginx and behind another
  supported proxy (Caddy).
- **SEC-032** ⬜ CORS: no wildcard origin with credentials, explicit origins,
  minimal methods and headers, explicit credentials, validated preflights,
  restrictive production defaults. (Today: no CORS at all on `/api` or `/v1`.)
- **SEC-033** ⬜ Errors never expose stack traces, filesystem or database paths,
  environment variables, provider keys, encryption keys, internal addresses, SQL
  or internal credentials; details go to server logs only.
- **SEC-034** ⬜ Every route defines its methods; unexpected methods, needless
  method tunneling, OPTIONS and HEAD behavior are refused; tested for GET, POST,
  PUT, PATCH, DELETE, OPTIONS and HEAD.

## Phase 12: Provider security

- **SEC-035** ⬜ Provider isolation: provider-specific error handling, timeouts,
  retry limits and circuit breakers; no credential cross-contamination; no
  shared mutable provider state.
- **SEC-036** ⬜ Provider responses are untrusted input: content type, JSON
  structure, maximum size and depth, expected fields, string lengths, numeric
  ranges and stream events are validated.
- **SEC-037** ⬜ Separate limits for DNS, TCP connect, TLS handshake, request
  headers and body, first response byte, streaming and total duration. (DNS has
  a 5 s timeout since SEC-001; calls have one total timeout.)
- **SEC-038** ⬜ Retries cannot amplify load: maximum count, exponential backoff
  with jitter, only safe failures, provider rate limits respected, global and
  per-request retry budgets.

## Phase 13: Tenancy and data isolation

- **SEC-039** ⬜ Users cannot reach another user's API keys, requests, usage,
  audit events, provider configurations, backups, sessions or MCP permissions:
  a resource id belonging to user B, used by user A, must be refused.
- **SEC-040** ⬜ IDOR audit of every endpoint taking a user, API key, provider,
  request, backup, session or audit-event id: ownership is enforced on the
  server, never by hard-to-guess ids.

## Phase 14: DoS resilience

- **SEC-041** ⬜ Limits for HTTP, WebSocket, MCP and provider connections and
  concurrent requests: global, per IP, per API key and per user.
- **SEC-042** ⬜ Streams: maximum duration and output bytes, idle timeout,
  backpressure and proper cancellation, against infinite streams, slow clients
  and providers, large responses, abandoned connections and leaks.
- **SEC-043** ⬜ Stress tests (large JSON, many messages, large tool definitions,
  large provider responses, many requests, WebSockets and MCP connections, large
  configuration imports): memory stays bounded, requests are refused before
  allocation grows, the process stays responsive and degrades gracefully.

## Phase 15: Release security

- **SEC-044** ⬜ Reproducible builds: pinned build dependencies and runtime,
  recorded build environment and source commit, verified artifacts.
- **SEC-045** ⬜ Each release publishes version, commit, build time, runtime
  version, dependency versions, SBOM, checksums, signature and security status.
- **SEC-046** ⬜ A security changelog per release: fixes, improvements,
  dependency updates, breaking security changes, new security configuration,
  deprecated insecure behavior.

## Phase 16: Security documentation

- **SEC-047** ⬜ `docs/security/threat-model.md`: assets (provider credentials,
  API keys, accounts, sessions, prompts, responses, usage, audit logs, the
  encryption key, backups, the host), trust boundaries, attackers, attack
  surfaces, assumptions, controls, residual risks.
- **SEC-048** ⬜ `docs/security/architecture.md`: Internet → reverse proxy → HTTP
  security layer (authentication, authorization, CSRF, rate and resource limits)
  → core (admin API, gateway API, MCP) → outbound security layer (URL, DNS, SSRF,
  TLS, timeouts) → providers.
- **SEC-049** ⬜ Deployment guides for Docker, systemd, nginx, Caddy, Cloudflare,
  LAN-only and Internet-facing: firewall, TLS, reverse proxy, trusted proxies,
  file permissions, backup security, secret management, network topology.

## Phase 17: Responsible disclosure

- **SEC-050** ⬜ `SECURITY.md`: supported versions, how to report, response
  time, disclosure process, CVEs, update policy.
- **SEC-051** ⬜ Advisory process (private investigation → fix → regression test
  → patch → advisory) with affected and fixed versions, severity, attack
  requirements, impact, mitigation and upgrade instructions.
