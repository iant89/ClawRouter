# Health and operations (phase 12)

Operational visibility (spec §24, §26): which part of the platform is healthy or
failing now, how it behaved over time, and the state of long-running work.

## Health checks

The server checks every component every 30 s (`CLAWROUTER_HEALTH_INTERVAL_SECONDS`).

| Component | Critical | Healthy | Degraded / offline | Disabled |
|---|---|---|---|---|
| Platform | no | heap under 1 GB | heap over 1 GB | |
| Database | **yes** | SQLite answers | offline: no answer (the platform is then OFFLINE, `/api/health` answers 503) | |
| Providers | no | every enabled provider healthy | some or all unhealthy | none enabled |
| Gateway | no | requests mostly succeed and some model is usable | degraded: at least half of the last minute's requests failed (with 10 or more requests), or no model is usable | no models registered |
| WebSocket | no | the live channel is running (with its connection count) | offline: not running | |

The overall status is OFFLINE if a critical check is offline, DEGRADED if any check
is degraded, offline or unknown, and HEALTHY otherwise.

**`/api/health` stays public** for load balancers, but only callers with
`health.read` get each check's detail and latency. Anonymous callers and users
without a role get statuses only: details describe traffic and infrastructure.

## Health history

- Every **scheduled** check is stored in `health_history` (migration
  `0012_health_operations`): component, status, latency and detail. Checks
  requested through the API or the console are not recorded, so history has a
  regular rhythm.
- Kept for 7 days (`CLAWROUTER_HEALTH_HISTORY_DAYS`, 0 keeps it forever) and
  pruned hourly. Per-provider check history (phase 5) is separate.
- `GET /api/health/history?hours=24&component=gateway` (`health.read`, 1–168 hours)
  returns per component:
  - the latest status;
  - **availability**: the share of checks that were HEALTHY (DISABLED checks are
    not counted);
  - check count and average check time;
  - **48 buckets**, each holding the worst status seen in it;
  - the last 50 status **changes**, with the detail at the time.

## Operations

Long-running work with a lifecycle: `QUEUED → RUNNING → SUCCESS | FAILED |
TIMEOUT | CANCELLED`. Each operation has progress (0–100), a message, a result, an
error, who started it and when (table `operations`).

| Type | Does | See it | Start / cancel it | Timeout |
|---|---|---|---|---|
| `health.check` | Runs every health check now | `health.read` | `health.read` | 30 s |
| `provider.test` | Connection test of one provider (the Providers page's **Test**) | `providers.read` | `providers.write` | 60 s |
| `providers.check` | Tests every enabled provider, one by one, with progress | `providers.read` | `providers.write` | 5 min |

- **Queue:** two operations run at a time; the rest wait as QUEUED. Starting the
  same type and target while one is pending returns the pending one, so
  double-clicks do not duplicate work.
- **Cancellation:** a queued operation is removed before it starts. A running one
  is told to stop (an abort signal) and ends as CANCELLED at once, even if the
  work does not stop by itself. A provider call already in flight may still finish
  at the provider; its result is ignored.
- **Timeouts** end the operation as TIMEOUT.
- **Failures:** messages meant for users are kept; unexpected internal errors are
  logged and shown as "The operation failed." (never stack traces, hosts or
  credentials).
- **Restarts:** operations left QUEUED or RUNNING by a stopped server are marked
  FAILED at startup. Finished operations are kept for 30 days.
- **Audit:** `OPERATION_STARTED`, `OPERATION_CANCELLED`. Connection tests are still
  audited as `CONNECTION_TEST` too.
- **Events:** `operation.progress` on every change, forwarded over the live channel
  to users who may see that type.

The work itself is defined in `apps/server/src/operation-handlers.ts`, where
providers and health are wired together. `packages/operations` only manages the
lifecycle.

### API

| Route | |
|---|---|
| `GET /api/operations?status=&type=&page=&pageSize=` | Only the types the user may see |
| `GET /api/operations/:id` | 404 for types the user may not see |
| `POST /api/operations` `{ type, targetId? }` | 201 with the operation; 403 without the type's start permission |
| `POST /api/operations/:id/cancel` | 409 once it has ended |
| `POST /api/providers/:id/test` | Unchanged: waits for the test and returns its result, now with `operationId` |

These routes are declared `authenticated` because the permission depends on the
operation type; the operation service checks it on every call.

## Console

- **System → Health:**
  - the current checks;
  - **Run checks now**;
  - history for 24 hours, 3 days or 7 days: per component, the healthy share,
    change count, average check time and a timeline strip (each step has a text
    label; color is never the only signal);
  - recent changes across all components.
- **System → Operations:**
  - every operation the user may see, with live progress over the live channel;
  - **Run health checks** and **Check all providers**;
  - cancellation with confirmation;
  - a status filter and paging.

## Not yet

- Latency charts per component and availability over months (history is
  short-term by design).
- More operation types (configuration reload, model discovery, maintenance) as
  later phases need them.
- Operations are per process; with several nodes, each would run its own queue.
