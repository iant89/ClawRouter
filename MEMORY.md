# MEMORY.md

Notes carried between sessions. **Read this at the start of every session**, and
update it before ending one. The format and rules are in
[`AGENTS.md`](AGENTS.md#memory-protocol). Newest entries first within each section.
Never store secrets here.

Labels: **IMPORTANT** must read · **WARNING** known problem or unverified ·
**NOTE** context · **MESSAGE** hand-off

---

## Open

### Important

- **IMPORTANT** · 2026-11-17 · Owner rule: client notices and announcements
  The owner asked to "inject messages into the stream to the client" (e.g. "ClawRouter health has
  degraded, you may experience temporary performance issues"), then chose: the
  `X-ClawRouter-Notices` header **on by default** (setting), the visible line at the start of
  replies **also on by default** (setting), **configurable default messages**, and the cleanup of
  notice lines from conversations sent back **on by default** (setting). Plus administrator
  **announcements** with a schedule (every request / once per user / daily / weekly), channel,
  start and a self-deleting expiry. Keep: never write reply text into tool requests or tool-call
  replies; the per-key `replyNotices` switch (migration 0024) for scripts; the exact line format
  (`⚠️|📢 ClawRouter: …` + blank line) because `stripNotices` depends on it; the health notice
  follows `healthProblemIn` (not the overall label, which counts unchecked providers: that sent a
  false alarm to every user in the first live check). A new chat endpoint (e.g. `/v1/messages`)
  must call `withoutNotices` and `noticesFor` like `runChat`. See `docs/notices.md`; tests in
  `packages/api/test/notices-api.test.ts`.
  Owner, 2026-11-17: an emoji picker ("+") beside the announcement message and a combo box for
  the announcement's icon. Icons come from `ANNOUNCEMENT_ICONS` (migration 0025): **only ever add
  to that list**, because the cleanup matches lines by those icons.

- **IMPORTANT** · 2026-11-17 · Owner rule: provider captures, for bug reports
  The owner asked for "a tool that captures the communication between a provider and a client if
  an error occurred or is being parsed incorrectly", exported to a file for a developer. Owner's
  choices: automatic on errors and unreadable replies **plus** a manual "next N requests"; the
  full exchange stored, **masking chosen at export**; kept **until deleted** (capped by the
  `capturesMaxCount` setting). Access was left open ("I don't know"): a new `captures.manage`
  permission, Administrators only by default. Off by default (`capturesEnabled`), like the MCP
  server, because this is the one place message text is stored (spec §22 otherwise holds).
  Keep: no credential ever in a capture (tap redacts headers, `?key=`, the provider key,
  secret-shaped strings); a new provider kind needs nothing extra (the tap wraps its fetch).
  See `docs/captures.md`; tests in `packages/api/test/captures-api.test.ts`.

- **IMPORTANT** · 2026-11-17 · Owner rule: theme selection, Light / Dark / System, on the account
  The owner asked for light/dark theme selection and chose **Light, Dark and System** (no
  high-contrast), **remembered on the user's account** (follows them to every device). Dark stays
  the default (spec §18). `users.theme` (migration 0022), session `theme` (compared in
  `sameSession`), `PUT /api/auth/theme`; user menu → Appearance. New console styling must use
  `--eui-*` tokens so both themes work; check new screens in light too. See "Theme" in
  `docs/console-shell.md`; tests in `packages/api/test/theme-api.test.ts`.

- **IMPORTANT** · 2026-11-16 · Owner rule: the MCP server stays, switchable, off by default
  After first rejecting it, the owner asked to keep ClawRouter's own MCP server (`/v1/mcp`, read-only
  tools for agents) "with the ability to enable/disable it", **off by default**. The switch is the
  `mcpEnabled` setting (Settings → API keys and quotas); while off, `/v1/mcp` is a 404 checked
  before any key (do not reveal it exists), and the console hides MCP controls (session
  `mcpServer`, compared in `sameSession`). On top of that, each key needs its own MCP access
  (migration 0021). Every tool only reads; none returns or creates a secret (no "create key" tool).
  Tools use the key owner's permissions, read on every call; calls go through the key's rate
  limits, not quotas. See `docs/mcp.md`; tests in `packages/api/test/mcp-api.test.ts`.

- **IMPORTANT** · 2026-11-16 · Owner rule: setup wizard and guided tour, always skippable
  "A setup wizard, then a simple tour that walks new users … It can be skipped of course."
  Owner's choices: the wizard covers a first request (provider, models, API key, test
  request) **plus** sign-in security (mail, two-factor policy); the tour is for **every new
  user, by role** (only pages they can open); the tour component lives in **ENTERPRISE-UI**
  (`Tour`, pull request 55). Keep: every wizard step and the whole wizard skippable, the tour
  skippable and replayable from the help menu, existing users and installations never shown
  either after an upgrade (migration 0020), a new console area must get a sentence in
  `features/onboarding/tour-steps.ts` (AREA_TEXT) or its group is left out of the tour.
  The session's onboarding field must stay in `sameSession` (`auth-state.ts`), or finishing
  the wizard does not reach the console. See `docs/onboarding.md`.

- **IMPORTANT** · 2026-11-15 · Owner rule: user quotas, rate-limit windows and token buckets
  The owner asked for "per user quotas, setup during user creation, as well as modifying
  the user", with how much usage is allowed and when it resets; rate limits per
  second/minute/hour; and a token bucket against spamming with how fast it refills and
  how much is added at each refill. A limit is now `{ window, requests, tokens, bucket }`;
  old `{ requestsPerMinute, tokensPerMinute }` limits are upgraded wherever they are read
  (`upgradeLimit` / `upgradeSettings` in `packages/rate-limits/src/config.ts`): keep that.
  Quotas (`packages/rate-limits/src/quotas.ts`, migration 0018) read usage from
  `usage_records`, so any new way of recording gateway usage must still write there.
  Owner, 2026-11-16: quotas can be turned off per user (`enabled` on the quota) or for
  everyone (`quotasEnabled` setting); both keep the quota and its usage.
  See `docs/rate-limits.md`; tests in `packages/api/test/windows-quotas-api.test.ts`.

- **IMPORTANT** · 2026-11-15 · Owner rule: field explanations go in an "i" tip, everywhere
  The owner approved the field help tip ("Perfect") and asked for it in the entire
  application. A field's longer explanation sits behind an "i" (`FieldHelp` in an
  Input's `endAdornment`; `WithFieldHelp` beside any other control); only what is
  needed to fill it in stays under it (range, format, empty = ..., warnings). New
  forms follow this: see "Field help" in `docs/console-shell.md`. The tip's look was
  chosen by the owner: Bootstrap-shaped, page colour behind the cards, accent-blue
  border (`--eui-color-primary`), shadow, arrow, centred on the field. Escape closes
  only the tip, not the dialog around it.

- **IMPORTANT** · 2026-11-13 · Owner rule: two-factor sign-in is configured by administrators
  "Should be configured in settings by administrator": allowed methods (authenticator
  app, email codes) and who must use it (off / administrators / everyone) are
  settings (`security.sign_in`), with the SMTP server (`mail.server`, password
  encrypted, write-only). Required but not set up: 403 `two_factor_setup_required`
  on everything but session, password, sign-out, `/api/auth/2fa*` and own email.
  Your own email changes only with your password (user administration refuses it).
  See `docs/two-factor.md`; tests in `packages/api/test/two-factor-api.test.ts`.

- **IMPORTANT** · 2026-11-13 · Owner rule: maximum key lifetime by creator
  "Maximum key length if a administrator creates it, can be infinite, any other role
  maximum should be a configuration value the administrator sets, default is 30
  days." Keys created by a holder of the Administrator role may never expire;
  everyone else's keys last at most the `keyMaxLifetimeDays` setting (30, 1–3650):
  own keys, API Access keys through custom roles, and keys from requests (the
  requester creates them, so their limit applies even when an Administrator
  approves). New keys only. Per-provider/model limits still apply on top.
  Owner, 2026-11-14: administrators may raise or lower the limit; when lowering,
  Settings lists the active keys that live beyond it, with their owners
  (`GET /api/api-keys/beyond-lifetime`, non-administrators' ACTIVE keys only).
  `creatorLimitHours` in `packages/gateway/src/api-keys.ts`; the session reports
  `keyLifetimeLimitHours`; tests in `packages/api/test/key-creator-limit-api.test.ts`.

- **IMPORTANT** · 2026-11-13 · Owner rule: maximum key lifetime per provider and model
  "Administrators when adding providers/models should have the option to choose
  maximum key length", meaning **lifetime** (owner confirmed 2026-11-13). Optional
  `maxKeyLifetimeHours` on providers and models; a model's effective limit is the
  stricter of the two. Enforced twice: at key creation for keys naming specific
  models (aliases through their targets; "never" refused), and at use, where a key
  older than a model's limit cannot reach it (routing `exclude` hook, 403
  `key_too_old`). "Any model" keys are only limited at use. See
  `docs/self-service-keys.md` and `packages/api/test/key-lifetime-api.test.ts`.

- **IMPORTANT** · 2026-11-13 · Owner rule: self-service API keys and key requests
  Creating your own keys is a permission (`api_keys.own`). Keys can expire daily
  ("end of today", user's time zone) or after a length of time. Users without the
  permission can **request** a key; everyone who can create keys (`api_keys.write`)
  and does **not share a role** with the requester is notified, and only they may
  approve or deny it (owner confirmed 2026-11-13). Operators have `api_keys.own`
  (owner confirmed). Implemented in
  `packages/gateway/src/key-requests.ts` and `expiry.ts`; tests in
  `packages/api/test/key-requests-api.test.ts`. Design choices made here:
  approvers never see the secret (the requester creates the key after approval,
  owned by them); approvers may narrow models/expiry; requests resolve their
  expiry when the key is created; max 5 pending requests per user; self-service
  keys cannot set their own rate limit.

- **IMPORTANT** · 2026-11-13 · Owner rule: custom roles; Administrator is unique and fixed
  The owner asked for roles to be creatable with a chosen set of permissions.
  The built-in Operator and Viewer stay as default roles. **Administrator can never
  be removed, edited or replaced, and no other role may have every permission
  enabled.** Keep this when touching roles. Implemented in phase 14
  (`AuthorizationService.validateRole`, built-in roles refused for edit/delete);
  `packages/api/test/roles-api.test.ts` guards it. See `docs/administration.md`.

- **IMPORTANT** · 2026-11-12 · Workflow: one branch per phase, merged when the owner says so
  Build each phase on a branch (`claude/phase-N-<name>`), push it, and report.
  The owner reviews and says "merge it". Then fast-forward `main` to the branch
  and push. No pull requests unless the owner asks for one. (Phase 7 was merged
  this way.)

- **IMPORTANT** · 2026-11-12 · Project renamed from ClawAPI to ClawRouter
  Moved out of `iant89/ENTERPRISE-UI` (it lived in `clawapi/` there) with full
  history, then renamed everywhere: `@clawrouter/*` packages, `CLAWROUTER_*`
  environment variables, `clawrouter_session` cookie, `x-clawrouter-csrf` header. No
  compatibility aliases exist (nothing was deployed). Commits before the rename
  say "ClawAPI".

- **IMPORTANT** · 2026-11-12 · ENTERPRISE-UI comes from a committed tarball; do not clone it
  The owner asked for the tarball to be committed rather than cloned or built at
  install time. `vendor/enterprise-ui-react.tgz` is from ENTERPRISE-UI `main` at `ac70db0` (with
  QrCode, pull request 54, and Tour and the small-screen Wizard, pull request 55). Since 2026-11-17 it
  is from ENTERPRISE-UI `main` at `ff372b4` (pull request 57:
  FieldHelp, EmojiPicker, StatusHistory, ErrorBoundary and CopyButton `iconOnly`, moved from ClawRouter).
  To update it, follow
  `vendor/README.md` (needs a local ENTERPRISE-UI checkout); run `bun install --force`, because the
  package version stays 0.1.0 and a plain install keeps the cached copy.

- **IMPORTANT** · 2026-11-12 · The secret key must be backed up with the database
  Provider API keys are encrypted with `CLAWROUTER_SECRET_KEY` (required in
  production) or, in development, `data/secret.key`. Losing it means every stored
  API key must be entered again. Mention this in backup/restore work (phase 17).

- **IMPORTANT** · 2026-11-12 · Decisions that go beyond the spec text (keep unless the owner says otherwise)
  - The Viewer role has no `logs.read` or `audit.read` (they expose IPs and failed
    sign-ins). Managing everyone's API keys is administrator-only
    (`api_keys.write`); own keys need `api_keys.own` (see the owner rule above).
  - Changing a provider's endpoint to a different host requires re-entering its API
    key, so a stored key is never sent to a new host.
  - The first setup requires a one-time setup token (written to `data/setup-token`).
  - Error toasts that duplicate information shown elsewhere on the page get a
    10-second duration, because persistent toasts covered dialog buttons.
  - Rate limits (phase 9): a **Rate Limits** item under Gateway (spec §17 lists only
    Requests, API Access, Usage); Operators may change limits (`rate_limits.write`),
    Viewers may read them; default 120 requests/min per key and 100 concurrent
    requests; an address over the invalid-key limit is refused even with a valid
    key until the window passes; a rate-limited model is skipped (fail over) rather
    than refusing the request.
  - Client IP addresses are shown only to users with `audit.read` (Administrators,
    Operators): the rate-limit usage view masks them as "(hidden)" for Viewers, and
    the live channel never forwards events that carry IPs.
  - Phase 12: an **Operations** item under System (spec §17 lists Health, Logs,
    Audit); operations routes are `authenticated` and the operation service checks
    the permission of each type (view: the subject's read permission; run:
    `providers.write` for provider work, `health.read` for health checks, so Viewers
    may run health checks). `/api/health` stays public but returns details and
    latencies only to users with `health.read`.
  - Phase 13: the Logs page reads an **in-memory** buffer of recent records
    (`CLAWROUTER_LOG_BUFFER_SIZE`, lost on restart); stdout stays the log of record.
    Logs are not stored in SQLite. Request ids link Requests, Logs and Audit.
  - The live channel sends `health.changed` to every signed-in user (the header
    shows system health to all); everything else is filtered by permission.
  - Phase 14, no escalation: an actor may only create/edit/delete roles, assign or
    remove roles, and disable/rename/reset users when every permission involved is
    one they hold. Only administrators can assign Administrator or reset an
    administrator's password. New permission `roles.write` (Administrator only).
  - Phase 14, temporary passwords: new users and admin resets set
    `must_change_password`; until changed, the API allows only session, password
    change and logout (403 `password_change_required`), and the live channel refuses.
    No web "forgot password": `bun run reset-password <user>` on the server.
  - Phase 14, settings: environment variables are **defaults**; a value set in
    Administration → Settings wins until reset. Services read settings at use time
    (getter objects in `server.ts`), so no restart is needed. Stored as
    `system.<snake_case>` keys; out-of-range stored values are ignored. The password
    policy is not a setting.
  - Phase 15: an API key acts for its owner, so a disabled owner's keys are
    `SUSPENDED` (refused) until the owner is enabled again. Keys whose creator was
    deleted (none can be today) keep working.
  - Phase 15: production console files are served by `apps/server/src/console-assets.ts`
    (not Bun's HTML route) so they get the CSP and security headers; development
    still uses Bun's route for hot reload, without those headers.
  - Phase 15: a failed sign-in records the typed username only if it is an existing
    account (`unknownUser: true` otherwise), so mistyped passwords are never stored.
  - Phase 15: `X-Forwarded-For` is ignored unless `CLAWROUTER_TRUSTED_PROXIES` lists
    the connecting proxy; then the right-most untrusted hop is the client.

### Warnings

- **WARNING** · 2026-11-17 · Client notice limits
  The system-notice interval (once per key per 30 minutes) and the active-announcement cache
  (5 s) are in memory per process: with several nodes each repeats on its own schedule. A
  delivery is recorded when the response starts, even if the client disconnects. Users have no
  stored time zone, so daily/weekly use the announcement's own time zone. The "degraded" notice
  can only reach requests that are still answered: an OFFLINE provider is skipped by routing.

- **WARNING** · 2026-11-15 · Quota limits
  Quotas are charged when a request finishes, so parallel requests can together pass
  a quota (like token limits). Usage comes from hourly UTC records: in half-hour time
  zones a period counts from the start of that UTC hour, and usage older than the
  usage retention period is gone (keep it over a month for monthly quotas). Token
  buckets live in memory per process, like the counters.

- **WARNING** · 2026-11-14 · Phase 17 parts not verified
  The systemd unit (`deploy/clawrouter.service`) was never run (no systemd in the
  development container). Docker, Compose, nginx and Caddy were run and checked.
  `CLAWROUTER_REUSE_PORT` was checked by hand on Linux (two processes on one port,
  the second kept answering when the first stopped); no automated test, and not tried on macOS or Windows.
  Caddy's automatic certificates were not tried (no public host).

- **WARNING** · 2026-11-12 · Provider adapters never tested against the real APIs (Groq and Gemini via compat are)
  OpenAI, Anthropic and the **native** Google adapter were only tested against
  `tests/support/mock-providers.ts`. Expect small fixes the first time real keys are used:
  request fields, streaming events, model list paging (Anthropic lists at most 100). Groq was
  tested live on 2026-11-16, and Gemini through Google's OpenAI-compatible endpoint the same
  day (see Notes). The native Gemini adapter needs the key in the `x-goog-api-key` header,
  which the credential form cannot save: the owner adds it in the environment settings.

- **WARNING** · 2026-11-12 · ENTERPRISE-UI branch `claude/clawapi-design-spec-p0hucn` still exists
  The owner asked for it to be deleted after the move. The deletion was blocked by
  the session's safety check, so it is left for the owner (GitHub → ENTERPRISE-UI →
  Branches). Its tip is identical to ENTERPRISE-UI `main`, so deleting it loses
  nothing. Move this entry to Resolved once it is gone.

- **WARNING** · 2026-11-12 · Screenshots show the old name
  Folders 01–06 in `docs/screenshots/` were captured before the rename; the header
  says "ClawAPI". From 07 (routing) on they show ClawRouter. Retake older ones as
  phases revisit those screens.

- **WARNING** · 2026-11-12 · Gateway limits until later phases
  - Rate-limit counters are in memory, per process: they reset on restart, and
    several ClawRouter nodes would each enforce the limits separately. A shared
    `CounterStore` (e.g. Redis) is needed before running more than one node.
  - Token limits charge usage (reported, or estimated) after the response, so one large
    request can overshoot a token limit (documented in `docs/rate-limits.md`).
  - Gateway metrics on the dashboard are in memory and reset on restart; request
    history and usage are stored (phase 10) and survive restarts.
  - Request history stores metadata only (spec §22). The one exception, asked for by the
    owner on 2026-11-17, is provider captures: opt-in (off by default), only requests that
    went wrong or a manual capture, `captures.manage` only (see the owner rule).
  - `n > 1` is rejected with 400 (see `docs/gateway.md`). `/v1/responses` works but is
    stateless (no `previous_response_id`, no hosted tools). Tools
    work (2026-11-16); the deprecated `functions` / `function_call` are refused.
  - No CORS on `/v1`; browser apps must call it from their backend.
  - System settings (phase 14) are cached in memory per process: with several
    nodes, a change made through one node reaches the others only after their
    restart (needs a shared notification, like live events).
  - Live events are in-process: with several ClawRouter nodes, consoles would only
    see events from the node they are connected to (needs a shared channel, e.g.
    Redis pub/sub). A reverse proxy must pass WebSocket upgrades on `/api/ws` and
    keep the `Host` header (the origin check uses it).

- **WARNING** · 2026-11-13 · Accepted security risks (see `docs/security.md`)
  A known username can be locked out by repeated wrong passwords (15 min; two-factor
  sign-in does not help, the password step comes first); the console CSP allows
  inline styles (design system needs them; scripts are strict).

- **WARNING** · 2026-11-13 · Two-factor mail limits
  The SMTP client (`packages/mail/src/smtp.ts`) was only tested against
  `tests/support/mock-smtp.ts` without encryption: TLS and STARTTLS have not met a
  real mail server. See `docs/two-factor.md`. (The missing QR code was added on
  2026-11-15: ENTERPRISE-UI's `QrCode`, drawn in the browser.)

- **WARNING** · 2026-11-14 · Performance limits left in place (phase 16)
  - Usage charts over a whole year take ~220 ms at 290k hourly rows (shorter ranges
    are milliseconds); daily roll-ups would fix it if needed.
  - ENTERPRISE-UI's icon collection imports all 1,410 icons statically (~0.47 MB,
    93 KB brotli), loaded with the first page; per-icon loading needs ENTERPRISE-UI.
  - The routing snapshot is per process: with several nodes, a change made on one
    reaches the others within 5 seconds.

### Notes

- **NOTE** · 2026-11-17 · ENTERPRISE-UI: new example folders missing in the docs tests
  The docs registry test ("provides examples for registered pages") failed for freshly added
  `examples/<slug>/` folders because vitest's module cache (`node_modules/.vitest-cache`) kept an
  old `import.meta.glob` result. Moving that folder aside fixed it; CI starts clean and is not affected.

- **NOTE** · 2026-11-16 · Live Gemini testing (OpenAI-compatible endpoint)
  The owner saved a Gemini API key as a **network secret for generativelanguage.googleapis.com,
  sent as `Authorization: Bearer`**. That works only for Google's OpenAI-compatible endpoint
  (`/v1beta/openai`): configure an `openai_compatible` provider there with any placeholder
  key. The native API answers 401 to it. Live 2026-11-16 on gemini-3.5-flash and
  gemini-3.5-flash-lite (both pass everything, streamed tool calls included): discovery (64
  models), chat, stream, an inline image, tools with the round trip, `/v1/responses`,
  embeddings (gemini-embedding-001). Found and fixed: thought signatures dropped (tool
  results refused by Gemini 3), `models/` ids, `display_name`, Google's error lists, stream
  finish "stop" for tool calls, retired-model errors hidden. gemini-2.5-flash is retired for new
  users and gemini-3.8-flash did not answer in 110 s that day; gemini-3.5-flash works. Streams
  get no usage from this endpoint (ClawRouter does not send `stream_options` to compatible
  servers), so streamed usage is estimated.

- **NOTE** · 2026-11-16 · Responses API and the chat pipeline
  Chat completions and `/v1/responses` share `runChat()` in
  `packages/gateway/src/service.ts`; only the parser and the `ChatFormatter`
  (`formats.ts`, `responses.ts`) differ. A change to routing, failover, limits or
  recording belongs in `runChat`, once. The Responses parser builds a Chat Completions
  body and validates it with `parseChatRequest`; `renamed()` maps error params back to
  Responses names (`messages[i]` -> `input[j]` through a source map). Stateless by
  design (no payload storage): if the owner ever wants `previous_response_id`, it needs
  opt-in storage of conversations, which the spec §22 decision currently rules out.

- **NOTE** · 2026-11-16 · Tools and function calling
  Normalized types in `packages/providers/src/types.ts`: `ChatRequest.tools`,
  `toolChoice`, `parallelToolCalls`; assistant `toolCalls`, role `tool` with
  `toolCallId`; `ChatResponse.toolCalls`; stream event `tool_call` (index; id and name
  on the first piece; argument pieces after). Every adapter translates them (OpenAI pass
  through; Anthropic tool_use/tool_result; Gemini functionCall/functionResponse). A new
  provider kind must do the same, or tool requests fail at the provider. Gemini's thought
  signature is carried in the tool call id (`call_<hex>~<signature>`, `signatureOf` in
  `google.ts`): do not shorten or rewrite tool call ids anywhere. Routing requires
  TOOL_USE for tool requests (`plan()` in `packages/gateway/src/service.ts`). The mock
  providers answer with a tool call when tools are offered and no tool result exists yet.

- **NOTE** · 2026-11-16 · Media forwarding and automatic pricing
  Messages may carry `parts` (`packages/providers/src/types.ts`); `content` is always
  the joined text, so code that only needs text keeps working. Each adapter declares
  `inputMedia` and translates parts (OpenAI parts, Anthropic blocks, Gemini inlineData);
  the gateway's routing `exclude` hook drops providers that cannot take a request's
  media, and images require VISION. A new provider kind must declare `inputMedia` and
  translate parts, or media requests skip it. Prices: `models.cost_source` (migration
  0019) is PROVIDER or MANUAL; `applyModelList` updates PROVIDER prices from each
  model list and never touches MANUAL ones (`priceChange` in
  `packages/models/src/service.ts` decides what an update does). Live 2026-11-16: a red
  and a blue inline image were named correctly by Groq's Qwen; import priced both
  models from Groq's list.

- **NOTE** · 2026-11-16 · Live Groq testing
  The owner saved a Groq API key as a **network secret for api.groq.com** on this
  cloud environment (not in the repository, not an environment variable). The session
  proxy injects it into requests to that host: give a ClawRouter Groq provider any
  placeholder key and it reaches the real API. Live results 2026-11-16: discovery (11
  models), plain and streamed chat on gpt-oss-20b and qwen3.8-27b, usage from
  `x_groq.usage`, cost from Groq's prices, `finish_reason: length`, stream usage
  when the client asks. Found live and fixed: speech models offered as chat,
  names/prices/vision ignored, and model ids with a slash (`openai/gpt-oss-20b`) read
  as provider/model. The fake Groq in the mock mirrors the real list's shape.

- **NOTE** · 2026-11-14 · Phase 17 mechanisms to keep in mind
  - Every encrypted value belongs to a `SealedSecretStore` (`apps/server/src/secret-stores.ts`):
    provider credentials, mail password, TOTP secrets. A **new kind of encrypted
    value must get a store there**, or key rotation, `doctor` and `clear-credentials`
    miss it. (Before phase 17, rotation re-encrypted only provider keys; fixed.)
  - Backups leave the secret key out unless `--include-secret-key`; the manifest
    records the key fingerprint, and restore refuses a backup the configured key cannot
    open (unless `--force`).
  - `deploy/nginx.conf` must use `Host $http_host`: `$host` drops a non-standard port
    and the console's same-origin check answers 403 "Cross-site request rejected".
  - Docker: the secret file must be owned by uid 1000 (the image's `bun` user).
    Image builds behind a TLS-inspecting proxy need `--secret id=ca,src=...`.
  - `CLAWROUTER_BACKUP_INTERVAL_HOURS` defaults to 24 in production: a production
    install writes backups into `<db dir>/backups` unless told otherwise.
  - The server writes `<db>.pid`; `restore` and `doctor` use it to see whether the
    server runs. Scratch servers in browser checks must be stopped by PID, or later
    starts on the same port fail with EADDRINUSE.
  - Configuration import is a merge (never deletes) and refuses permissions the
    importer lacks; a provider endpoint host change is skipped when it has a key.

- **NOTE** · 2026-11-14 · Phase 16 mechanisms to keep in mind
  - Routing plans use a cached snapshot (`packages/routing/src/service.ts`), dropped
    on `model.*`, `provider.*` and `routing.changed` events and after 5 s. A new way
    of changing models or providers must emit one of those events (or accept up to
    5 s of staleness). The console's routing view (`get`) always reads fresh.
  - Audit free text uses the trigram table `audit_fts` (migration 0017, triggers on
    insert and delete). If audit rows are ever updated in place, add an update
    trigger. It costs ~70% of the audit table's size.
  - `GET /api/api-keys` is paged (50 by default, 200 max). Anything needing every
    key must page or use the service's `list()`.
  - Benchmarks: `bun run bench:db`, `bun run bench:gateway` (`docs/performance.md`).
    The gateway benchmark clears the harness's log array and the mock's call list,
    which grow by design; do not mistake them for leaks.
  - The build uses `--splitting`: pages are separate files. Unknown `.js`/`.css`
    paths answer 404 so a tab open across an upgrade shows "ClawRouter was updated".

- **NOTE** · 2026-11-12 · Things that are easy to trip over
  - Production bundles must run with `dist/` as the working directory (Bun resolves
    bundled console assets relative to it); `bun run start` handles this.
  - Model ordering is provider priority, then provider name, then model name.
    Tests that compare lists depend on it.
  - Audit records created in the same millisecond (the fake clock does not advance
    by itself) have no guaranteed order; filter by `resourceId` in tests.
  - Inline Python in shell commands has been rejected by the session's command
    safety check; edit files with the editor tools instead.
  - The repository has no LICENSE file yet; ask the owner before adding one.
  - Routing weights are random draws: with weights 3:1 the heavier target is first
    about 75% of the time, not always. Tests inject `seededRandom(...)` (the
    harness uses seed 42), so they are reproducible; production uses `Math.random`.
  - The alias dialog offers the first 200 models (by provider priority). A
    searchable model picker is needed for very large registries.
  - Mock-provider streams: `controller.error()` right after `enqueue()` drops the
    queued chunk in Bun, so `streamBreak` sleeps 30 ms first. Keep that if you
    touch `tests/support/mock-providers.ts`.
  - In Playwright, ENTERPRISE-UI's `MultiSelect` opened with ArrowDown, not with a
    click on the input (see the API Access create dialog). Worth checking by hand.
  - GitHub says the repository moved to `iant89/ClawRouter`; pushes to the
    lower-case `origin` URL still work through the redirect.
  - ENTERPRISE-UI charts (`LineChart`, `BarChart`) measure their width when they
    mount. Mounted while loading, they keep a narrow default width: mount them once
    the data is there (see `UsagePage.tsx`).
  - In `sed`, do not combine the `|` delimiter with `\|` alternation; use `#` as the
    delimiter. Large heredocs in one command were once rejected by the command safety
    check (it could not parse them); write such files with the editor tools.
  - Attempt outcome `skipped_rate_limit` is our own model limit (no provider call);
    `rate_limited` is a provider's 429. Do not merge them.
  - Phase 10 test harness: advancing the fake clock past 60 minutes expires console
    sessions; sign in again (`h.login()`) after big clock jumps.
  - In browser checks, do not stop servers with `pkill -f "<pattern>"`: the pattern
    also matches the shell running the command and kills the tool session. Record
    the server PID (`echo $! > server.pid`, with `nohup bun main.js &` as its own
    line) and `kill` that.
  - Console pages subscribe with `useRealtimeEvent` / `useActivity`
    (`features/realtime/RealtimeContext.tsx`); both also fire after a reconnect, so
    a handler must refetch rather than apply a delta.
  - Bun's `toMatchObject` writes asymmetric matchers (`expect.any(String)`) into the
    received object: read values you need later before asserting on them.
  - Health-history screenshots (phase 12) use generated history (scratch script
    inserting rows into `health_history`); the screenshot index says so. Do the same
    when a picture needs time to pass, and say so.
  - The session worker can restart mid-task. Commit and push in steps, so work is
    never lost.
  - `bun run check 2>&1 | grep ... && git commit` commits even when the typecheck
    fails (grep succeeds on the error text). Check the exit status of `bun run check`
    itself before committing.
  - `git grep -E` / `git log -G` use POSIX regular expressions: `(?:...)` silently
    matches nothing. `scripts/scan-secrets.ts` converts its patterns; keep that.
  - The password policy refuses passwords containing the username. Browser-check
    scripts tripped on it twice (e.g. "sams-..." for sam); pick unrelated words.
  - `dist/` keeps old hashed bundles across builds; `rm -rf dist` before a build
    whose output you inspect.
  - GitHub pushes sometimes fail with 503 ("credential service temporarily
    unavailable"); retry with a short backoff and confirm with `git ls-remote`.

### Messages

- **MESSAGE** · 2026-11-17 · Everything merged after client notices and announcements
  Nothing in ClawRouter waits for review. Old branches to delete on GitHub (the session cannot): every merged
  `claude/*` branch (now including `claude/captures-live-groq`, `claude/client-notices`,
  `claude/announcement-emoji` and `claude/eui-shared-components`), the superseded `claude/mcp-server`
  and the stale `claude/groq-provider`; never merge those two (duplicate migration 0020 / older
  Groq code). Still open: an Anthropic-compatible `/v1/messages` (so Claude Code can use
  ClawRouter), the native Gemini adapter (key in `x-goog-api-key`, added by the owner in the
  environment settings), OpenAI and Anthropic live; multi-node shared state.

---

## Resolved

- **MESSAGE** · 2026-11-17 · Components moved to ENTERPRISE-UI wait for review. Resolved 2026-11-17:
  the owner said "Merge". ENTERPRISE-UI pull request 57 (FieldHelp / WithFieldHelp, EmojiPicker with
  `insertTextAtCursor`, StatusHistory, ErrorBoundary with `isChunkLoadError`, CopyButton `iconOnly`)
  was squash-merged as `ff372b4` once all four CI checks were green. The first run failed in e2e and
  phase3-browser: the ErrorBoundary docs example threw on load and the docs test fails on any console
  error; the example now starts working. ClawRouter re-vendored from that `main` (byte-identical) and
  `main` was fast-forwarded to `claude/eui-shared-components` (this commit). Docs examples in
  ENTERPRISE-UI must not log errors on load.

- **MESSAGE** · 2026-11-17 · ENTERPRISE-UI changes not yet in its `main`. Resolved 2026-11-17: the
  owner said "Open the ENTERPRISE-UI pull request then merge". Pull request 56 (all four CI checks
  green: check, consumer-package, e2e, phase3-browser) was squash-merged as `83e4097`; ClawRouter
  re-vendored from that `main` (the tarball was byte-identical) and `vendor/README.md` now names it.

- **MESSAGE** · 2026-11-17 · Announcement icons, emoji picker, client notices and the live Groq capture
  check wait for review. Resolved 2026-11-17: the owner said "Merge"; `main` was fast-forwarded to
  `claude/announcement-emoji` (this commit), which contains `claude/client-notices` and
  `claude/captures-live-groq`: migrations 0024 and 0025, the notices package, Settings → Client
  notices, Administration → Announcements, the Type box and emoji picker.

- **MESSAGE** · 2026-11-17 · Provider captures wait for review. Resolved 2026-11-17: the owner
  said "Merge"; `main` was fast-forwarded to `claude/provider-captures` (this commit): captures on
  errors, unreadable replies and manual runs, export with optional masking (migration 0023).

- **MESSAGE** · 2026-11-17 · Theme selection waits for review. Resolved 2026-11-17: the owner
  said "Merge"; `main` was fast-forwarded to `claude/theme-selection` (this commit): Light / Dark /
  System on the account (migration 0022), the header sun/moon toggle, and the ticking Uptime.

- **MESSAGE** · 2026-11-16 · The MCP server (with its switch) waits for review, after onboarding.
  Resolved 2026-11-16: on the owner's "Start merging", `main` was fast-forwarded to
  `claude/mcp-server-toggle` (after onboarding; this commit). Migration 0021 is the MCP access.

- **MESSAGE** · 2026-11-16 · Onboarding waits for review, after ENTERPRISE-UI pull request 55.
  Resolved 2026-11-16: the owner said "Start merging". ENTERPRISE-UI pull request 55 (all four
  CI checks green) was squash-merged as `ac70db0`; ClawRouter re-vendored from that `main` (the
  tarball was byte-identical), and `main` was fast-forwarded to `claude/onboarding` (this commit).

- **IMPORTANT** · 2026-11-16 · Do not merge `claude/mcp-server`. Resolved 2026-11-16: the owner
  first did not want the MCP server (it was built from a misread "Option 3"; lesson: when the
  owner's words could point to two lists, ask before building), then asked to keep it "with the
  ability to enable/disable it", off by default. It now lives on `claude/mcp-server-toggle`; the
  old branch is superseded. Deleting branches from the session is refused (HTTP 403), so the
  owner deletes old branches on GitHub (`claude/mcp-server`, the stale pre-rebase
  `claude/groq-provider` whose work is in `main` as `ec98b80`, and the merged ones).

- **WARNING** · 2026-11-12 · CI not yet observed. Resolved 2026-11-16: CI ran on every push
  to `main` (29 runs, about 30 s each, `bun audit` never failed). One failure (run 28) was a
  flaky test, "secret box > tampering is detected": it changed trailing base64 characters,
  which sometimes decode to the same bytes (about 1 in 250). It now flips real bytes. When a
  test tampers with encoded data, change the decoded bytes, not the text.

- **MESSAGE** · 2026-11-16 · Gemini live fixes wait for review. Resolved 2026-11-16: the owner
  said "Merge"; `main` was fast-forwarded to `claude/gemini-live-fixes` (this commit).

- **MESSAGE** · 2026-11-16 · Everything merged after the Responses API. Resolved 2026-11-16: the
  owner provided a Gemini key for live testing (see Messages).

- **MESSAGE** · 2026-11-16 · The Responses API waits for review. Resolved 2026-11-16: the
  owner said "Merge"; `main` was fast-forwarded to `claude/responses-api` (this commit).

- **MESSAGE** · 2026-11-16 · Everything merged after tools. Resolved 2026-11-16: the owner
  asked for `/v1/responses` next (see Messages).

- **MESSAGE** · 2026-11-16 · Tools and function calling wait for review. Resolved
  2026-11-16: the owner said "Merge"; `main` was fast-forwarded to `claude/tools` (this commit).

- **MESSAGE** · 2026-11-16 · Everything merged after media and pricing. Resolved
  2026-11-16: the owner asked for tools and function calling next (see Messages).

- **MESSAGE** · 2026-11-16 · Groq live fixes, media and automatic pricing wait for review.
  Resolved 2026-11-16: the owner said "Merge"; `main` was fast-forwarded to
  `claude/media-pricing` (which contains `claude/groq-live-fixes`), this commit.

- **MESSAGE** · 2026-11-16 · Groq provider and user quotas wait for review. Resolved
  2026-11-16: the owner asked for quotas to be turned off per user or entirely, then to
  merge both. `main` was fast-forwarded to `claude/quotas-rate-limits` (`9c605f5`), then
  to `claude/groq-provider` rebased onto it (this commit).

- **MESSAGE** · 2026-11-15 · Doctor repairs in the audit log. Resolved 2026-11-15: the
  owner asked to "add the doctor repair audit record, and then merge". `applyRepairs`
  records each repair, done or failed, as `DOCTOR_REPAIR` (actor "command line",
  resource `system`, resource id = the repair, metadata = repair and outcome); never
  when no database file exists. Merged into `main` (this commit).

- **MESSAGE** · 2026-11-15 · `doctor --fix` waits for review. Resolved 2026-11-15: the
  owner said "Merge"; `main` was fast-forwarded to `claude/doctor-fix` (this commit).
  How it works: checks carry an optional `repair`; `plannedRepairs`/`applyRepairs` in
  `apps/server/src/doctor.ts`; `--fix`, `--yes`, `--clear-unreadable`. A new check with
  a safe fix should add a `repair` and a case in `applyRepairs`.

- **MESSAGE** · 2026-11-15 · Authenticator QR code waits for review. Resolved 2026-11-15:
  ENTERPRISE-UI pull request 54 (`QrCode`) was merged by the owner; the owner said
  "Merge" and ClawRouter `main` was fast-forwarded to `claude/totp-qr-code` (this
  commit): QR code from ENTERPRISE-UI, setup key with a copy icon and a toast.

- **MESSAGE** · 2026-11-14 · Phase 17, settings tabs and field help wait for review.
  Resolved 2026-11-15: the owner said "Add it to the entire application, then start
  merging"; the field help was applied everywhere, then `main` was fast-forwarded in
  order to phase 17 (`47332ec`), the settings tabs (`45de251`) and the field help
  (this commit).

- **MESSAGE** · 2026-11-14 · Next: phase 17, production. Resolved 2026-11-14: built on
  `claude/phase-17-production` (see `docs/deployment.md`); the secret-key backup is
  covered there (backups leave the key out by default).

- **MESSAGE** · 2026-11-14 · Phase 16 and the revoke button wait for review. Resolved
  2026-11-14: the owner said "Merge"; `main` was fast-forwarded to phase 16
  (`f910f6d`), then to the revoke button (`a3ff3d8`).

- **MESSAGE** · 2026-11-13 · Next: phase 16; maximum key lifetime by creator waits for
  review. Resolved 2026-11-14: the owner said "Merge, then next phase"; `main` was
  fast-forwarded to `415ee7b` and phase 16 was built on `claude/phase-16-performance`.

- **MESSAGE** · 2026-11-13 · Phase 15, self-service keys and two-factor sign-in wait for
  review. Resolved 2026-11-13: the owner said "Start merging"; `main` was
  fast-forwarded in order to phase 15 (`b73407e`), self-service keys (`3ce0e53`)
  and two-factor sign-in (`e4b99cf`).

- **MESSAGE** · 2026-11-13 · Two-factor sign-in in progress. Resolved 2026-11-13: finished
  on `claude/two-factor-auth` (see the review hand-off under Messages).

- **WARNING** · 2026-11-13 · No two-factor authentication (accepted risk). Resolved
  2026-11-13: two-factor sign-in built (`docs/two-factor.md`).

- **MESSAGE** · 2026-11-13 · Open question: self-service API keys. Resolved 2026-11-13:
  the owner answered (see the owner rule under Important); built on
  `claude/api-key-self-service` (`docs/self-service-keys.md`).

- **MESSAGE** · 2026-11-13 · Phase 14 waits for review; then phase 15. Resolved 2026-11-13:
  phase 14 merged (`20e0915`); phase 15 built on `claude/phase-15-security-hardening`.

- **WARNING** · 2026-11-12 · Behind a reverse proxy, per-IP limits are shared. Resolved
  2026-11-13 (phase 15): `CLAWROUTER_TRUSTED_PROXIES` makes ClawRouter read
  `X-Forwarded-For` from listed proxies only (`packages/core/src/client-address.ts`).

- **MESSAGE** · 2026-11-13 · Phase 13 waits for review; then phase 14. Resolved 2026-11-13:
  phase 13 merged (`aad19fe`); phase 14 built on `claude/phase-14-administration`
  (see `docs/administration.md`). The owner asked for custom roles (see the owner
  rule under Important).

- **WARNING** · 2026-11-12 · No way to recover a lost administrator password. Resolved
  2026-11-13: `bun run reset-password <username> [--enable]` (server-side only)
  prints a temporary password that must be changed at the next sign-in.

- **MESSAGE** · 2026-11-13 · Phase 12 waits for review; then phase 13. Resolved 2026-11-13:
  phase 12 merged (`4d3a728`); phase 13 built on `claude/phase-13-logging-audit`
  (see `docs/logging-audit.md`). Phase 13 also fixed connection-test audit records
  losing the client address since phase 12.

- **MESSAGE** · 2026-11-12 · Phase 11 waits for review; then phase 12. Resolved 2026-11-13:
  phase 11 merged (`7a79eed`); phase 12 built on `claude/phase-12-health-operations`
  (see `docs/health-operations.md`).

- **MESSAGE** · 2026-11-12 · Phase 10 waits for review; then phase 11. Resolved 2026-11-12:
  phase 10 merged (`5605557`); phase 11 built on `claude/phase-11-realtime` (see
  `docs/realtime.md`).

- **MESSAGE** · 2026-11-12 · Phase 9 waits for review; then phase 10. Resolved 2026-11-12:
  phase 9 merged; phase 10 built on `claude/phase-10-requests-usage` (see
  `docs/requests-usage.md`).

- **MESSAGE** · 2026-11-12 · Phase 8 waits for review; then phase 9. Resolved 2026-11-12:
  phase 9 built on `claude/phase-9-rate-limiting` (see `docs/rate-limits.md`); the
  review hand-off is now the "Phase 9 waits for review" message. Phase 8 merged
  to `main` on 2026-11-12.

- **WARNING** · 2026-11-12 · No rate limits on `/v1`. Resolved 2026-11-12: phase 9
  added per-key, per-user, per-model, global and invalid-key-per-address limits.

- **MESSAGE** · 2026-11-12 · Next: phase 8, the request gateway. Resolved 2026-11-12:
  built on `claude/phase-8-gateway` (see `docs/gateway.md`).

- **WARNING** · 2026-11-12 · Routing plans are not executed yet. Resolved 2026-11-12:
  the phase 8 gateway executes plans and records every attempt in the `FailureTracker`.

- **MESSAGE** · 2026-11-12 · Next: phase 7, the routing engine. Resolved 2026-11-12:
  phase 7 built on `claude/phase-7-routing` (see `docs/routing.md`).
