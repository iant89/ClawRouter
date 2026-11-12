# Authentication (phase 2)

How the console signs people in, and why it is built this way. Spec §14, §15, §29.

## Model

- **Console users** sign in with a username and password and get a **server-side
  session**. The browser only holds an opaque, HttpOnly cookie.
- **External AI clients** (`/v1/*`) will use API keys (phase 8). A console session
  never authenticates `/v1/*`; the session middleware only runs on `/api/*`.
- **Authorization** (who may do what) is described in [authorization](authorization.md).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/setup/status` | public | `{ required }`: true while no user exists |
| POST | `/api/setup` | public + setup token | Create the first administrator, sign in (201) |
| POST | `/api/auth/login` | public | `{ username, password }` → session cookie + `{ user, session }` |
| POST | `/api/auth/logout` | public | Revoke the current session, clear the cookie (204, idempotent) |
| GET | `/api/auth/session` | session | Current `{ user, session }`, or 401 |
| GET | `/api/auth/sessions` | session | The caller's live sessions |
| DELETE | `/api/auth/sessions/:id` | session | Revoke one of the caller's sessions (404 if it is not theirs) |
| POST | `/api/auth/sessions/revoke-others` | session | Sign out everywhere except this browser → `{ revoked }` |
| GET | `/api/sessions?page=&pageSize=&userId=` | session ¹ | Live sessions of all users with their owner, paginated (`meta: { page, pageSize, total }`, max 100 per page) |
| DELETE | `/api/sessions/:id` | session ¹ | Revoke any session (404 if unknown or already ended). Revoking your own current one also clears your cookie |
| POST | `/api/sessions/revoke` | session ¹ | `{ userId, keepCurrent? }`: revoke all of a user's sessions → `{ revoked }` |

¹ Administration endpoints: `sessions.read` to list, `sessions.revoke` to revoke
(administrators). See [authorization](authorization.md).

## Initial setup

1. On startup with an empty `users` table, the server creates a one-time **setup
   token**: either `CLAWAPI_SETUP_TOKEN`, or 192 random bits written to
   `setup-token` next to the database with mode 0600. Only the file path is logged,
   never the token.
2. `POST /api/setup` requires the token (compared in constant time; 10 wrong guesses
   per IP in 15 minutes block that IP for 15 minutes), a valid username and a password
   meeting the policy.
3. The user is created inside a transaction that re-checks that no user exists, so
   two concurrent setups cannot both succeed.
4. Afterwards `/api/setup` returns 409, the token file is deleted, and the console
   never shows `/setup` again. Recovery (resetting a lost admin password) will be a
   server-side CLI. There is deliberately no web path.

Why a token: without it, whoever reaches a freshly started instance first could
claim it.

## Passwords

- **argon2id** via `Bun.password` (Bun's defaults: 64 MiB memory, 2 iterations). No
  native dependency.
- Policy: 12–256 characters, must not contain the username, at least 4 distinct
  characters. Enforced on the server; the console mirrors it only for feedback.
- The login body accepts at most 1024 characters, so a huge input cannot be used to
  burn CPU.

## Sessions

- Token: 256 random bits (base64url) in the cookie. The database stores only its
  **SHA-256 hash**, so a copy of the database cannot be used to take over sessions.
  Sessions also have a separate public id, used for listing and revocation.
- Cookie: `HttpOnly; SameSite=Strict; Path=/`, and `Secure` with the `__Host-` name
  prefix when `CLAWAPI_COOKIE_SECURE` is on (default in production). Max-Age equals
  the absolute session lifetime.
- **Idle timeout** (`CLAWAPI_SESSION_IDLE_MINUTES`, default 60) slides on activity.
  `last_seen_at` is written at most once a minute. **Absolute lifetime**
  (`CLAWAPI_SESSION_MAX_HOURS`, default 12) never slides.
- A session is rejected if it is revoked, past either expiry, or its user is not
  `ACTIVE` (disabled-user protection). An invalid cookie is cleared in the response.
- Revocation takes effect on the session's **next request**: it is checked on every
  call, nothing is cached. Ways to revoke:
  - the user: sign out, or "My sessions" in the user menu (one session, or all others);
  - administrators: **Administration → Sessions** (one session, or all sessions of
    a user);
  - the system: `revokeAllSessions` (for disabling users and password changes in
    phase 14).

  Each revocation is audited as `SESSION_REVOKED` (one record per bulk operation,
  with the count and session ids) and emits `session.revoked` on the event bus. A
  revoked user's open console notices within a minute (periodic session check) or
  on its next API call. Phase 11 pushes the event to the console over WebSocket for
  an instant sign-out.
- Ended sessions are purged hourly, a day after they end.

## Login throttling

In memory, per process (phase 9 adds a pluggable store):

| Key | Limit | Block |
|---|---|---|
| username | 10 failures in 15 min | 15 min |
| IP address | 50 failures in 15 min | 15 min |

Blocked attempts return **429** with `Retry-After` and are audited. A successful
login resets the username counter. The tracked-key map is size-bounded.

Unknown usernames and wrong passwords get the same message, and the server verifies a
dummy hash for unknown users so response timing is similar. "Account is disabled" is
only shown after the correct password.

> Behind a reverse proxy every client has the proxy's IP, so the per-IP limit then
> applies to everyone together. Trusted-proxy support (`X-Forwarded-For`) comes with
> production packaging (phase 17).

## CSRF

Layered, because the session is a cookie:

1. `SameSite=Strict`: browsers do not send the cookie on cross-site requests.
2. Unsafe requests (`POST/PUT/PATCH/DELETE`) with a cross-site `Origin` or
   `Sec-Fetch-Site` are rejected with 403.
3. Request bodies must be `application/json`, which a cross-site form cannot send
   without a CORS preflight. ClawAPI never answers CORS preflights.
4. Cookie-authenticated unsafe requests must carry `x-clawapi-csrf` (any value).
   The console adds it automatically. Scripts using a cookie must add it too.

## Audit

Recorded in `audit_log` (append-only repository; metadata passes through redaction):
`LOGIN`, `LOGIN_FAILED` (reason: `invalid_credentials`, `user_disabled`,
`throttled`; the attempted username, never the password), `LOGOUT`,
`SESSION_REVOKED`, `USER_CREATED`, `SETUP_COMPLETED`. Each record has the actor, IP
and request id. The audit UI is phase 13.

## Not yet

- User management, disabling users, password change/reset (phase 14).
- Admin password recovery CLI, trusted proxies (phase 17).
- MFA, SSO (future).
