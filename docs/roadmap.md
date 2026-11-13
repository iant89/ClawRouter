# Roadmap

The implementation roadmap from the [design specification](design-specification.md)
(§40–§44), with progress. Tick an item only when it is built **and** tested.
Partly built items in later phases are marked "(groundwork: …)".

**Legend:** ✅ done · 🟡 in progress · ⬜ not started

| Phase | Status |
|---|---|
| 0 Project bootstrap | ✅ |
| 1 Core backend | ✅ |
| 2 Authentication | ✅ |
| 3 Authorization | ✅ |
| 4 Application shell | ✅ |
| 5 Provider engine | ✅ |
| 6 Model registry | ✅ |
| 7 Routing engine | ✅ |
| 8 Request gateway | ✅ |
| 9 Rate limiting | ✅ |
| 10 Requests + usage | ✅ |
| 11 Real-time system | ✅ |
| 12 Health + operations | ✅ |
| 13 Logging + audit | ✅ |
| 14 Administration | ✅ |
| 15 Security hardening | ✅ |
| 16 Performance | ⬜ **next** |
| 17 Production | ⬜ |

---

## First working milestone (§44) ✅

- [x] Repository exists: `iant89/ClawRouter`. Started as `clawapi/` in ENTERPRISE-UI and moved with its history
- [x] Bun builds/runs: `bun run dev`, `bun run build`, `bun run start`
- [x] TypeScript strict mode: `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`, …)
- [x] React console runs: `apps/console`, served by the Bun server
- [x] ENTERPRISE-UI renders: from the committed tarball in `vendor/`
- [x] Bun API server runs: `apps/server`, `packages/api`
- [x] SQLite works: `packages/database` (`bun:sqlite`, WAL, foreign keys)
- [x] Migration system works: checksummed, transactional, ordered; `bun run migrate`
- [x] `/api/health` works: 503 when a critical component is offline
- [x] Basic test suite works: `bun test`
- [x] Development workflow documented: `README.md`

## Phase 0: Project bootstrap ✅

Goal: create the foundation.

- [x] Create repository
- [x] Configure Bun: workspaces, `bunfig.toml`
- [x] Configure TypeScript strict mode
- [x] Configure React: Bun HTML imports, no separate bundler
- [x] Install/configure ENTERPRISE-UI: `vendor/enterprise-ui-react.tgz`
- [x] Create monorepo/application structure: `apps/*`, `packages/*`
- [x] Create development scripts: `package.json` scripts
- [x] Create environment configuration: `packages/core/src/config.ts`, `.env.example`
- [x] Create basic logging: structured, redacting logger
- [x] Create error model: `AppError`, normalized error envelope
- [x] Create shared types: `packages/shared`
- [x] Create initial test infrastructure: `bun test`, `tests/support/harness.ts`
- [x] Create SQLite connection
- [x] Create migration system
- [x] Create `/api/health`

Exit: Bun starts ✅ · React console starts ✅ · ENTERPRISE-UI renders ✅ · SQLite connects ✅ · `/api/health` works ✅ · tests execute ✅

## Phase 1: Core backend ✅

Goal: build the basic server architecture.

- [x] Bun HTTP server: `apps/server/src/server.ts`
- [x] Request router: `packages/api/src/http/router.ts`
- [x] Middleware pipeline: request id, security headers, access log, error boundary, CSRF, sessions
- [x] Error handling
- [x] Configuration service
- [x] Logging service
- [x] Event bus: typed, `packages/core/src/events.ts`
- [x] Repository interfaces
- [x] SQLite repositories
- [x] Migration runner
- [x] API response conventions: `{ data, meta }` / `{ error }`

Exit: the server serves API endpoints ✅ · database persistence works ✅ · errors are normalized ✅ · domain services are independent of HTTP ✅

## Phase 2: Authentication ✅

Goal: secure the application. See [authentication](authentication.md).

- [x] USERS table: migration `0002_users_sessions`
- [x] Password hashing: argon2id via `Bun.password`
- [x] Session table: tokens stored as SHA-256 hashes
- [x] Login
- [x] Logout
- [x] Session lookup
- [x] Session expiration: idle (sliding) and absolute
- [x] Session revocation: own sessions, all other sessions, any session for administrators
- [x] Login throttling: per username and per IP, 429 + `Retry-After`
- [x] Failed-login audit
- [x] Initial setup wizard: `/setup` with a one-time setup token

Exit: users log in securely ✅ · users log out securely ✅ · sessions are server-side ✅ · no admin action without authentication ✅

## Phase 3: Authorization ✅

Goal: implement RBAC. See [authorization](authorization.md).

- [x] Roles: migration `0004_roles`
- [x] Permissions: 21 permissions in `packages/shared/src/authorization.ts`
- [x] User-role assignments: `PUT /api/users/:id/roles`, Users page
- [x] Authorization middleware: required `access` on every route
- [x] Permission service: `packages/authorization`
- [x] ADMIN
- [x] OPERATOR
- [x] VIEWER
- [x] Authorization tests: every protected route is called anonymously (401), without the permission (403) and with it

Exit: every protected endpoint enforces permissions server-side ✅

## Phase 4: Application shell ✅

Goal: create the real console. See [console shell](console-shell.md).

- [x] Application shell: `layouts/ConsoleLayout.tsx`
- [x] Sidebar
- [x] Header
- [x] Routing: `app/router.tsx`, deep links, return to the requested page after sign-in
- [x] Page layout
- [x] Responsive layout: drawer on phones, icons on tablets, ~44px touch targets
- [x] Notifications: `packages/notifications`, header bell, panel, toasts
- [x] User menu
- [x] Permission-aware navigation
- [x] Loading states
- [x] Error states: including `PageErrorBoundary`

Exit: authenticated users have a functional enterprise application shell ✅

## Phase 5: Provider engine ✅

Goal: create the provider abstraction. See [providers](providers.md).

- [x] Provider interface: `ProviderAdapter`
- [x] Provider repository: migration `0006_providers`
- [x] Provider configuration: endpoint policy, priority, timeout
- [x] Credential storage
- [x] Credential encryption: AES-256-GCM, key outside the database
- [x] Provider lifecycle
- [x] Connection testing
- [x] Health checks: background, 7-day history
- [x] Provider state
- [x] Provider event system
- [x] OpenAI provider
- [x] Anthropic provider
- [x] Google provider
- [x] Local/OpenAI-compatible provider

Exit: ClawRouter communicates with multiple AI providers through one standardized interface ✅ (tested against local mocks of each API; **not yet against the real providers**)

## Phase 6: Model registry ✅

Goal: create first-class model management. See [models](models.md).

- [x] Model repository: migration `0007_models`
- [x] Model CRUD
- [x] Provider/model relationship: `ref` = `<provider>/<model>`
- [x] Capability metadata
- [x] Availability state: separate from provider status; `usable` with a reason
- [x] Context length
- [x] Cost metadata
- [x] Model discovery where supported
- [x] Model administration UI

Exit: providers expose usable models to the rest of ClawRouter ✅ (`listUsable`, `resolveRef`)

## Phase 7: Routing engine ✅

Goal: implement provider/model selection. See [routing](routing.md).

- [x] Routing domain: pure engine `planRoute()` in `packages/routing` (no HTTP, database or clock)
- [x] Routing rules: one versioned configuration, migration `0008_routing`, `GET/PUT /api/routing`
- [x] Model aliases: targets with priority and weight; capability aliases without targets
- [x] Capability matching: alias and request capabilities combined
- [x] Provider priority: for model-id and capability routing
- [x] Provider weights: per-target weights within a priority level (weighted random, seedable)
- [x] Health-aware routing: healthy before unchecked before degraded within a priority level; failure history demotes
- [x] Disabled provider handling
- [x] Disabled model handling
- [x] Fallback rules: priority order plus failover policies (NONE / RETRY_SAME_PROVIDER / FAILOVER_PROVIDER / RETRY_AND_FAILOVER), capped at 10 attempts
- [x] Routing tests: engine and API, with a seeded random source

Exit: given a request, ClawRouter deterministically selects the best eligible provider/model ✅
(`POST /api/routing/preview`; reproducible with a seeded random source).

## Phase 8: Request gateway ✅

Goal: build the actual AI gateway. See [gateway](gateway.md).

- [x] Gateway request pipeline: `packages/gateway` (validate → allowed models → plan → execute → format)
- [x] External API authentication: API keys only on `/v1` (`Authorization: Bearer` or `x-api-key`); sessions never
- [x] API key management: hashed, shown once, allowed models, expiry, revocation, audited; **API Access** console page
- [x] Request validation: OpenAI-style errors naming the `param`; unsupported features rejected, not ignored
- [x] Request normalization: OpenAI request → normalized `ChatRequest` / `EmbeddingRequest`
- [x] Model resolution: alias, `provider/model` reference or model id (routing engine)
- [x] Routing integration: `RoutingService.plan()` per request
- [x] Provider execution: `ProviderService.chat` / `chatStream` / `embed`
- [x] Response normalization: OpenAI `chat.completion`, `chat.completion.chunk` and embedding lists
- [x] Error normalization: OpenAI error format on `/v1`; provider details stay in the server log
- [x] Timeout handling: per-provider timeouts; all attempts timing out gives 504
- [x] Retry handling: transient failures retried with backoff, as the policy allows
- [x] Failover handling: next model on failure; streams fail over only before the first token
- [x] Request cancellation: a client disconnect aborts the provider call
- [x] Streaming: SSE passthrough without buffering, `include_usage`, error event when a stream breaks
- [x] Request IDs: `x-request-id`, completion ids derived from it
- [x] Request metrics: in memory, `GET /api/gateway/metrics`, dashboard tiles (history: phase 10)
- [x] Usage accounting: provider-reported tokens in `request.completed` events (persistence: phase 10)

Initial external API:

- [x] `/v1/models`
- [x] `/v1/chat/completions`
- [x] `/v1/embeddings` (OpenAI, OpenAI-compatible, Google)
- [ ] `/v1/responses`: not supported by the normalized model yet; answers 400 pointing to chat completions

Exit: an external AI client can point directly at ClawRouter and make an AI request without knowing which provider handled it ✅
(tested with the mock providers and in the browser; real providers not yet tried).

## Phase 9: Rate limiting ✅

Goal: protect the gateway. See [rate limits](rate-limits.md).

- [x] Rate-limit abstraction: async `CounterStore` (sliding-window counters) with an in-memory implementation; a shared store can replace it. The console sign-in throttle stays separate (it blocks for 15 minutes rather than limiting a rate)
- [x] Per API-key limits: default for all keys, or a key's own limit (or none)
- [x] Per-user limits: all keys created by one user, combined
- [x] Per-model limits: a limited model is skipped and the next model tried; 429 only when all are limited
- [x] Global limits: requests and tokens per minute, requests at the same time
- [x] Rate-limit headers: `x-ratelimit-*` for the tightest limit; 429 with `Retry-After` in the OpenAI format
- [x] Rate-limit events: `ratelimit.exceeded`, `ratelimits.changed`; refusals on the dashboard
- [x] Administrative configuration: **Rate Limits** page with live usage, versioned and audited; per-key limits on **API Access**
- [x] Invalid API keys per address: blocked for the rest of the window after too many (phase 8 follow-up)

Exit: abusive or excessive clients cannot overwhelm the gateway ✅ (single node; counters reset on restart).

## Phase 10: Requests + usage ✅

Goal: make gateway activity observable. See [requests and usage](requests-usage.md).

- [x] Request persistence: every request with a valid API key, from arrival to end (migration `0011_requests`); metadata only, never content
- [x] Request status: `EXECUTING`, `STREAMING`, `COMPLETED`, `FAILED`, `TIMEOUT`, `CANCELLED`; interrupted requests recovered at startup
- [x] Request duration
- [x] Provider/model recording: requested model, answering model and provider
- [x] Retry count, with the attempt log (each try's model, outcome and duration)
- [x] Failover count
- [x] Usage records: hourly totals per key, model and provider, kept longer than request rows
- [x] Token accounting: provider-reported, or estimated locally and marked as such
- [x] Cost estimation: from model prices at the time; unknown (not zero) without prices
- [x] Request history UI: **Requests** page with server-side filters and paging, request detail
- [x] Usage dashboard: **Usage** page (totals, charts, breakdowns) and dashboard tiles
- [x] Retention: `CLAWROUTER_REQUEST_RETENTION_DAYS` (30), `CLAWROUTER_USAGE_RETENTION_DAYS` (400)

The spec's `RECEIVED`, `AUTHENTICATING` and `ROUTING` states are not stored: they
last microseconds and happen before the row is written or within the same step.

Exit: administrators can understand what the gateway is doing ✅

## Phase 11: Real-time system ✅

Goal: provide live operational state. See [real-time system](realtime.md).

- [x] Typed event bus
- [x] WebSocket server: `/api/ws`, with per-user and total connection limits, slow consumers closed
- [x] Session-authenticated WebSocket: session cookie and same-origin check on upgrade; sessions re-checked without counting as activity; closed with 4401 when they end
- [x] Provider events: status, changes, connection tests
- [x] Health events
- [x] Request events: coalesced into one activity message per second, with metrics for `requests.read`
- [x] Routing events (and model and rate-limit configuration events)
- [x] Notification events: id only, to recipients only
- [x] UI subscriptions: dashboard, health, notifications, rate limits, requests, providers, models and routing update on events; slow polling only as a fallback
- [x] Reconnection handling: backoff with jitter, heartbeat, resync after gaps, header indicator
- [x] Role changes apply to open connections; a revoked session leaves the console at once

Exit: the dashboard updates live without constant page refreshes ✅
(in the browser: no metrics polling while live; reconnect 0.5 s after a server restart; sign-out 0.1 s after revocation from another browser).

## Phase 12: Health + operations ✅

Goal: build operational visibility. See [health and operations](health-operations.md).

- [x] Platform health
- [x] Database health
- [x] Gateway health: failure rate of the last minute, usable models
- [x] Provider health
- [x] WebSocket health: the live channel and its connections
- [x] Health history: scheduled checks stored for 7 days; availability, timeline and changes per component
- [x] Operations: queued, running, succeeded, failed, timed out, cancelled; progress, result, retention, restart recovery
- [x] Connection tests: now run as operations (the Test button is unchanged)
- [x] Operation cancellation: queued and running, with audit
- [x] Operation status UI: **Operations** page with live progress; history on **Health**
- [x] `/api/health` keeps statuses public but withholds details from callers without `health.read`

Exit: administrators can determine exactly which part of the platform is healthy or failing ✅

## Phase 13: Logging + audit ✅

See [logging and audit](logging-audit.md).

Goal: provide operational and security traceability.

- [x] Structured logs
- [x] Log levels
- [x] Log filtering: in-memory buffer of recent redacted records, `GET /api/logs`, **Logs** page (level, component, provider, request id, user, text; follow)
- [x] Request correlation IDs
- [x] Audit repository
- [x] Audit UI: `GET /api/audit` with filters and paging, **Audit** page
- [x] Authentication auditing
- [x] Provider auditing
- [x] Routing auditing (`ROUTING_UPDATED` with a diff)
- [x] User auditing (setup, role changes)
- [x] API-key auditing (`API_KEY_CREATED`, `API_KEY_UPDATED`, `API_KEY_REVOKED`, since phases 8 and 9)
- [x] Secret redaction: by field name, and secret-shaped strings (API keys, bearer tokens) anywhere

Exit: important actions can be traced without exposing secrets ✅
(tested end to end: no password, key or token reaches the logs; request ids link logs, requests and audit).

## Phase 14: Administration ✅

Goal: complete the control plane.

See [administration](administration.md).

- [x] User management: create with a temporary password, rename, enable/disable, reset password, forced change at next sign-in, change own password, command-line recovery (`bun run reset-password`)
- [x] Role management: custom roles with chosen permissions; Administrator fixed and the only role with every permission; no escalation
- [x] Session management
- [x] API-key management (API Access page: create, revoke, allowed models, expiry, limits; phases 8 and 9)
- [x] Provider management
- [x] Model management
- [x] Routing management (Routing page)
- [x] System settings: retention of request history, usage records and health history
- [x] Security settings: session idle and maximum length, failed sign-ins before blocking

Exit: the entire platform can be administered through the console.

## Phase 15: Security hardening ✅

Goal: prepare for real-world deployment.

See [security](security.md): the review report, findings fixed, tests and residual risks.

- [x] Security review
- [x] Authentication review
- [x] Authorization review
- [x] Session security review
- [x] API-key security review
- [x] Credential encryption review
- [x] CSRF review
- [x] Rate-limit review
- [x] Input validation review
- [x] Output validation review
- [x] Secret scanning
- [x] Dependency audit
- [x] Security tests
- [x] Failure-path tests

Exit: no known critical security weaknesses remain in the initial architecture.

## Owner request: self-service API keys ✅

Asked by the owner on 2026-11-13, built after phase 15. See [self-service keys](self-service-keys.md).

- [x] `api_keys.own` permission: create, view and revoke your own keys
- [x] Key expiry: never, end of today (user's time zone), after a length of time, on a date
- [x] Key requests: notify key creators who share no role with the requester; approve (optionally narrowed) or deny with a reason; the requester creates the key and sees it once
- [x] Console: My API keys page; Key requests tab on API Access
- [x] Maximum key lifetime per provider and model: enforced when keys are created and when they are used

## Owner request: two-factor sign-in ✅

Asked by the owner on 2026-11-13 ("should be configured in settings by administrator"),
built after self-service keys. See [two-factor sign-in](two-factor.md).

- [x] Settings: allowed methods, who must use it (off / administrators / everyone), mail server (SMTP, write-only password, test message)
- [x] Authenticator app (TOTP, RFC 6238) with replay prevention
- [x] Email codes, with address confirmation
- [x] Recovery codes (one-time, hashed)
- [x] Two-step sign-in with expiring, attempt-limited challenges
- [x] Forced setup when required; administrator and command-line reset
- [x] Console: second sign-in step, Sign-in security, Settings, Users

## Owner request: maximum key lifetime by creator ✅

Asked by the owner on 2026-11-13. See [self-service keys](self-service-keys.md#maximum-key-lifetime-by-creator).

- [x] Administrators may create keys that never expire
- [x] Everyone else: at most the *Maximum key lifetime* setting (default 30 days), for own keys, API Access keys and keys from requests
- [x] Console: "Never" hidden and the length checked for users with a limit

## Phase 16: Performance ⬜ next

Goal: optimize the gateway and console.

- [ ] Database indexes (basic indexes exist on every table)
- [ ] Query profiling
- [ ] Request pipeline profiling
- [ ] Provider latency measurement (groundwork: recorded per check)
- [ ] Memory profiling
- [ ] WebSocket optimization
- [ ] UI rendering optimization (console bundle is ~0.9 MB: ENTERPRISE-UI icons load eagerly)
- [ ] Large-table virtualization
- [ ] Caching where appropriate
- [ ] Connection pooling where applicable

Exit: performance remains predictable under realistic gateway workloads.

## Phase 17: Production ⬜

Goal: package ClawRouter as a production-ready self-hosted application.

- [ ] Production configuration
- [ ] HTTPS deployment documentation
- [ ] Reverse-proxy support (trusted `X-Forwarded-For`: login throttling per IP needs it)
- [ ] Backup/restore (must include the secret key)
- [ ] Database backup
- [ ] Configuration export
- [ ] Configuration import
- [ ] Credential recovery strategy
- [x] Health endpoint
- [ ] Graceful shutdown (groundwork: SIGINT/SIGTERM handled)
- [ ] Graceful restart
- [ ] Migration handling (groundwork: migrations run on startup)
- [ ] Production logging (groundwork: JSON logs in production)
- [ ] Deployment documentation

Exit: ClawRouter can be deployed as a standalone production AI gateway.

---

## Future roadmap (§41)

- **Multi-server:** multiple installations, server registry, server health, server groups, remote management, version tracking, remote upgrades
- **Advanced routing:** latency-, cost- and token-aware routing, geographic routing, provider quotas, model quality policies, load balancing, circuit breakers
- **Advanced observability:** request analytics, provider and model performance, error, token and cost trends, availability percentages, latency percentiles
- **Advanced security:** fine-grained permissions, API scopes, key and secret rotation, external identity providers, SSO, MFA (two-factor sign-in done; passkeys not), IP restrictions
- **Infrastructure:** PostgreSQL, Redis, distributed rate limiting, distributed event system, multiple gateway nodes
- **AI features:** automatic model fallback, capability-based model selection, cost optimization, provider benchmarking, model health scoring, automatic routing optimization

## Implementation order (§42)

01 Bun + TypeScript foundation ✅ → 02 core backend ✅ → 03 SQLite + repositories ✅ →
04 authentication ✅ → 05 RBAC ✅ → 06 React + ENTERPRISE-UI shell ✅ → 07 provider
engine ✅ → 08 model registry ✅ → 09 routing engine ✅ → **10 request gateway** →
11 streaming / retry / failover → 12 API keys / rate limiting → 13 requests / usage →
14 WebSocket / events → 15 health / logs / audit → 16 administration → 17 security
hardening → 18 performance → 19 production packaging.

Each phase is a vertical slice (§43): database, domain, API, events, console page and
tests, so the application stays runnable throughout.
