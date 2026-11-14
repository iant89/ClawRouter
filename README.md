# ClawRouter

Self-hosted AI model gateway and control platform: one stable API in front of
OpenAI, Anthropic, Google and local models, with routing, failover, rate limiting,
usage tracking and an administration console built on
[ENTERPRISE-UI](https://github.com/iant89/ENTERPRISE-UI).

> Formerly **ClawAPI**: developed inside the ENTERPRISE-UI repository, then moved
> here with its history and renamed. Environment variables are now
> `CLAWROUTER_*`.

- **Spec:** [`docs/design-specification.md`](docs/design-specification.md)
- **Roadmap and status:** [`docs/roadmap.md`](docs/roadmap.md). Done so far: the
  first working milestone (Bun server, SQLite with migrations, `/api/health`,
  console shell), phase 2 **authentication** (server-side sessions, initial
  setup, login throttling, audit, session revocation) and phase 3
  **authorization** (ADMIN / OPERATOR / VIEWER roles enforced on every route), and
  phase 4, the **console shell** with notifications, phase 5, the **provider
  engine** (OpenAI, Anthropic, Google, local / OpenAI-compatible, with encrypted
  credentials), phase 6, the **model registry** (discovery, availability,
  capabilities, prices), and phase 7, the **routing engine** (aliases, priorities,
  weights, health-aware fallback, failover policies), and phase 8, the **request
  gateway**: an OpenAI-compatible `/v1` API (chat completions with streaming,
  embeddings, models) authenticated by API keys, with retries and failover, and
  phase 9, **rate limiting** (per key, user, model and gateway, with live usage),
  and phase 10, **requests and usage** (request history with attempts, tokens and
  estimated cost; usage reports by model, provider, key and user), and phase 11,
  the **real-time system** (a signed-in WebSocket that keeps the console live),
  and phase 12, **health and operations** (gateway and WebSocket checks, health
  history, cancellable long-running operations), and phase 13, **logging and
  audit** (Logs and Audit pages, secret scrubbing by shape), and phase 14,
  **administration** (custom roles, user management with temporary passwords and
  command-line recovery, system and security settings), and phase 15, **security
  hardening** (streamed body limits, CSP and security headers, trusted proxies,
  key rotation, secret scanning; see [security](docs/security.md)), plus
  **self-service API keys** (an `api_keys.own` permission, key requests approved by
  others, keys that expire daily or after a set time, and a maximum key lifetime per provider
  and model; see
  [self-service keys](docs/self-service-keys.md)), and **two-factor sign-in**
  configured by administrators (authenticator app, email codes over SMTP, recovery
  codes; see [two-factor](docs/two-factor.md)), and phase 16, **performance**
  (indexes, a cached routing snapshot, code splitting and compression, measured with
  `bun run bench:db` and `bun run bench:gateway`; see [performance](docs/performance.md)).
  Production packaging is next (phase 17).
- **Architecture:** [`docs/architecture.md`](docs/architecture.md) ·
  **Security model:** [`docs/authentication.md`](docs/authentication.md),
  [`docs/authorization.md`](docs/authorization.md) · **Console:**
  [`docs/console-shell.md`](docs/console-shell.md) · **Providers:**
  [`docs/providers.md`](docs/providers.md) · **Models:** [`docs/models.md`](docs/models.md) ·
  **Routing:** [`docs/routing.md`](docs/routing.md) · **Gateway:** [`docs/gateway.md`](docs/gateway.md) · **Rate limits:** [`docs/rate-limits.md`](docs/rate-limits.md) · **Requests and usage:** [`docs/requests-usage.md`](docs/requests-usage.md) · **Real-time:** [`docs/realtime.md`](docs/realtime.md) · **Health and operations:** [`docs/health-operations.md`](docs/health-operations.md) · **Logging and audit:** [`docs/logging-audit.md`](docs/logging-audit.md)
- **Screenshots:** [`docs/screenshots/`](docs/screenshots/README.md)
- **Working on the code:** [`AGENTS.md`](AGENTS.md) (rules, commands, definition
  of done) and [`MEMORY.md`](MEMORY.md) (important notes carried between sessions).

> Serve ClawRouter over HTTPS (behind a reverse proxy) before exposing it.

## Requirements

- [Bun](https://bun.sh) 1.4+
- Node.js 22 + npm, only to refresh the vendored ENTERPRISE-UI package (see
  [`vendor/README.md`](vendor/README.md))

## Quick start

```bash
bun install          # ENTERPRISE-UI comes from vendor/enterprise-ui-react.tgz (committed)
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
| `/api/ws` | The console's live channel (WebSocket, session cookie, same origin). See [real-time](docs/realtime.md) |
| `/v1/*` | External AI gateway API, OpenAI-compatible, API keys only. See [gateway](docs/gateway.md) |
| everything else | The console (React + ENTERPRISE-UI), bundled on the fly by Bun with HMR |

```bash
curl -s http://127.0.0.1:8080/api/health | jq
```

## Scripts

| Command | Does |
|---|---|
| `bun run setup` | Same as `bun install` |
| `bun run ui:build` | Rebuild `vendor/enterprise-ui-react.tgz` from a local ENTERPRISE-UI checkout (`ENTERPRISE_UI_PATH=…`; `--skip-build` to only re-pack) |
| `bun run dev` | Server + console with hot reload |
| `bun test` | All unit and integration tests |
| `bun run typecheck` | `tsc` in strict mode over every package and app |
| `bun run check` | typecheck + tests |
| `bun run migrate` | Apply pending migrations (`--status` to list only) |
| `bun run reset-password <username>` | Lost password: sets and prints a temporary password, ends the user's sessions (`--enable` also re-enables the account) |
| `bun run rotate-secret-key` | Re-encrypt stored provider credentials with a new key (`CLAWROUTER_NEW_SECRET_KEY` or `--new-key-file`); stop the server first |
| `bun run scan-secrets` | Fail on credential-shaped strings in tracked files (`--history`: every commit) |
| `bun run build` | Production bundle in `dist/` (server + console) |
| `bun run start` | Run the production bundle (`CLAWROUTER_ENV=production`) |

To move to a newer ENTERPRISE-UI, follow [`vendor/README.md`](vendor/README.md).

## Configuration

Environment variables (Bun loads `.env` automatically; see `.env.example`).
Invalid values stop the server with a message listing every problem.

| Variable | Default | Notes |
|---|---|---|
| `CLAWROUTER_ENV` | `development` | `development`, `test` or `production` |
| `CLAWROUTER_HOST` | `127.0.0.1` | Loopback by default |
| `CLAWROUTER_PORT` | `8080` | `0` picks a free port |
| `CLAWROUTER_DATABASE_PATH` | `./data/clawrouter.db` | `:memory:` in `test` |
| `CLAWROUTER_LOG_LEVEL` | `debug` (dev), `info` | `debug`, `info`, `warn`, `error`, `fatal` |
| `CLAWROUTER_LOG_FORMAT` | `pretty` (dev), `json` | |
| `CLAWROUTER_LOG_BUFFER_SIZE` | `5000` | Recent log records kept in memory for the console's Logs page; `0` turns it off |
| `CLAWROUTER_CONSOLE_ENABLED` | `true` | `false` runs the server headless (API only) |
| `CLAWROUTER_SESSION_IDLE_MINUTES` | `60` | A session ends after this long without activity |
| `CLAWROUTER_SESSION_MAX_HOURS` | `12` | A session ends this long after sign-in, regardless of activity |
| `CLAWROUTER_COOKIE_SECURE` | `true` in production | Marks the session cookie `Secure` and uses the `__Host-` prefix. Requires HTTPS |
| `CLAWROUTER_HEALTH_INTERVAL_SECONDS` | `30` | Background health checks (5–3600) |
| `CLAWROUTER_HEALTH_HISTORY_DAYS` | `7` | Days of health history to keep; `0` keeps it forever |
| `CLAWROUTER_SECRET_KEY` | generated in dev | 32-byte key (base64 or hex) that encrypts provider credentials. **Required in production.** `openssl rand -base64 32` |
| `CLAWROUTER_SECRET_KEY_FILE` | | File containing the key, instead of `CLAWROUTER_SECRET_KEY` |
| `CLAWROUTER_PROVIDER_HEALTH_INTERVAL_SECONDS` | `300` | Background provider checks; `0` turns them off |
| `CLAWROUTER_REQUEST_RETENTION_DAYS` | `30` | Days to keep gateway request history; `0` keeps it forever |
| `CLAWROUTER_USAGE_RETENTION_DAYS` | `400` | Days to keep hourly usage records; `0` keeps them forever |
| `CLAWROUTER_SETUP_TOKEN` | generated | Pre-chosen initial setup token (≥ 16 chars), e.g. for automated installs |
| `CLAWROUTER_TRUSTED_PROXIES` | none | Reverse proxies (addresses or CIDR ranges, comma-separated) whose `X-Forwarded-For` is believed. Only list your own proxy |

Session lifetimes and the three retention periods are only **defaults**: Administration → Settings can change them while running, and a value set there wins until it is reset (see [administration](docs/administration.md#settings)).

## Layout

```
clawrouter/
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
    models/      model registry: discovery, availability, capabilities, cost metadata
    routing/     routing engine (pure), routing configuration, failure tracker
    audit/       append-only audit log
    health/      health checks and aggregation service
    api/         router, middleware (CSRF, sessions), response conventions, controllers
  docs/          design specification, roadmap, architecture, feature docs, screenshots/
  scripts/       build-ui, migrate, start
  tests/support/ shared test harness (in-memory, fast hashing, fake clock)
  vendor/        ENTERPRISE-UI package tarball (committed; see vendor/README.md)
```

The remaining packages from spec §4 (`gateway`,
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
body and, when they carry the session cookie, the `x-clawrouter-csrf` header.

```bash
# API from the command line
curl -s -c jar -H 'content-type: application/json' \
  -d '{"username":"admin","password":"…"}' http://127.0.0.1:8080/api/auth/login
curl -s -b jar http://127.0.0.1:8080/api/auth/session
curl -s -b jar -X POST -H 'x-clawrouter-csrf: 1' http://127.0.0.1:8080/api/auth/logout
```
