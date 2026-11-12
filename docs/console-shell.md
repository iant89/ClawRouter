# Console shell and notifications (phase 4)

## Shell

| Area | Behavior |
|---|---|
| Header | ClawAPI identity, system health (text + icon), notifications bell with unread count, help, user menu with name and roles (My sessions, Sign out) |
| Navigation | Spec §17 groups, filtered to the user's permissions (empty groups dropped). Collapses to icons on tablets and becomes a drawer on phones (ENTERPRISE-UI AppShell) |
| Routing | History-API router; deep links work (the server serves the console for every non-API path). Signed-out users return to the requested page after sign-in |
| Access | Pages without permission show a "no access" page. The server refuses the data regardless |
| Loading / errors | Pages show table skeletons and busy states while loading, and a message strip when a request fails. A page that throws while rendering shows "This page could not be displayed" with *Try again*; the header and navigation keep working (`PageErrorBoundary`). Losing the server shows a retry screen |
| Density | Compact for mouse users (spec §18 "dense"). On touch screens (`pointer: coarse`) the cozy density, plus raised size tokens so controls are about 44px (spec §20). See `apps/console/src/styles/console.css` |

## Notifications

Server-generated, per user, kept for 30 days.

- A notification goes either to **one user** or to **everyone holding a
  permission**. The audience is evaluated when notifications are read, so role
  changes apply to existing notifications too.
- Read and dismissed state is **per user**.
- Content is written to be safe for every recipient: no secrets, no request
  payloads. Links are console paths only.

| Source event | Audience | Severity | Example |
|---|---|---|---|
| `health.changed` (not the normal startup) | `health.read` | Error / Warning / Resolved | "Platform health: Offline" |
| `user.roles_changed` | the user | Info | "Your roles changed: You now have Operator." |
| `auth.login_throttled` (once per block) | `audit.read` | Warning | "Sign-in as "vera" is blocked for 15 min…" |

The server runs its own health check every `CLAWAPI_HEALTH_INTERVAL_SECONDS`
(default 30), so health notifications are created even when no console is open.

### API (any signed-in user, own notifications only)

| Method | Path | |
|---|---|---|
| GET | `/api/notifications?limit=&unread=true` | Newest first; `meta.unread` is the unread count |
| POST | `/api/notifications/:id/read` | 204, or 404 if not visible to the caller |
| POST | `/api/notifications/read-all` | `{ marked }` |
| DELETE | `/api/notifications/:id` | Dismiss (for the caller only) |

### Console

The header bell shows the unread count. The panel is ENTERPRISE-UI's
`NotificationCenter` (with the severity spelled out in each title), plus *Mark all
as read* and links to the related pages. The console polls every 30 seconds and
when the tab becomes visible. A new warning or error also appears as a toast.
WebSocket push replaces polling in phase 11.
