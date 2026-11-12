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
  install time. `vendor/enterprise-ui-react.tgz` is from ENTERPRISE-UI `main` at
  `5c01a20`. To update it, follow `vendor/README.md` (needs a local ENTERPRISE-UI
  checkout).

- **IMPORTANT** · 2026-11-12 · The secret key must be backed up with the database
  Provider API keys are encrypted with `CLAWROUTER_SECRET_KEY` (required in
  production) or, in development, `data/secret.key`. Losing it means every stored
  API key must be entered again. Mention this in backup/restore work (phase 17).

- **IMPORTANT** · 2026-11-12 · Decisions that go beyond the spec text (keep unless the owner says otherwise)
  - The Viewer role has no `logs.read` or `audit.read` (they expose IPs and failed
    sign-ins). API keys are administrator-only.
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
  - The live channel sends `health.changed` to every signed-in user (the header
    shows system health to all); everything else is filtered by permission.

### Warnings

- **WARNING** · 2026-11-12 · Provider adapters never tested against the real APIs
  OpenAI, Anthropic, Google and OpenAI-compatible adapters were only tested
  against `tests/support/mock-providers.ts`. No real provider was reachable from
  the development environment. Expect small fixes the first time real keys are
  used: request fields, streaming events, model list paging (Anthropic lists at
  most 100).

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
  - Request history stores metadata only; there is no payload storage at all, so
    there is nothing to configure for payload retention (spec §22). Keep it that
    way unless the owner asks for opt-in payload logging.
  - `/v1/responses`, tools, images and `n > 1` are rejected with 400 (see
    `docs/gateway.md`). Agent clients that need tools will not work yet.
  - No CORS on `/v1`; browser apps must call it from their backend.
  - Live events are in-process: with several ClawRouter nodes, consoles would only
    see events from the node they are connected to (needs a shared channel, e.g.
    Redis pub/sub). A reverse proxy must pass WebSocket upgrades on `/api/ws` and
    keep the `Host` header (the origin check uses it).

- **WARNING** · 2026-11-12 · Behind a reverse proxy, per-IP limits are shared
  Client IPs come from the socket. Behind a proxy, every client has the proxy's
  IP, so the per-IP sign-in limit (50 per 15 minutes) and the gateway's
  invalid-API-key limit (default 20 per minute, then every `/v1` request from that
  address is refused) apply to all clients together: one misconfigured client
  could block everyone. Trusted `X-Forwarded-For` handling is planned for phase 17.

- **WARNING** · 2026-11-12 · No way to recover a lost administrator password
  There is no user management yet (phase 14), so there is no reset. The intended
  approach is a server-side CLI, never a web reset.

- **WARNING** · 2026-11-12 · CI not yet observed
  `.github/workflows/ci.yml` (frozen install, typecheck, tests, build) was added
  with the move but has not been seen running on GitHub. Check the first run.

### Notes

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
  - The session worker can restart mid-task. Commit and push in steps, so work is
    never lost.

### Messages

- **MESSAGE** · 2026-11-12 · Phase 11 waits for review; then phase 12
  Phase 10 was merged on the owner's word ("Merge 10"): `main` = `5605557`. Phase 11
  (real-time system) is on `claude/phase-11-realtime`, built on top of it, so
  merging is a fast-forward. Merge only when the owner says so.
  Next: phase 12, health + operations: gateway and WebSocket health checks
  (`RealtimeHub.size`, gateway error rate), health history (stored checks, like the
  provider check history), and long-running operations (connection tests and model
  discovery as cancellable operations with status in the UI, progress over the live
  channel as `operation.progress`).

---

## Resolved

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
