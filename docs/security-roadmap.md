# Security roadmap

The owner's security hardening roadmap (2026-11-19): harden ClawRouter for
secure Internet-facing production use. Priority P0 → P4. Tick an item only when
it is built **and** tested, as in the [roadmap](roadmap.md). The review report and
the policy itself are in [security](security.md). The roadmap's **full original
text**, every item with every checkbox, is in
[security-roadmap-full.md](security-roadmap-full.md); this page is the condensed
tracking copy with status, findings and decisions.

**Legend:** ✅ done · 🟡 in progress · ⬜ not started

| Item | Title | Priority | Status |
|---|---|---|---|
| SEC-001 | SSRF protection | Critical | ✅ (SMTP not yet) |
| SEC-002 | MCP security audit | Critical | ✅ |
| SEC-003 | Backup / restore security audit | Critical | ✅ |
| SEC-004 | Container hardening | Critical | ✅ |
| SEC-005 | Cost-based rate limiting | High | ✅ (not per individual key) |
| SEC-006 | Request resource limits | High | ✅ |
| SEC-007 | Provider TLS enforcement | High | ✅ |
| SEC-008 | DNS rebinding protection | High | ✅ |
| SEC-009 | Request-data minimization (NONE / METADATA / FULL) | High | ✅ |
| SEC-010 | Secret scrubbing test suite | High | ✅ |
| SEC-011 | Backup credential separation | High | ✅ |
| SEC-012 | Security regression suite (`tests/security/`) | High | ✅ |
| SEC-013 | Authentication attack testing | Medium | ⬜ |
| SEC-014 | Authorization matrix testing | High | ✅ |
| SEC-015 | WebSocket security | High | ✅ |
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
SEC-013, 016, 022, 023, 030, 031, 034, 044 to 046.) Status: 14 of 41.

## Phase 1: Network security boundary

Done, with two open boxes: the SMTP client is outside the outbound policy
(SEC-001), and AppArmor/SELinux could not be verified here (SEC-004).

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

### SEC-002 MCP security audit ✅

Audited 2026-11-19 (`packages/api/src/mcp/server.ts`, `tools.ts`). `/v1/mcp` is
its own boundary: a 404 before any key check while the `mcpEnabled` setting is
off; then an API key **with MCP access** (401 without a key, for a wrong,
expired or revoked key or a disabled owner; 403 for a key without MCP access); a
same-origin `Origin` check against browser pages (DNS rebinding); a 256 KB body
cap; one JSON-RPC message per request. Tools only read, go through the same
services as the console with the same permission each, and use the owner's
permissions **read again on every message**.

Found and fixed:

| Finding | Fix |
|---|---|
| No limit on a tool's answer: a broad `get_usage` series or a large registry could return many megabytes into an agent's context. | Answers over 1 MB (`MCP_RESULT_LIMIT`) are refused as a tool error that tells the model to narrow the question (logged as `too_large`). |
| Any request id was echoed back, whatever its length (up to the 256 KB body), and non-integer numbers such as `1e400` were accepted. | Ids are at most 200 characters; numeric ids must be safe integers. |

Checked and fine:

- [x] Authentication and API-key authorization (anonymous, console session, wrong key, key without MCP access, expired, revoked, disabled owner, MCP switched off)
- [x] Tool enumeration per role: Administrator all 10; Operator with the audit log; Viewer without it; everyone their own quota and keys
- [x] Hidden-tool discovery: an unpermitted tool answers exactly like a tool that does not exist
- [x] Parameter validation: typed readers with length and range limits; the schema is advice, the readers are the rules; prototype keys in arguments are ignored
- [x] Permission bypass: permissions are read per message (removing a role removes its tools at once)
- [x] Object ownership: `list_my_api_keys` and `get_my_quota` show only the caller's own
- [x] Pagination: page sizes capped (50 or 200); a page past the end is a tool error
- [x] Result-size limits (fixed above)
- [x] Tool chaining: every tool only reads; none returns or creates a secret
- [x] Error leakage: unexpected failures answer a generic 500 (no path, SQL or secret); tool errors carry only validation and "not found" text
- [x] Sensitive data: no credential in any tool answer (canary test in `mcp-api.test.ts`)
- [x] Rate limiting: `tools/call` counts against the key's limits (429); `tools/list`, `initialize` and `ping` do not (they return no data; unauthenticated probing is limited per address by the invalid-key limit)
- [x] Concurrent requests: each answer carries its own id and the right caller's tools
- [x] Malicious clients: deep nesting, huge ids, non-string methods, `__proto__` / `constructor` names, array arguments, oversized bodies, cross-site origins

Tests: `tests/security/mcp/mcp.test.ts` (the size and id cases were verified to fail
without the fixes) and `packages/api/test/mcp-api.test.ts`.

### SEC-003 Backup / restore security audit ✅

Audited 2026-11-19. **Surface:** backups are made, listed and restored only by
the command-line tools (`bun run backup`, `restore`, `doctor`, `migrate`) and by
the server itself (scheduled, pre-migrate, pre-import); there is **no HTTP route**
to list, download, upload or restore a backup, and backups are directories, not
archives. Configuration export/import is the one HTTP surface (`/api/configuration`,
`configuration.manage`). The attacker considered is whoever can write into a
backup directory before an operator restores from it.

Found and fixed (`apps/server/src/backup.ts`):

| Finding | Fix |
|---|---|
| Restore checked the backup's database in place, then read it again to install it: what was installed was not necessarily what was checked, and SQLite read any `-wal` file planted next to it during the check. | The database is copied **once** into a private directory next to the live one (0700, file 0600, `O_EXCL`), hashed while copying; every check runs on the copy and that same file is moved into place. |
| Symbolic links were followed: `clawrouter.db -> /etc/shadow` would be read. | Files are opened with `O_NOFOLLOW` and must be regular files; a linked backup directory is refused; listing and pruning skip linked entries, so pruning never deletes through a link. |
| A crafted database (an extra trigger that rewrites a password hash, a view, a table, a changed column) passed the integrity check and checksum. | Its schema must equal what this version's migrations create for the migrations it records; its migration ledger must match the manifest. |
| A malformed manifest crashed with a raw exception. | The manifest is capped at 1 MB and its shape validated (hex checksum, fixed database file name, integer sizes, lists). |
| Whole files were read into memory to hash and copy. | Streamed in 1 MB pieces; the size must match the manifest and fit in the free space first. |
| Backup labels became part of a path unchecked (only internal values today). | Labels must be `[a-z0-9-]`. |

Checked and fine: backup directories 0700 and files 0600 (also `secret.key` when
included); the restored database 0600; a restore refuses a running server, a
newer schema and (without `--force`) a key that cannot open its secrets; the
secret key is never printed, only its fingerprint and file location; exports
carry no secret. Imported provider endpoints pass the outbound policy (SSRF
through an import is refused), and imported roles get the no-escalation checks.

- [x] Backup creation, listing, restore; configuration export and import; secret-key handling
- [x] Download / upload / HTTP import of backups: none exist (nothing to traverse)
- [x] Path traversal, `../`, absolute paths: backup paths come from the operator's command line; names inside are fixed; labels validated
- [x] Symlink attacks, arbitrary file overwrite or creation (`O_NOFOLLOW`, `O_EXCL`, private staging)
- [x] Malicious, corrupted and oversized SQLite databases
- [x] Archive bombs: no archives
- [x] Malicious configuration (outbound policy, role rules; SEC-017 goes further)
- [x] Secret-key exposure

Tests: `tests/security/restore/backup-restore.test.ts`, `tests/security/configuration/configuration-import.test.ts`
(the schema cases were verified to fail with the check removed).

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

### SEC-005 Cost-based rate limiting ✅

Built 2026-11-20; see [cost limits](rate-limits.md#cost-limits-sec-005). Stored in
the rate-limit document (`costLimits`, `requestLimits`), edited on Gateway → Rate
Limits, exported and imported with the configuration, audited as
`RATE_LIMITS_UPDATED`.

- [x] Per API key, per user, per model, per provider (and the whole gateway)
- [x] Per hour, per day, per month (UTC calendar periods, from the stored usage records)
- [x] `maxHourlyCost`, `maxDailyCost`, `maxMonthlyCost` (`hour`, `day`, `month` of each scope)
- [x] `maxEstimatedCostPerRequest` (models on which a request could cost more are not used)
- [x] `maxTokensPerRequest` (input estimate + output; `max_tokens` lowered to fit)
- [x] `maxConcurrentRequests` per key and per user (the gateway-wide one already existed)
- [x] `maxStreamingDuration` (`maxStreamSeconds`, shared with SEC-006)
- [ ] Limits for one particular key (the per-key values apply to every key; a key's own request-rate limit exists)

Found while building it and fixed: a stream that ended early (client cancelled,
provider broke) recorded **no usage**, so cancelling a stream after reading the
answer bypassed token limits, quotas and spending. It is now charged its
estimated usage.

Tests: `packages/api/test/cost-limits-api.test.ts` (verified to fail with the
check disabled), `packages/gateway/test/request-limits.test.ts`.

### SEC-006 Request resource limits ✅

Built 2026-11-20; see [request limits](rate-limits.md#request-limits-sec-006).
Every refusal is a 400 with `error.code: "request_limit"` and `error.limit`.

- [x] `maxRequestBytes` (configurable; the body is refused while it streams in)
- [x] `maxJSONDepth` (`maxJsonDepth`, counted on the text before parsing)
- [x] `maxMessages`, `maxContentParts`
- [x] `maxToolDefinitions`, `maxToolSchemaBytes`
- [x] `maxImages`, `maxImageBytes`, `maxImageDimensions` (`maxImageDimension`, read from the image header; unreadable headers refused)
- [x] `maxInputTokens` (estimated), `maxOutputTokens` (lowers or sets `max_tokens`)
- [x] `maxStreamDuration` (`maxStreamSeconds`, default one hour)

Tests: `packages/api/test/request-limits-api.test.ts` (Chat Completions,
Responses, Messages, embeddings; verified to fail with the checks disabled).
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

Built 2026-11-20.

### SEC-009 Request-data minimization ✅

The `requestLogging` setting (Settings → Data retention → Request data;
`CLAWROUTER_REQUEST_LOGGING`). See [request logging modes](requests-usage.md#request-logging-modes-sec-009).

- [x] NONE / METADATA / FULL, METADATA by default (read when each request begins)
- [x] Metadata: request id, timestamp, API key and user, model, provider, HTTP status, latency, token counts, cost
- [x] FULL also stores the prompt, the response, tool calls and attachment metadata (`request_content`, migration 0028; at most 1 MB per request, secret-shaped text scrubbed, attachment data never kept)
- [x] FULL displays a clear privacy warning (Settings, when chosen; the request dialog, before the content is loaded; a server log warning at startup)

Decisions made here (keep unless the owner says otherwise): NONE still writes the hourly
**usage records** (quotas, cost limits and Usage need them; they hold no per-request data);
FULL content is readable only with the new **`requests.content`** permission (Administrators;
not Operators or Viewers, even though they read request history) and never through MCP; it is
deleted with its request by the request history retention, not when switching back.
Tests: `packages/api/test/request-logging-api.test.ts` (7 of 10 fail with the mode ignored).

### SEC-010 Secret scrubbing test suite ✅

`tests/security/logging/secret-scrubbing.test.ts` (143 tests; 91 failed on the previous
redaction). See [redaction](logging-audit.md#redaction).

- [x] API keys, bearer tokens, cookies, passwords, provider credentials, SMTP credentials, session ids, setup tokens, OAuth tokens, private keys, JWTs, MCP credentials
- [x] Embedded in JSON, nested JSON, arrays, URLs, query parameters, headers, exceptions, stack traces, tool arguments, provider errors

Found and fixed (`packages/core/src/redact.ts`): JWTs, PEM private keys, OAuth tokens,
passwords in URLs, signed-URL signatures, `Cookie:`/`x-api-key:` headers in text, SMTP
`AUTH PLAIN` lines, secret-named fields inside JSON text (and JSON inside a JSON string, as
tool arguments are), and the field names `session…`, `csrf`, `auth`, `jwt`, `pass` all
went through unredacted. In the other direction, `inputTokens`, `max_tokens`,
`sessionIdleMinutes` and `secureCookies` were redacted although they are not secrets (audit
records of settings changes showed `[REDACTED]`).

### SEC-011 Backup credential separation ✅

See [backups](deployment.md#backups).

- [x] Normal backup: the database, which holds the configuration and the operational data (credentials only encrypted)
- [x] Credential backup: the same plus the encryption secret key
- [x] Explicit confirmation before including the secret key (typed, or `--yes` without a terminal; `confirmSecretKey` in code)
- [x] Warning that credential backups are sensitive (before and after)
- [x] Never in normal backup listings (`credentials/` subdirectory; `--list --credentials`); never pruned
- [x] Restrictive permissions (0700 directories, re-applied when wider; 0600 files); doctor warns otherwise

Tests: `tests/security/backup/credential-backups.test.ts`, the SEC-011 doctor case in
`apps/server/test/recovery.test.ts`.

## Phase 4: Security testing

### SEC-012 Security regression suite ✅

`tests/security/`, one folder per category (see its [README](../tests/security/README.md));
`bun run test:security` runs it alone, `bun test` and CI run it with everything else.
`suite.test.ts` fails when a category has no tests or a test sits outside a category.

- [x] authentication/ (no username enumeration, lockout across addresses, disabled accounts, setup-token replay, passwords never stored or logged)
- [x] authorization/ (the SEC-014 matrix)
- [x] sessions/ (cookie attributes, fixation, replay after sign-out, idle and absolute expiry, revocation by the user, a password change and an administrator)
- [x] csrf/ (cross-site, `null`, look-alike and other-port origins, `Sec-Fetch-Site`, the CSRF header, form encodings, no CORS preflights)
- [x] api-keys/ (shown once, hashed, the prefix alone is useless; near-miss, revoked, expired and suspended keys; never a console credential; never in the URL)
- [x] rate-limits/ (key guessing per address, one limit whatever header carries the key, `X-Forwarded-For` spoofing, sign-in throttling across addresses)
- [x] mcp/ (moved from phase 1), ssrf/ (37 hostile URLs, rebinding, redirects, allowlisted metadata), backup/ and restore/ (moved), logging/ (moved), configuration/ (moved)
- [x] websocket/ (SEC-015), provider/ (keys write-only and not sent to a new host; provider error text, auth failures and garbage not passed on)

No vulnerabilities were found while writing these; every test passed against the existing code
except where SEC-015 changed the behaviour.
- **SEC-013** ⬜ Credential stuffing, brute force, username enumeration, session
  fixation and replay, expired and revoked sessions, disabled accounts,
  concurrent sessions, setup-token replay and brute force, password-reset abuse,
  two-factor bypass, recovery-code replay.
### SEC-014 Authorization matrix testing ✅

The matrix is `tests/security/authorization/matrix.json` (machine-readable) and
[security/authorization-matrix.md](security/authorization-matrix.md) (readable): 127 routes ×
anonymous, API key, API key with MCP access, Administrator, Operator, Viewer and signed in
without a role. Both are generated from the router and the built-in roles by
`bun run security:matrix`; committing them makes every change of who may call what a reviewed
diff.

- [x] Every route has an explicit policy (the router requires it; the test checks each is known, and pins the list of 9 public routes)
- [x] Every role is tested, plus a user without a role (`matrix.test.ts` calls all 127 routes as all 7 principals over HTTP: refused cells must be refused by the access check with the right status, 401 or 403; allowed cells must pass it)
- [x] Anonymous access is tested
- [x] API-key access is tested (keys never reach `/api`, sessions never reach `/v1`, MCP only with MCP access, and `/v1/mcp` is a 404 for everyone while MCP is off)
- [x] Regression tests run automatically (`bun test`, CI); the test fails when the committed matrix differs from the code

Custom roles are not in the matrix: they get exactly the permissions they are given (tested in
`packages/api/test/roles-api.test.ts`). The older sweep in
`packages/api/test/authorization-api.test.ts` stays.
### SEC-015 WebSocket security ✅

See [real-time](realtime.md#security). Tests: `tests/security/websocket/websocket.test.ts`
(a real Bun server, real frames and a raw TCP socket) and `packages/api/test/realtime.test.ts`.

Audit:

- [x] Authentication (a console session cookie only: API keys, forged and missing cookies are 401; the token is never sent back)
- [x] Session expiration (re-checked every 30 s **and now at every client message**, so an expired session is closed at its next ping)
- [x] Session revocation (sign-out, revocation, password change and a disabled user close the connection at once, 4401)
- [x] Origin validation (exact host match; another site, `null`, missing, look-alike and other-port origins are 403)
- [x] Message validation (**new**: the only client message is `{"type":"ping"}`; anything else closes with 1008, binary frames with 1003; before, unknown messages were ignored)
- [x] Message-size limits (Bun refuses frames over 4 KB, 1009; the hub closes text over 1 KB, now counted in bytes, not characters)
- [x] Connection limits (20 per user, 2,000 in total, 429), plus **new**: 20 messages per 10 s per connection (1008)
- [x] Idle timeout (Bun pings after 120 s; **new**: a connection silent for three console heartbeats, 75 s, is closed with 4410)
- [x] Reconnection storms (**new**: 30 upgrades per user per minute, then 429 with `Retry-After`; the console's backoff with jitter already spreads reconnects)
- [x] Subscription authorization (clients cannot subscribe to anything; every event is filtered by the receiving user's permissions, re-read on role changes)

Test:

- [x] Valid session
- [x] Expired session
- [x] Revoked session
- [x] Invalid session
- [x] Cross-origin request
- [x] Oversized message
- [x] Malformed frame (unmasked, reserved bits, unknown opcode: the connection ends without an answer)
- [x] Rapid reconnect

Checked in Chromium: the console stays live through a minute of pings with the stricter protocol.

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
