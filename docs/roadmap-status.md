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
| 1 Core backend | 🟡 Mostly done | Router, middleware, errors, config, logging, event bus, repository pattern (settings), migration runner, response conventions. Remaining: request body validation helpers. |
| 2 Authentication | ⬜ Next | |
| 3 Authorization | ⬜ | |
| 4 Application shell | 🟡 Started | Shell, header, navigation, responsive layout, loading/error states. Missing: notifications, real user menu, permission-aware navigation (needs 2–3). |
| 5–17 | ⬜ | Console pages for these areas show a "not available yet" placeholder. |
| 12 Health + operations | 🟡 Started | Platform and database health, health page. |
