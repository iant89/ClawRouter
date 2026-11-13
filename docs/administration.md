# Administration

Phase 14 completes the control plane: custom roles, user management, password
recovery, and system and security settings. Permission basics and the built-in
roles are in [authorization](authorization.md); sign-in and sessions in
[authentication](authentication.md).

## Custom roles

Besides the built-in **Administrator**, **Operator** and **Viewer**, users with
`roles.write` can create roles with any chosen set of permissions
(Administration → Roles → *Create role*, or *Duplicate as new role* on an
existing one).

The owner's rules, enforced by the server (`packages/authorization/src/service.ts`)
and guarded by `packages/api/test/roles-api.test.ts`:

- **Administrator is fixed and unique.** It cannot be edited, renamed or deleted
  (409), and **no other role may have every permission** (400: "only the
  Administrator role may have every permission"). A custom role may not take the
  name "Administrator" either (names are unique, case-insensitively).
- **Operator and Viewer are fixed defaults.** They cannot be changed or deleted;
  duplicate one to make a variant.
- **No escalation.** An actor can only create, change or delete roles whose
  permissions they hold themselves, and only assign or remove roles within their
  own permissions. So only administrators can give or take away Administrator.
- A custom role needs at least one permission and a 1–64 character name.
- **Changes reach members at once.** Permissions are resolved on every request;
  members' open consoles and live connections are refreshed (`user.roles_changed`).
- A role that someone still holds cannot be deleted (409). Give them another role first.

Built-in role permissions live in code (`roles.ts`); custom role permissions are
stored in `role_permissions` (migration `0013`). Unknown permission names in the
table are ignored. Every change is audited (`ROLE_CREATED`, `ROLE_UPDATED` with
added/removed permissions and a rename, `ROLE_DELETED`) and sent on the live
channel as `role.changed` to users with `roles.read`.

| Method | Path | Requires | Purpose |
|---|---|---|---|
| POST | `/api/roles` | `roles.write` | `{ name, description?, permissions }` |
| PATCH | `/api/roles/:id` | `roles.write` | Change name, description and/or permissions of a custom role |
| DELETE | `/api/roles/:id` | `roles.write` | Delete a custom role nobody holds |

## Users

With `users.write` (Administration → Users):

- **Create** a user with a username, display name, **temporary password** and
  roles. The console can generate a readable random password; pass it on through
  a trusted channel, because it is never shown again.
- **Change the display name.** Usernames do not change.
- **Disable / enable.** Disabling ends all the user's sessions and refuses
  sign-in. Nobody can disable themselves, and the last active administrator
  cannot be disabled.
- **Reset password** to a new temporary password. The user is signed out
  everywhere. You cannot reset your own password this way (use *Change password*).

**No escalation**: you can only disable, rename or reset users whose permissions
you hold yourself (otherwise a user manager could take over an administrator's
account), and new users can only get roles within your own permissions.

**Temporary passwords.** New accounts and resets set *must change password*. Until
the user picks their own password, the API answers every call except
`GET /api/auth/session`, `POST /api/auth/password` and `POST /api/auth/logout`
with 403 (`details.reason: "password_change_required"`), the live channel refuses
the connection, and the console shows only the *Choose a new password* screen.

**Changing your own password** (user menu → *Change password*,
`POST /api/auth/password`) needs the current password. Wrong guesses count
towards the sign-in throttle for that username. Your other sessions end; the
current one stays. New passwords follow the same policy as setup (12+
characters, not containing the username, at least 4 different characters).

Audit: `USER_CREATED`, `USER_UPDATED`, `USER_ENABLED`, `USER_DISABLED`,
`PASSWORD_RESET`, `PASSWORD_CHANGED` (also a FAILURE record for a wrong current
password). Passwords never appear in audit records, logs or responses. Live
event: `user.changed` (to `users.read`).

| Method | Path | Requires | Purpose |
|---|---|---|---|
| POST | `/api/users` | `users.write` | `{ username, displayName, password, roles }` |
| PATCH | `/api/users/:id` | `users.write` | `{ displayName?, status?: "ACTIVE" \| "DISABLED" }` |
| POST | `/api/users/:id/password` | `users.write` | `{ password }`: temporary password, signs the user out |
| POST | `/api/auth/password` | signed in | `{ currentPassword, newPassword }` |

## Lost password recovery

There is no web "forgot password". Whoever runs the server recovers an account
from its command line, with the same configuration as the server
(`CLAWROUTER_DATABASE_PATH` etc.):

```bash
bun run reset-password <username>            # new temporary password; sessions ended
bun run reset-password <username> --enable   # also re-enables a disabled account
```

It prints a random temporary password once (it is not logged), and the user must
change it at the next sign-in. The audit log records `PASSWORD_RESET` by
"command line" (`via: cli`). It works while the server runs: sessions are checked
in the database on every request, and open live connections close within about
30 seconds. Run `bun run migrate` first if the database has pending migrations.

## Settings

Administration → Settings (`settings.read` to view, `settings.write` to change):

| Setting | Default from | Range | Takes effect |
|---|---|---|---|
| Session idle timeout (minutes) | `CLAWROUTER_SESSION_IDLE_MINUTES` (60) | 1–10080 | At once, also for existing sessions |
| Maximum session length (hours) | `CLAWROUTER_SESSION_MAX_HOURS` (12) | 1–720 | For new sessions |
| Failed sign-ins before blocking | built in (10) | 3–100 | At once (per username, 15-minute window and block) |
| Request history (days, 0 = forever) | `CLAWROUTER_REQUEST_RETENTION_DAYS` (30) | 0–3650 | Next hourly cleanup |
| Usage records (days, 0 = forever) | `CLAWROUTER_USAGE_RETENTION_DAYS` (400) | 0–3650 | Next hourly cleanup |
| Health history (days, 0 = forever) | `CLAWROUTER_HEALTH_HISTORY_DAYS` (7) | 0–365 | Next hourly cleanup |
| Maximum key lifetime (days), for keys not created by an Administrator | built in (30) | 1–3650 | For new keys (see [self-service keys](self-service-keys.md#maximum-key-lifetime-by-creator)) |

The environment provides the defaults. **A value changed in the console takes
precedence** until it is reset to the default. Values are stored in the
`settings` table under `system.*` keys; a stored value outside the allowed range
(e.g. edited by hand) is ignored with a warning. Services read settings at use
time (`packages/settings`), so no restart is needed. Changes are audited as one
`SETTINGS_CHANGED` record with before/after values and sent live as
`settings.changed` (to `settings.read`). `PUT /api/settings` takes
`{ values: { key: number | null } }`; `null` resets a setting. A request with any
invalid value changes nothing.

Not configurable here (on purpose or for now): the password policy, the per-IP
sign-in limit (50 per 15 minutes), the gateway's rate limits (Gateway → Rate
Limits), and secrets of any kind.

## Screenshots

[`docs/screenshots/14-administration`](screenshots/README.md#14--administration).
