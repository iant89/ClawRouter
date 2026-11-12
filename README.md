# ClawAPI

Self-hosted AI model gateway and control platform: one stable API in front of
OpenAI, Anthropic, Google and local models, with routing, failover, rate limiting,
usage tracking and an administration console built on
[ENTERPRISE-UI](../README.md).

- **Spec:** [`specs/clawapi-design-spec.md`](specs/clawapi-design-spec.md)
- **Status:** [`docs/roadmap-status.md`](docs/roadmap-status.md). Done so far: the
  first working milestone (Bun server, SQLite with migrations, `/api/health`,
  console shell), phase 2 **authentication** (server-side sessions, initial
  setup, login throttling, audit, session revocation) and phase 3
  **authorization** (ADMIN / OPERATOR / VIEWER roles enforced on every route), and
  phase 4, the **console shell** with notifications, and phase 5, the **provider
  engine** (OpenAI, Anthropic, Google, local / OpenAI-compatible, with encrypted
  credentials).
  The AI gateway itself (`/v1/*`) is not built yet.
- **Architecture:** [`docs/architecture.md`](docs/architecture.md) ·
  **Security model:** [`docs/authentication.md`](docs/authentication.md),
  [`docs/authorization.md`](docs/authorization.md) · **Console:**
  [`docs/console-shell.md`](docs/console-shell.md) · **Providers:**
  [`docs/providers.md`](docs/providers.md)

> Serve ClawAPI over HTTPS (behind a reverse proxy) before exposing it.

## Requirements

- [Bun](https://bun.sh) 1.4+
- Node.js 22 + npm, only to build ENTERPRISE-UI from this repository

## Quick start

```bash
cd clawapi
bun run setup        # builds ENTERPRISE-UI, packs it to vendor/, runs bun install
bun run dev          # http://127.0.0.1:8080, with hot reload
```

On first start there are no users. The server writes a one-time **setup token**
to `data/setup-token` (mode 0600) and logs that path. Open the console, which
redirects to `/setup`, paste the token, and create the first administrator.
The token file is deleted and `/setup` closes for good once setup succeeds.

Development also generates `data/secret.key`, which encrypts provider API keys.
Keep it with the database: without it, stored keys cannot be decrypted.

`bun run dev` starts one process that serves:

| Path | What |
|---|---|
| `/api/*` | Administration API (JSON, session cookie). See [authentication](docs/authentication.md#endpoints) |
| `/v1/*` | External AI gateway API. Reserved; returns normalized 404 until phase 8 |
| everything else | The console (React + ENTERPRISE-UI), bundled on the fly by Bun with HMR |

```bash
curl -s http://127.0.0.1:8080/api/health | jq
```

## Scripts

| Command | Does |
|---|---|
| `bun run setup` | `ui:build` + `bun install` (first run, or after ENTERPRISE-UI changes) |
| `bun run ui:build` | Build ENTERPRISE-UI in the parent repo and pack it to `vendor/enterprise-ui-react.tgz` (`--skip-build` to only re-pack) |
| `bun run dev` | Server + console with hot reload |
| `bun test` | All unit and integration tests |
| `bun run typecheck` | `tsc` in strict mode over every package and app |
| `bun run check` | typecheck + tests |
| `bun run migrate` | Apply pending migrations (`--status` to list only) |
| `bun run build` | Production bundle in `dist/` (server + console) |
| `bun run start` | Run the production bundle (`CLAWAPI_ENV=production`) |

After changing ENTERPRISE-UI itself, run `bun run ui:build && bun install` to pick it up.

## Configuration

Environment variables (Bun loads `.env` automatically; see `.env.example`).
Invalid values stop the server with a message listing every problem.

| Variable | Default | Notes |
|---|---|---|
| `CLAWAPI_ENV` | `development` | `development`, `test` or `production` |
| `CLAWAPI_HOST` | `127.0.0.1` | Loopback by default |
| `CLAWAPI_PORT` | `8080` | `0` picks a free port |
| `CLAWAPI_DATABASE_PATH` | `./data/clawapi.db` | `:memory:` in `test` |
| `CLAWAPI_LOG_LEVEL` | `debug` (dev), `info` | `debug`, `info`, `warn`, `error`, `fatal` |
| `CLAWAPI_LOG_FORMAT` | `pretty` (dev), `json` | |
| `CLAWAPI_CONSOLE_ENABLED` | `true` | `false` runs the server headless (API only) |
| `CLAWAPI_SESSION_IDLE_MINUTES` | `60` | A session ends after this long without activity |
| `CLAWAPI_SESSION_MAX_HOURS` | `12` | A session ends this long after sign-in, regardless of activity |
| `CLAWAPI_COOKIE_SECURE` | `true` in production | Marks the session cookie `Secure` and uses the `__Host-` prefix. Requires HTTPS |
| `CLAWAPI_HEALTH_INTERVAL_SECONDS` | `30` | Background health checks (5–3600) |
| `CLAWAPI_SECRET_KEY` | generated in dev | 32-byte key (base64 or hex) that encrypts provider credentials. **Required in production.** `openssl rand -base64 32` |
| `CLAWAPI_SECRET_KEY_FILE` | | File containing the key, instead of `CLAWAPI_SECRET_KEY` |
| `CLAWAPI_PROVIDER_HEALTH_INTERVAL_SECONDS` | `300` | Background provider checks; `0` turns them off |
| `CLAWAPI_SETUP_TOKEN` | generated | Pre-chosen initial setup token (≥ 16 chars), e.g. for automated installs |

## Layout

```
clawapi/
  apps/
    server/      composition root: config -> db -> migrations -> services -> HTTP
    console/     React + ENTERPRISE-UI admin console
  packages/
    shared/      browser-safe types: API envelope, error codes, health vocabulary
    core/        config, errors, validation, logger (with redaction), typed event bus, ids
    database/    data-access interface, SQLite adapter, migrations, settings repository
    authentication/  users, sessions, password hashing, login throttling, initial setup
    authorization/   roles, permissions, role assignment
    notifications/   per-user and per-permission notifications, event producers
    providers/   provider adapters (OpenAI, Anthropic, Google, OpenAI-compatible), encrypted credentials, status
    audit/       append-only audit log
    health/      health checks and aggregation service
    api/         router, middleware (CSRF, sessions), response conventions, controllers
  specs/         design specification
  docs/          architecture and status
  scripts/       build-ui, migrate, start
  tests/support/ shared test harness (in-memory, fast hashing, fake clock)
  vendor/        packed ENTERPRISE-UI (generated, git-ignored)
```

The remaining packages from spec §4 (`gateway`, `models`, `routing`,
`observability`) are added by the phase
that implements them, so the tree never contains empty placeholders.

## Adding a migration

1. Create `packages/database/src/migrations/NNNN_description.ts` exporting a
   `Migration` (`id` must sort after the previous one).
2. Append it to `packages/database/src/migrations/index.ts`.
3. Never edit a released migration. The runner stores a checksum and refuses to
   start if an applied migration changed.

## API conventions

```jsonc
// success
{ "data": { ... }, "meta": { ... } }
// failure (4xx/5xx)
{ "error": { "code": "NOT_FOUND", "message": "...", "requestId": "req_..." } }
```

Every response has an `x-request-id` header that matches the server's log lines.
5xx messages are always generic; details stay in the server log.

Every route declares its access when it is registered (`'public'`,
`'authenticated'` or a permission), and the server enforces it before the handler
runs. See [authorization](docs/authorization.md). State-changing requests need a JSON
body and, when they carry the session cookie, the `x-clawapi-csrf` header.

```bash
# API from the command line
curl -s -c jar -H 'content-type: application/json' \
  -d '{"username":"admin","password":"…"}' http://127.0.0.1:8080/api/auth/login
curl -s -b jar http://127.0.0.1:8080/api/auth/session
curl -s -b jar -X POST -H 'x-clawapi-csrf: 1' http://127.0.0.1:8080/api/auth/logout
```
