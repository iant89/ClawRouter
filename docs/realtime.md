# Real-time system (phase 11)

The console's live channel (spec §25, §31 `WEBSOCKET /api/ws`): pages update as
things change instead of polling every few seconds.

## Connection

- `GET /api/ws` with a WebSocket upgrade. Refused unless:
  - the request carries a live **console session** cookie (401 otherwise); API
    keys do not work here;
  - the `Origin` is ClawRouter's own (403 otherwise). This stops another site from
    opening a socket with the user's cookie (cross-site WebSocket hijacking);
  - the user has fewer than 20 open connections (2000 in total; 429 otherwise).
- The first message is `hello` with the user and their permissions. The session
  token is never sent.
- The console sends `{"type":"ping"}` every 25 s and gets `{"type":"pong"}`. Bun
  also pings idle connections. Client messages are limited to 1 KB; anything other
  than a ping is ignored.

## What is sent

Only ids and states, never secrets, prompts or completions. The console fetches
details through the REST API, with its normal permission checks.

| Message | Sent to |
|---|---|
| `health.changed` | every signed-in user (the header shows system health) |
| `provider.changed`, `provider.status`, `provider.test.completed`, `provider.test.failed` | `providers.read` |
| `model.changed`, `model.availability` | `models.read` |
| `routing.changed` | `routing.read` |
| `ratelimits.changed` | `rate_limits.read` |
| `notification.created` (id only) | only the notification's recipients |
| `session.revoked` | only the user whose session ended (`current: true` on that session's own connection) |
| `activity` | users with `requests.read`, `usage.read` or `rate_limits.read`; current gateway metrics only with `requests.read` |

Internal events are not forwarded: sign-in throttling (it holds IP addresses and
usernames), the raw request events, rate-limit refusals (subjects can be IP
addresses), model lists.

**Gateway activity is coalesced.** Each request would otherwise produce two
messages. Instead the server counts completed, failed and rate-limited requests
and sends one `activity` message per second, only while there is traffic.

## Sessions and permissions

- Signing out or revoking a session closes that session's connections at once
  with close code **4401**. The console then goes to the sign-in page, without the
  wait of up to a minute that polling had.
- Every 30 s the server re-checks the session behind each connection (expiry, a
  disabled user) **without** counting it as activity. An open tab does not keep an
  idle session alive.
- A role change takes effect on open connections: the server recomputes the
  permissions, sends a new `hello`, and the console re-reads the session so the
  navigation follows.

## Robustness

- **Slow clients:** a connection with more than 1 MB unsent is closed (4408)
  rather than buffered without bound. The console reconnects and resyncs.
- **Reconnection:** exponential backoff of 1, 2, 4 … 30 s with random jitter, so
  many consoles do not reconnect in step after a restart. The wait is skipped when
  the tab becomes visible again.
- **Dead connections:** if nothing (not even a pong) arrives for two heartbeats,
  the console drops the connection and reconnects.
- **Resync:** after any reconnect, every page refreshes what it shows, because
  events may have been missed.
- **Fallback:** while not live, pages poll as before. While live they still poll
  slowly (30 s to 2 min), as a safety net and for figures that change with time
  (requests per minute).
- **Shutdown:** connections are closed with 4503 and the console reconnects.

| Close code | Meaning | Console |
|---|---|---|
| 4401 | session ended | sign in again; no reconnect |
| 4408 | too slow | reconnect and resync |
| 4429 | too many connections | reconnect later |
| 4503 | server stopping | reconnect |

## Console

- Header indicator: **Live**, **Connecting**, **Reconnecting** or **Offline**
  (icon and text).
- Updates on events:
  - dashboard metrics come with each activity message; recent failures and cost
    follow traffic;
  - health and the header follow `health.changed` and `provider.status`;
  - notifications arrive when created;
  - Rate Limits usage follows traffic;
  - the Requests page shows new requests on its first page ("Show new requests as
    they arrive");
  - Providers, Models and Routing reload when they change, including changes made
    by other administrators.
- Bursts are throttled per page (0.3–15 s), so heavy traffic does not turn into
  heavy API use.

Code: `packages/api/src/realtime/hub.ts` (server), `apps/console/src/services/realtime.ts`
(connection), `apps/console/src/features/realtime/RealtimeContext.tsx` (hooks).

## Limits

- Single node: events are in-process. Several ClawRouter nodes would need a shared
  event channel (for example Redis pub/sub) to reach consoles connected elsewhere.
- Behind a reverse proxy, the proxy must pass WebSocket upgrades on `/api/ws` and
  keep the original `Host` header (the origin check compares against it).
