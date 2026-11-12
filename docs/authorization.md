# Authorization (phase 3)

Role-based access control for the administration API and console (spec §16).

## Rules

1. **The server decides.** Every route declares who may call it, and the
   dispatcher checks it before the handler runs. Hiding a menu item is not
   authorization.
2. **Access is declared, not defaulted.** `router.get(path, access, handler)`
   takes a required `access`, so a route without a decision does not compile:
   - `'public'`: no session (health, setup status and setup, sign-in, sign-out);
   - `'authenticated'`: any signed-in user, for their own data only (own session);
   - a permission such as `'sessions.revoke'`: signed in **and** holding it.
3. **No role means no access.** A user without roles can sign in, see the
   dashboard and manage their own sessions, nothing else.
4. **Changes apply immediately.** Roles are read from the database on every
   request, so a role change takes effect on the user's next request without
   signing them out. An open console picks it up within a minute.

Responses: no session → **401** `AUTHENTICATION_ERROR`; session without the
permission → **403** `AUTHORIZATION_ERROR` (logged at info with user and
permission).

## Roles

Built-in roles are defined in code (`packages/authorization/src/roles.ts`), so a
permission added in a later phase reaches ADMIN automatically and the built-ins
are identical on every installation. The `roles` table records which roles
exist; `user_roles` records who holds them.

| Permission | Administrator | Operator | Viewer |
|---|:-:|:-:|:-:|
| `providers.read` / `models.read` / `routing.read` | ✔ | ✔ | ✔ |
| `providers.write` / `models.write` / `routing.write` | ✔ | ✔ | |
| `requests.read`, `usage.read`, `health.read` | ✔ | ✔ | ✔ |
| `logs.read`, `audit.read` | ✔ | ✔ | |
| `api_keys.read` / `api_keys.write` | ✔ | | |
| `users.read` / `users.write` | ✔ | | |
| `roles.read` / `roles.assign` | ✔ | | |
| `sessions.read` / `sessions.revoke` | ✔ | | |
| `settings.read` / `settings.write` | ✔ | | |

Decisions beyond the spec text:

- **Viewer** is read-only on gateway configuration and activity, but does not get
  `logs.read` or `audit.read`: logs and the audit trail can expose
  security-relevant detail (IP addresses, usernames, failed sign-ins).
- **API keys** are administrator-only. The spec's Operator list does not include
  API access, and keys grant access to the data plane.
- Users may hold several roles; permissions are the union.

## Endpoints

| Method | Path | Requires | Purpose |
|---|---|---|---|
| GET | `/api/roles` | `roles.read` | Roles with their permissions and member counts |
| GET | `/api/users` | `users.read` | Users with their roles (never password hashes) |
| PUT | `/api/users/:id/roles` | `roles.assign` | `{ roles: [...] }`: replace a user's roles |
| GET | `/api/sessions` | `sessions.read` | All live sessions |
| DELETE | `/api/sessions/:id`, POST `/api/sessions/revoke` | `sessions.revoke` | Revoke sessions |

`GET /api/auth/session` (and the login and setup responses) include the caller's
`roles` and effective `permissions`, so the console can adapt. The console only
uses them to decide what to show.

## Safeguards

- **At least one active administrator.** A change that would remove ADMIN from
  the last *active* administrator is refused with **409**. Disabled
  administrators do not count.
- **Unknown roles** are rejected (400); duplicates are ignored.
- **Every change is audited** as `ROLE_CHANGED` with the before and after role
  lists and the actor. No-op saves are not audited. The event bus emits
  `user.roles_changed`.
- **Setup** grants ADMIN to the first user in the same transaction that creates
  them.

## Upgrading an existing installation

Migration `0004_roles` creates the built-in roles and makes the **initial
administrator** ADMIN: the actor of the `SETUP_COMPLETED` audit record, or the
oldest user if there is none. Any other existing user starts with **no role**
(fail closed). Assign roles under Administration → Users.

## Console

- Navigation shows only the pages the user's permissions allow, and drops empty
  groups. Opening a hidden page directly shows a "no access" page.
- Administration → **Users**: users and their roles; *Edit roles* with
  `roles.assign`.
- Administration → **Roles**: the roles and a permission matrix.
- The header shows the user's roles; users without a role see a notice on the
  dashboard.

## Not yet

- Creating, disabling and deleting users, and password reset (phase 14).
- Custom roles (future): the schema allows them, and they currently grant nothing.
