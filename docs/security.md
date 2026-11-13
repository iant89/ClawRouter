# Security

Phase 15 reviewed ClawRouter before real-world deployment (spec §37). This page
is the **review report**: what was checked, what was found and fixed, what is
guarded by tests, and the risks that remain. Area details live in
[authentication](authentication.md), [authorization](authorization.md),
[administration](administration.md), [gateway](gateway.md),
[rate limits](rate-limits.md) and [logging and audit](logging-audit.md).

## Findings fixed in phase 15

| # | Area | Finding | Fix |
|---|---|---|---|
| 1 | Input | Bodies were read in full before the size check. A chunked body (no `Content-Length`) could make the server buffer up to Bun's 128 MB default per request. | Bodies are counted while streamed and refused past 64 KB (admin API) or 10 MB (`/v1`) (`packages/api/src/http/body.ts`). |
| 2 | Output | The console HTML and scripts were served by Bun's HTML route, which cannot set headers: no CSP, no anti-framing (clickjacking). | Production builds are served by ClawRouter with a strict CSP, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, Permissions-Policy, COOP/CORP and, on HTTPS, HSTS. API responses get a deny-all CSP (`security-headers.ts`, `console-assets.ts`). |
| 3 | Rate limits / audit | Behind a reverse proxy, every client had the proxy's address: one client could exhaust the per-address sign-in and invalid-key limits for everyone, and audit records showed the proxy. | `CLAWROUTER_TRUSTED_PROXIES`: `X-Forwarded-For` is read only from listed proxies, right to left, so a client can never choose its own address (`client-address.ts`). |
| 4 | API keys | A key kept working after the user who created it was disabled. | Such keys are **Suspended** (401) and work again if the user is re-enabled. |
| 5 | Credentials | Changing the encryption key meant re-entering every provider key. | `bun run rotate-secret-key` re-encrypts all stored credentials, all or nothing, safe to repeat, audited by key fingerprint. |
| 6 | Audit privacy | A failed sign-in stored whatever was typed as the username. A password typed into that field ended up in the audit log and a notification. | The typed name is recorded only if it is an existing account; otherwise `unknownUser: true`. |
| 7 | Secrets in git | No automated check. | `bun run scan-secrets` (tree, and `--history` for every commit) and `bun audit` run in CI. The tree and full history are clean; no known-vulnerable dependencies. |

## Review checklist

| Item | Result |
|---|---|
| **Authentication** | argon2id password hashing; the same message and similar timing for unknown users (dummy hash); per-username and per-address throttling (configurable); disabled users cannot sign in; setup needs a one-time token compared in constant time and closes after first use; temporary passwords must be changed before anything else; optional or required two-factor sign-in (authenticator app, email codes, recovery codes; see [two-factor](two-factor.md)). |
| **Sessions** | 256-bit random tokens; only SHA-256 hashes stored; a new token at every sign-in (no fixation); idle and absolute expiry; revocation on sign-out, disable, password change and reset; `HttpOnly`, `SameSite=Strict`, `Secure` + `__Host-` prefix on HTTPS; invalid cookies are cleared. |
| **Authorization** | Every route declares its access (a required argument). A sweep test calls every protected route anonymously (401), without the permission (403) and with it. No escalation through roles or user management (phase 14). Administrator is unique and fixed. |
| **API keys** | 256-bit secrets shown once; only SHA-256 stored; constant-time comparison; prefix lookup; expiry, revocation, suspension; per-key, per-user, per-model and global limits; per-address invalid-key blocking. |
| **Credential encryption** | AES-256-GCM with a random IV per value and the owner bound as authenticated data (a ciphertext moved to another row fails); the key lives outside the database; required in production; key fingerprints only in logs; rotation command. |
| **CSRF** | `SameSite=Strict` cookies; unsafe requests need a same-origin `Origin`/`Sec-Fetch-Site` and the `x-clawrouter-csrf` header; JSON-only bodies (a form cannot send them); no CORS on `/api`. The WebSocket checks `Origin`. |
| **Rate limits** | Reviewed with trusted proxies (finding 3). Counters are per process (residual risk). |
| **Input validation** | Every body is validated on the server; unknown fields are refused; bodies are size-capped while streamed; malformed or deeply nested JSON is a 400. A garbage sweep sends 12 hostile values to every route, raw and wrapped in every field name: never a 500. Search values are parameters, never SQL (LIKE wildcards escaped). |
| **Output validation** | Errors are normalized: 5xx answers carry a generic message and a request id; the cause is only in the server log. A user's shape (`UserSummary`) never includes the hash. The `/v1` API speaks the OpenAI error format. |
| **Secrets in logs** | Field-name redaction plus secret-shape scrubbing (phase 13). The canary sweep below proves it end to end. |
| **Dependencies** | 3 runtime packages (React, React DOM, ENTERPRISE-UI from a committed tarball) and 4 dev packages, all pinned exactly; `bun install --frozen-lockfile` in CI; `bun audit` clean. CI actions are pinned by commit. |

## Security tests

- **Canary sweep** (`packages/api/test/security.test.ts`). It plants a provider key, a ClawRouter API key, temporary and new passwords, a wrong password, a password typed as a username, a wrong API key, the setup token and a session token. It then uses the platform (users, password changes and resets, failed sign-ins, gateway calls with good and bad keys, settings, a provider test). Finally it searches every GET response and header, the log stream, the Logs buffer, the audit log, notifications, request history, settings, operations, providers and usage for any of them, and for password hashes. It was verified to fail when a leak is planted.
- **Hostile input:** the garbage sweep, `/v1` garbage (always the OpenAI format, never a 500), injection-shaped search values, and the CSRF matrix.
- **Sessions:** rotation at sign-in, no reuse after sign-out, forged cookies cleared, cookie attributes.
- **Failure paths:** a database failure is a generic `DATABASE_ERROR` with the cause logged under the request id; a failing provider never echoes its key; unknown routes and methods are 404/405.
- **HTTP hardening:** streamed body limits (admin and `/v1`), security headers on success and error responses, HSTS on HTTPS only.
- **Trusted proxies:** spoofed and malformed `X-Forwarded-For`, IPv4-mapped IPv6, configuration validation.
- Earlier phases: the authorization sweep, the owner's role rules and escalation tests, throttling, and redaction and scrubbing.

## Residual risks (accepted for now)

| Risk | Why accepted / what would fix it |
|---|---|
| **Username lockout** | 10 wrong passwords (configurable) block a username for 15 minutes, so someone who knows an administrator's username can keep them out. The per-address limit and the server-side recovery command reduce the impact; a softer per-username delay would remove it (two-factor sign-in does not, since the password step comes first). |
| **CSP allows inline styles** | The design system sets layout through `style` attributes. Scripts are strictly same-origin, so script injection is still blocked; inline styles only allow visual tampering. |
| **Per-process counters and settings** | Rate-limit counters, live events and the settings cache live in one process. Running several nodes needs a shared store (spec §41, Redis). |
| **Provider adapters untested against real APIs** | Only the mock providers were reachable; see the MEMORY warning. |
| **No payload logging, no CORS on `/v1`** | Deliberate: prompts and completions are never stored, and browser apps must call through their backend. |

## Operator checklist for a real deployment

1. Serve over **HTTPS** and set `CLAWROUTER_COOKIE_SECURE=true` (default in production). This also enables HSTS.
2. Set `CLAWROUTER_SECRET_KEY` (or `_FILE`) from `openssl rand -base64 32`, and back it up separately from the database.
3. Behind a reverse proxy, set `CLAWROUTER_TRUSTED_PROXIES` to the proxy's address only. Pass the `Host` header and WebSocket upgrades on `/api/ws`.
4. Keep `CLAWROUTER_HOST` on a private interface unless the proxy needs otherwise.
5. Rotate the secret key with `bun run rotate-secret-key` if it may have been exposed. Recover lost passwords with `bun run reset-password`.
6. Run `bun run scan-secrets` and `bun audit` before releases (CI does both).

## Screenshots

[`docs/screenshots/15-security`](screenshots/README.md#15--security).
