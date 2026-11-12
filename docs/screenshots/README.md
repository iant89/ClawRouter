# Screenshots

Captured in Chromium (Playwright) while each phase was built and verified.

> **Taken before the rename:** the header in these images says **ClawAPI**, the
> project's former name. The screens are otherwise current unless noted below.
> Providers and models point at a local mock of each provider API, not real
> providers.

## 01 · First milestone

| | |
|---|---|
| ![Dashboard](01-milestone/dashboard.png) | **Dashboard** with live platform and database health. Includes the development notice later removed by phase 2 |
| ![Health](01-milestone/health.png) | **Health** page: each component's status, latency and detail |
| ![Dashboard on a phone](01-milestone/dashboard-phone.png) | Dashboard on a phone (navigation becomes a drawer) |
| ![Placeholder page](01-milestone/planned-page-placeholder.png) | Placeholder for a page whose phase was not built yet (Providers, before phase 5) |

## 02 · Authentication and session revocation

| | |
|---|---|
| ![Setup](02-authentication/auth-1-setup.png) | Initial setup: first visit redirects to `/setup` |
| ![Setup errors](02-authentication/auth-2-setup-errors.png) | Setup validation with an error summary |
| ![Dashboard after setup](02-authentication/auth-3-dashboard.png) | Signed in after setup |
| ![My sessions](02-authentication/auth-4-sessions.png) | **My sessions** dialog |
| ![Signed out](02-authentication/auth-5-signed-out.png) | Signed out |
| ![Deep link](02-authentication/auth-6-login-deeplink.png) | Sign-in for a deep link (`?next=/health`) |
| ![Failed sign-in](02-authentication/auth-7-login-failed.png) | Failed sign-in: generic message |
| ![Back on the requested page](02-authentication/auth-8-health-after-login.png) | Returned to the requested page after sign-in |
| ![Phone sign-in](02-authentication/auth-9-mobile-login.png) | Sign-in on a phone |
| ![Sessions](02-authentication/revoke-1-sessions.png) | **Administration → Sessions**: all users' sessions |
| ![Confirm](02-authentication/revoke-2-confirm.png) | Confirmation before signing out another user's session |
| ![After revoking](02-authentication/revoke-3-after.png) | After revoking one session |
| ![Revoked user](02-authentication/revoke-4-bob.png) | The revoked user's browser is back at sign-in |
| ![Revoke all](02-authentication/revoke-5-all.png) | All sessions of a user signed out |
| ![Sign out other sessions](02-authentication/revoke-6-mysessions.png) | "Sign out all other sessions" |

Before phase 3, the Sessions page showed a notice that every signed-in user could
manage sessions. That notice is gone now that the page requires
`sessions.read` / `sessions.revoke`.

## 03 · Authorization (RBAC)

| | |
|---|---|
| ![No access](03-authorization/1-viewer-noaccess.png) | A Viewer opening `/users` directly: no-access page |
| ![No role](03-authorization/2-norole.png) | A user without a role: only the dashboard, with a notice |
| ![Roles](03-authorization/3-roles.png) | **Roles** with the permission matrix |
| ![Users](03-authorization/4-users.png) | **Users** and their roles |
| ![Edit roles](03-authorization/5-edit.png) | Editing a user's roles |
| ![Last administrator](03-authorization/6-last-admin.png) | Removing the last administrator is refused |

## 04 · Console shell

| | |
|---|---|
| ![Notifications](04-console-shell/notifications-panel.png) | Notifications panel (severity in words) |
| ![Toast](04-console-shell/notification-toast.png) | A new warning arriving as a toast |
| ![Phone](04-console-shell/touch-phone.png) | Touch screens: about 44px targets |

## 05 · Providers

| | |
|---|---|
| ![Add provider](05-providers/add-dialog.png) | Add provider; the API key is write-only. At the time it showed a password-strength meter, since removed |
| ![Providers](05-providers/list.png) | Providers: healthy, offline (wrong key), not checked (no key). At this width the table overflowed; fixed in `list-wide` / `list-laptop` |
| ![Host change refused](05-providers/endpoint-host-change-refused.png) | Moving a provider to another host without re-entering its key is refused |
| ![Details](05-providers/details-history.png) | Provider details and check history |
| ![Wide](05-providers/list-wide.png) | Providers at 1400px |
| ![Laptop](05-providers/list-laptop.png) | Providers at 1180px, before columns were allowed to wrap |

## 06 · Models

| | |
|---|---|
| ![Discover](06-models/discover.png) | **Discover models**: pick models to import from a provider |
| ![Models](06-models/list.png) | Models after importing from two providers and adding one by hand |
| ![Edit](06-models/edit.png) | Editing capabilities, context length and prices |
| ![Provider disabled](06-models/provider-disabled.png) | A model is unusable while its provider is disabled. Shows the old formatting ("125K", "$0.6") |
| ![Models, final](06-models/list-final.png) | Same list after the formatting fix ("128K", "$0.60") |

## 07 · Routing

Taken after the rename: these show **ClawRouter**.

| | |
|---|---|
| ![Empty](07-routing/empty.png) | **Routing** before any alias: the default failover policy and the route tester |
| ![Alias dialog](07-routing/alias-dialog.png) | Adding `fast-code`: a primary at priority 0, two fallbacks sharing priority 1 by weight (3:1), CODING required |
| ![Aliases and preview](07-routing/aliases-and-preview.png) | A target alias and a capability alias (`embed`); the route tester showing the attempt sequence (retry, then fail over, capped at 3) |
| ![Problems](07-routing/problems.png) | All providers disabled: both aliases reported as not routable. The Policy column was later widened so "Default" no longer wraps |
