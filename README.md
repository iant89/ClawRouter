# ClawAPI

Self-hosted AI model gateway and control platform: one stable API in front of
OpenAI, Anthropic, Google and local models, with routing, failover, rate limiting,
usage tracking and an administration console built on
[ENTERPRISE-UI](../README.md).

- **Spec:** [`specs/clawapi-design-spec.md`](specs/clawapi-design-spec.md)
- **Status:** [`docs/roadmap-status.md`](docs/roadmap-status.md). This is the
  **first working milestone** (spec §44): Bun server, SQLite with migrations,
  `/api/health`, and the console shell. The AI gateway itself (`/v1/*`) and
  authentication are not built yet.
- **Architecture:** [`docs/architecture.md`](docs/architecture.md)

> ⚠️ There is no authentication yet (phase 2). The server binds to `127.0.0.1` by
> default. Do not expose it to untrusted networks.

## Requirements

- [Bun](https://bun.sh) 1.4+
- Node.js 22 + npm, only to build ENTERPRISE-UI from this repository

## Quick start

```bash
cd clawapi
bun run setup        # builds ENTERPRISE-UI, packs it to vendor/, runs bun install
bun run dev          # http://127.0.0.1:8080, with hot reload
```

`bun run dev` starts one process that serves:

| Path | What |
|---|---|
| `/api/*` | Administration API (JSON). Today: `GET /api/health` |
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

## Layout

```
clawapi/
  apps/
    server/      composition root: config -> db -> migrations -> services -> HTTP
    console/     React + ENTERPRISE-UI admin console
  packages/
    shared/      browser-safe types: API envelope, error codes, health vocabulary
    core/        config, errors, logger (with redaction), typed event bus, ids
    database/    data-access interface, SQLite adapter, migrations, repositories
    health/      health checks and aggregation service
    api/         router, middleware pipeline, response conventions, controllers
  specs/         design specification
  docs/          architecture and status
  scripts/       build-ui, migrate, start
  vendor/        packed ENTERPRISE-UI (generated, git-ignored)
```

The remaining packages from spec §4 (`gateway`, `providers`, `models`, `routing`,
`authentication`, `authorization`, `audit`, `observability`) are added by the phase
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
