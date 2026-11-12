# ClawAPI architecture (first milestone)

How the code maps onto the spec, and the decisions taken while bootstrapping.

## Layers

```
HTTP (Bun.serve)                       apps/server/src/server.ts
  └─ API app: middleware + router      packages/api
       └─ controllers (thin)           packages/api/src/controllers
            └─ application services    packages/health, packages/authentication, packages/audit
                 └─ domain             packages/shared, packages/core
                      └─ infrastructure packages/database (SQLite adapter, repositories)
```

- Dependencies point downward only. `core`, `health` and `database` never import
  from `api`; nothing outside `database` imports `bun:sqlite` (spec §30, rule 4).
- `apps/server/src/server.ts` is the only place that wires things together. There
  are no module-level singletons, so tests can start isolated instances
  (`CLAWAPI_PORT=0`, `:memory:` database).
- The console depends only on `@clawapi/shared` (types) and the REST API, never on
  server packages (spec §2.1, rule 6).

## Request path

```
Bun.serve routes
  /api/*, /v1/*  -> ApiApp.handle
                      requestIdHeader -> securityHeaders -> accessLog -> applyResponseHeaders
                        -> errorBoundary -> csrfProtection -> sessionAuthentication -> router -> controller
  /*             -> console index.html (when CLAWAPI_CONSOLE_ENABLED and bundled)
```

- `errorBoundary` turns every thrown value into an `AppError` and the error envelope.
  Unknown errors become `INTERNAL_ERROR` with a generic message; the cause is logged.
- `accessLog` logs method, path (no query string), status and duration only.
- `sessionAuthentication` sets `ctx.auth` on `/api/*` only. The dispatcher rejects
  non-public routes without it (fail closed). Authorization (phase 3) will check
  permissions on `ctx.auth` the same way.
- Handlers add cookies through `ctx.responseHeaders`, which is applied even to error
  responses (e.g. clearing an invalid cookie on a 401).
- Domain packages own their repository interfaces and SQLite implementations
  (`packages/authentication/src/sqlite/*`). Services depend only on the interfaces.

## Decisions

| Decision | Why |
|---|---|
| Bun's HTML imports serve and bundle the console | One process and one toolchain in development (HMR included) and production (`bun build`). No Vite in ClawAPI (rule 10). |
| Console can be disabled (`CLAWAPI_CONSOLE_ENABLED=false`) | The gateway must work without the console (spec §46). The integration test runs headless. |
| ENTERPRISE-UI consumed as a packed tarball (`vendor/*.tgz`) | The console gets exactly what an npm consumer gets (`dist/` only), with no duplicate React from the parent repo's `node_modules`. |
| Hand-written config validation, no schema library | Small surface today. Revisit when request validation for `/v1/*` arrives (phase 8). |
| Synchronous `Database` interface | Matches `bun:sqlite`. A PostgreSQL adapter will need async variants. Repository interfaces are the stable seam, not `Database`. |
| Migrations as TS modules with checksums | Ship inside the bundle (no file lookups at runtime). Edited or unknown migrations stop startup instead of drifting. |
| `/api/health` is public and returns 503 when OFFLINE | Load balancers and uptime checks can use it. It contains no configuration or secrets. Detailed provider health (`/api/health/providers`) will require auth. |
| Loopback bind by default | Nothing is exposed before authentication exists. |
| argon2id via `Bun.password` | Memory-hard, built into the runtime, no native modules. |
| Session tokens stored as SHA-256 hashes | A database leak does not leak usable sessions. |
| One-time setup token on first start | A fresh, reachable instance cannot be claimed by a stranger. |
| Console auth state is a pure reducer plus `redirectFor` | Unit-testable without a DOM; the UI only decides what to render, never what is allowed. |
| Polling (10 s) for live health in the console | The WebSocket event system is phase 11. `usePolling` pauses when the tab is hidden. |
| Tiny history router in the console | Pages are flat; a routing library is unnecessary for now. |
| Dark theme, compact density | Spec §18: dark graphite, dense. Uses ENTERPRISE-UI's `dark` theme and tokens only. |

## Custom console components

Both live in `apps/console/src/components/custom/` and are compositions of
ENTERPRISE-UI components:

- `HealthStateIndicator`: maps ClawAPI health states to `StatusIndicator` tones,
  always with a text label.
- `PlannedFeature`: page placeholder (`Page` + `EmptyState`) for areas whose server
  API does not exist yet. The console shows no invented data.

## Known limitations

- The console bundle is about 0.9 MB of minified JS because ENTERPRISE-UI's icon
  collection is loaded eagerly. Phase 16 covers this.
- Security headers are applied to API responses only. The console HTML gets a CSP
  in the hardening phase.
- The production bundle must run with `dist/` as the working directory (Bun
  resolves bundled console assets against the working directory).
  `bun run start` handles this.
