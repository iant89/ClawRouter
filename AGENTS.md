# AGENTS.md

Instructions for AI coding agents (and humans) working on ClawRouter. Read this
file at the start of every session.

## First, every session

1. **Read [`MEMORY.md`](MEMORY.md).** Entries labeled **IMPORTANT** and **WARNING**
   are mandatory context: open problems, decisions the owner made, and things not
   to break or redo.
2. Read [`docs/roadmap.md`](docs/roadmap.md) for what is done and what is next.
3. Before working on an area, read its doc in `docs/` (listed below). The
   [design specification](docs/design-specification.md) is the authority. Section
   numbers ("spec §25") are referenced throughout the code.
4. Before ending a session, update `MEMORY.md` (see [the memory protocol](#memory-protocol)).

## What this is

ClawRouter is a self-hosted AI gateway and control platform: one stable API in
front of OpenAI, Anthropic, Google and local models, with routing, failover, rate
limiting, usage tracking and an administration console. It was called **ClawAPI**
until it moved out of the ENTERPRISE-UI repository; old commits use that name.

- **Runtime:** Bun 1.4. **Language:** TypeScript (strict). **Database:** SQLite (`bun:sqlite`).
- **Console:** React 19 and [ENTERPRISE-UI](https://github.com/iant89/ENTERPRISE-UI), vendored as
  `vendor/enterprise-ui-react.tgz` (see `vendor/README.md`).
- **No other UI framework**, no Express/Vite/ORM. Spec §47: do not build a framework around the framework.

## Commands

```bash
bun install            # everything, including the vendored ENTERPRISE-UI
bun run dev            # server + console with hot reload on http://127.0.0.1:8080
bun run check          # typecheck + all tests: must pass before every commit
bun run typecheck
bun test               # ~445 tests, about a second
bun run build          # production bundle in dist/ (server + console)
bun run start          # run the production bundle
bun run migrate        # apply migrations (--status to list)
```

First start: the server writes `data/setup-token`. Open the console and create the
administrator at `/setup`. In development, `data/secret.key` encrypts provider
API keys; it is git-ignored.

## Layout

```
apps/server/        composition root (server.ts): config -> db -> services -> HTTP
apps/console/       React console: features/<area>/, components/custom/, services/ (API calls)
packages/shared/    browser-safe types shared by server and console
packages/core/      config, errors, validation, logger + redaction, event bus, secret box
packages/database/  Database interface, SQLite adapter, migrations (append-only)
packages/api/       router, middleware, controllers
packages/<domain>/  authentication, authorization, audit, notifications, health, providers, models, routing, gateway, rate-limits, requests
tests/support/      harness.ts (fully wired in-memory app), mock-providers.ts (fake provider APIs)
docs/               design specification, roadmap, per-area docs, screenshots/
vendor/             ENTERPRISE-UI tarball (committed)
```

Area docs: [architecture](docs/architecture.md) · [authentication](docs/authentication.md) ·
[authorization](docs/authorization.md) · [console shell](docs/console-shell.md) ·
[providers](docs/providers.md) · [models](docs/models.md) · [routing](docs/routing.md) · [gateway](docs/gateway.md) · [rate limits](docs/rate-limits.md) · [requests and usage](docs/requests-usage.md) · [real-time](docs/realtime.md) · [screenshots](docs/screenshots/README.md)

## Rules

From the specification (§2, §39), plus conventions established while building:

1. **Business logic does not belong in React components.** The console calls the
   API through `apps/console/src/services/*` and only decides what to show.
2. **Provider logic does not belong in routing**, and routing does not belong in
   HTTP handlers. Controllers parse, call a service, and format the result.
3. **Database code stays in repositories.** Domain packages own a repository
   interface plus a SQLite implementation. Nothing else imports `bun:sqlite`.
4. **Every route declares its access:** `router.get(path, access, handler)` with
   `'public'`, `'authenticated'` (own data only), `'api_key'` (`/v1` only) or a permission. It is a required
   argument. Never add a public route without a reason in the code.
5. **Migrations are append-only.** Never edit or rename an applied migration: the
   runner checks checksums and refuses to start. Add `NNNN_name.ts` and append it to
   `packages/database/src/migrations/index.ts`.
6. **Secrets never leave the server.** No secret in logs, audit metadata,
   notifications, errors, URLs, WebSocket messages or API responses. Provider keys
   are write-only and encrypted (`packages/core/src/secrets.ts`). Field names like
   `password`, `token`, `apiKey` are redacted by the logger; do not rely on that alone.
7. **Never trust the browser.** Validate every input on the server
   (`packages/core/src/validation.ts`); the console's checks are only for feedback.
8. **ENTERPRISE-UI is the design system.** Use its components and `--eui-*` tokens.
   Compose before writing custom components (`apps/console/src/components/custom/`);
   no other UI library; never communicate status by color alone.
9. **Dense, dark, technical** (spec §18). Touch screens get ~44px targets
   (`styles/console.css`).
10. **Server-side pagination and filtering** for anything that can grow (spec §35).
11. **Every state change worth knowing is audited** (`AuditService.record`), and
    significant ones emit typed events (`packages/core/src/events.ts`).

## Tests

- Use `createHarness()` (`tests/support/harness.ts`): in-memory database, real
  services, fast password hashing, a fake clock (`h.clock.advance(ms)`), and
  `h.request(path, { cookie, json })` through the full HTTP pipeline.
- Provider calls go to `startMockProviders()` (`tests/support/mock-providers.ts`),
  a real local HTTP server imitating each provider API. **Tests never call real
  providers or the internet.**
- Every new route needs authorization coverage: the sweep in
  `packages/api/test/authorization-api.test.ts` calls every protected route
  anonymously (401), without the permission (403) and with it.

## Definition of done (per phase or feature)

1. `bun run check` passes, and `bun run build` succeeds.
2. The feature is checked in a real browser (Playwright and Chromium are available
   in cloud sessions). Save useful screenshots to `docs/screenshots/<NN-area>/` and
   list them in `docs/screenshots/README.md`.
3. Docs: the area's page in `docs/`, ticks in `docs/roadmap.md` (only for what is
   built **and** tested), and the README status line.
4. A `MEMORY.md` entry for anything the next session must know.
5. A focused commit. Commit messages describe what changed and why; never include
   AI model names or ids.

The owner usually asks to "continue to the next phase". Take the next unchecked
phase in `docs/roadmap.md` and deliver it as a vertical slice (spec §43):
database, domain, API, events, console page, tests and docs.

## Memory protocol

`MEMORY.md` carries notes between sessions. Add an entry when you:

- leave something unfinished or broken;
- make or learn a decision the next session must respect;
- find a risk, a limitation, or something not yet verified;
- receive an instruction from the owner that applies beyond the current task.

Format (newest first, inside the right section):

```markdown
- **IMPORTANT** · 2026-11-12 · Short title
  What, why, and what to do about it.
```

Labels: **IMPORTANT** (must read: decisions, rules from the owner, data-loss
risks), **WARNING** (known problems, limitations, unverified areas), **NOTE**
(useful context), **MESSAGE** (a hand-off to the next session or the owner).

When an entry is resolved, move it to *Resolved* with the date and how, rather than
deleting it. **Never put secrets, keys, tokens or personal data in `MEMORY.md`.**
