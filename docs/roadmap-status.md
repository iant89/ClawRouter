# Roadmap status

Tracks implementation against [the spec](../specs/clawapi-design-spec.md) §40/§44.

## First working milestone (§44)

| Exit criterion | Status | Where |
|---|---|---|
| Repository exists | ✅ | `clawapi/` in the ENTERPRISE-UI repository |
| Bun builds/runs | ✅ | `bun run dev`, `bun run build`, `bun run start` |
| TypeScript strict mode | ✅ | `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`, ...), `bun run typecheck` |
| React console runs | ✅ | `apps/console`, served by the Bun server |
| ENTERPRISE-UI renders | ✅ | AppShell, ApplicationHeader, SideNavigation, MetricCard, Table, ... |
| Bun API server runs | ✅ | `apps/server`, `packages/api` |
| SQLite works | ✅ | `packages/database` (`bun:sqlite`, WAL, foreign keys) |
| Migration system works | ✅ | checksummed, transactional, ordered; `bun run migrate` |
| `/api/health` works | ✅ | platform + database checks; 503 when OFFLINE |
| Basic test suite works | ✅ | `bun test`: unit and integration tests |
| Development workflow documented | ✅ | `README.md` |

## Phases

| Phase | Status | Notes |
|---|---|---|
| 0 Project bootstrap | ✅ Done | |
| 1 Core backend | ✅ Done | Router, middleware, errors, config, validation, logging, event bus, repositories, migration runner, response conventions. |
| 2 Authentication | ✅ Done | See below. |
| 3 Authorization | ✅ Done | See below. |
| 4 Application shell | ✅ Done | See below. |
| 5–17 | ⬜ | Console pages for these areas show a "not available yet" placeholder. |
| 12 Health + operations | 🟡 Started | Platform and database health, background health checks, health page. |
| 13 Logging + audit | 🟡 Started | Audit repository and service; authentication events audited. |
| 14 Administration | 🟡 Started | Session management; Users page (list, role assignment); Roles page (permission matrix). Missing: creating/disabling users, password reset, settings. |

## Phase 2: authentication

| Task | Status | Where |
|---|---|---|
| USERS table | ✅ | migration `0002_users_sessions` |
| Password hashing | ✅ | argon2id, `packages/authentication/src/password.ts` |
| Session table | ✅ | hashed tokens, idle + absolute expiry |
| Login / logout / session lookup | ✅ | `/api/auth/*`, console sign-in screen and user menu |
| Session expiration | ✅ | idle (sliding) and absolute |
| Session revocation | ✅ | logout, "My sessions", `revokeAllSessions`, `session.revoked` event |
| Login throttling | ✅ | per username and per IP, 429 + Retry-After |
| Failed-login audit | ✅ | `audit_log`, migration `0003_audit_log` |
| Initial setup wizard | ✅ | `/setup` with a one-time setup token |

Exit criteria: users sign in and out securely ✅; sessions are server-side ✅; no
admin action is possible without authentication ✅ (every `/api` route except
health, setup and sign-in requires a session; enforced by tests).

## Phase 3: authorization

| Task | Status | Where |
|---|---|---|
| Roles | ✅ | `roles` table, built-in ADMIN / OPERATOR / VIEWER (migration `0004_roles`) |
| Permissions | ✅ | `packages/shared/src/authorization.ts` (21 permissions) |
| User-role assignments | ✅ | `user_roles`, `PUT /api/users/:id/roles`, console Users page |
| Authorization middleware | ✅ | required `access` on every route, enforced in the dispatcher |
| Permission service | ✅ | `packages/authorization` |
| Authorization tests | ✅ | every protected route is called anonymously (401), without the permission (403) and with it |

Exit criterion: every protected endpoint enforces permissions server-side ✅.

## Phase 4: application shell

| Task | Status | Where |
|---|---|---|
| Application shell, sidebar, header | ✅ | `layouts/ConsoleLayout.tsx` (ENTERPRISE-UI AppShell, ApplicationHeader, SideNavigation) |
| Routing | ✅ | `app/router.tsx`, deep links, return-to after sign-in |
| Page layout | ✅ | ENTERPRISE-UI `Page` on every page |
| Responsive layout | ✅ | drawer on phones, icons on tablets; ~44px touch targets on coarse pointers |
| Notifications | ✅ | `packages/notifications`, `/api/notifications`, header bell + panel + toasts |
| User menu | ✅ | name, roles, My sessions, Sign out |
| Permission-aware navigation | ✅ | `visibleNavigation`, no-access page |
| Loading states | ✅ | busy indicator, table skeletons, refresh controls |
| Error states | ✅ | message strips, server-unreachable screen, `PageErrorBoundary` |

Exit criterion: authenticated users have a functional enterprise application shell ✅.
