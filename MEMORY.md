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

- **WARNING** · 2026-11-12 · Routing plans are not executed yet
  Phase 7 only plans routes. Nothing sends requests through a plan, and nothing
  records failures in `RoutingService.failures` (the `FailureTracker`) until the
  gateway exists (phase 8). The gateway must call `recordFailure` /
  `recordSuccess` per attempt, or failure demotion never takes effect.

- **WARNING** · 2026-11-12 · Behind a reverse proxy, login throttling is shared
  Client IPs come from the socket. Behind a proxy, every client has the proxy's
  IP, so the per-IP sign-in limit (50 per 15 minutes) applies to all users
  together. Trusted `X-Forwarded-For` handling is planned for phase 17.

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
  - The session worker can restart mid-task. Commit and push in steps, so work is
    never lost.

### Messages

- **MESSAGE** · 2026-11-12 · Next: phase 8, the request gateway
  Phases 0–7 are done (see `docs/roadmap.md`). Phase 8 is the `/v1/*`
  OpenAI-compatible API:
  - API keys (hashed, shown once) for external clients, never console sessions;
  - request validation and normalization;
  - `RoutingService.plan()` → execute the attempts with `ProviderService.chat` /
    `chatStream`, with timeouts, cancellation on client disconnect, and
    `FailureTracker` updates;
  - streaming SSE passthrough without buffering (spec §13);
  - request IDs and usage accounting hooks.

---

## Resolved

- **MESSAGE** · 2026-11-12 · Next: phase 7, the routing engine. Resolved 2026-11-12:
  phase 7 built on `claude/phase-7-routing` (see `docs/routing.md`).
