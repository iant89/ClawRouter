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

## 08 · Gateway

A local OpenAI-compatible mock provider behind the alias `fast-chat`. The key in
these screenshots was masked before capture.

| | |
|---|---|
| ![Create key](08-gateway/create-dialog.png) | **Create API key**, limited to the `fast-chat` alias |
| ![Key shown once](08-gateway/key-shown-once.png) | The key is shown once, with copy buttons and a curl example |
| ![Key list](08-gateway/key-list.png) | **API Access** after the key was used: prefix, status, allowed models, last use |
| ![Dashboard](08-gateway/dashboard-metrics.png) | Dashboard **Gateway activity** after 7 requests (live, in memory) |
| ![Revoke](08-gateway/revoke-confirm.png) | Revoking a key; clients get 401 immediately |
| ![Phone](08-gateway/phone.png) | API Access at phone width after revocation |

## 09 · Rate limits

The same mock provider as phase 8, with the alias `fast-chat` (OpenAI first, the
local server second).

| | |
|---|---|
| ![Defaults](09-rate-limits/defaults.png) | **Rate Limits** with the defaults, before any request |
| ![Edit](09-rate-limits/edit-dialog.png) | **Edit rate limits**: 5 requests/min per key, 2/min on `openai/gpt-4o-mini` |
| ![Usage](09-rate-limits/usage.png) | After 7 requests and 3 invalid keys: the key at its limit (2 refused), the OpenAI model at its limit (traffic moved to the local model), the address that sent invalid keys |
| ![Key limit](09-rate-limits/key-limit-dialog.png) | Giving one key its own limit on the API Access page |
| ![Dashboard](09-rate-limits/dashboard.png) | Dashboard: the **Refused by rate limits** tile |
| ![Phone](09-rate-limits/phone.png) | Rate Limits at phone width |

## 10 · Requests and usage

Mock providers: OpenAI (priced), a local server (no prices) and Google embeddings
(no reported usage), with the alias `fast-chat` (OpenAI first, local second). For a
few requests OpenAI was made to fail, to show retries and failover.

| | |
|---|---|
| ![Requests](10-requests-usage/requests.png) | **Requests**: status, requested → answering model, attempts with retries and failovers, tokens (≈ when estimated), estimated cost |
| ![Detail](10-requests-usage/request-detail.png) | One request: two provider errors on OpenAI, then the local model answered; unknown cost because that model has no prices |
| ![Problems](10-requests-usage/problems-only.png) | **Problems only**: an unknown model (404) and a request every provider failed (502) |
| ![Usage](10-requests-usage/usage.png) | **Usage** for 24 hours: totals and requests over time |
| ![By key](10-requests-usage/usage-by-key.png) | Usage broken down by API key; `+?` marks costs that leave out unpriced requests |
| ![Dashboard](10-requests-usage/dashboard.png) | Dashboard: estimated cost (24 h) and recent failed requests |
| ![Phone](10-requests-usage/phone.png) | Requests at phone width |

## 11 · Real-time

| | |
|---|---|
| ![Live](11-realtime/dashboard-live.png) | The header shows **Live** next to system health; the dashboard says it updates live |
| ![Failure](11-realtime/failure-appeared.png) | Traffic and a failed request appear on the dashboard without a refresh (no polling while live) |
| ![Reconnecting](11-realtime/reconnecting.png) | Server stopped: **Reconnecting**, and the dashboard falls back to refreshing every 5 seconds. It was live again 0.5 s after the restart |
| ![Signed out](11-realtime/signed-out.png) | The session was revoked from another browser: this console was at the sign-in page 0.1 s later |
| ![Rate limits](11-realtime/rate-limits-live.png) | Rate Limits usage following traffic |

## 12 · Health and operations

The health history in these screenshots was **generated** (24 hours of checks every
5 minutes, with a two-hour provider and gateway degradation and a short database
outage) so the timeline has something to show; the most recent changes are the
server's own. Operations are real, against the mock providers (made slow to show
progress and cancellation).

| | |
|---|---|
| ![Now](12-health-operations/health-now.png) | **Health** now: platform, database, providers, gateway (disabled until models exist) and the live channel |
| ![History](12-health-operations/health-history.png) | History for 24 hours: healthy share, changes, and a timeline strip per component |
| ![Changes](12-health-operations/health-changes.png) | Recent status changes with the detail at the time |
| ![Running](12-health-operations/operation-running.png) | **Operations**: "Check all providers" running, progress arriving live |
| ![Cancel](12-health-operations/cancel-confirm.png) | Cancelling a running operation |
| ![Operations](12-health-operations/operations.png) | Afterwards: cancelled, succeeded, and a connection test started from the Providers page |
| ![Phone](12-health-operations/phone-history.png) | Health history at phone width |

## 13 · Logging and audit

Real records from a server that saw sign-ins (two with a wrong password), a
provider created with a wrong key, gateway calls (one failing), and an API key
used both correctly and incorrectly. None of those secrets appear anywhere.

| | |
|---|---|
| ![Logs](13-logging-audit/logs.png) | **Logs**: recent records with level, component and request |
| ![Warnings](13-logging-audit/logs-warnings.png) | Warnings and errors only; filters are kept in the address |
| ![Detail](13-logging-audit/log-detail.png) | A record's full JSON |
| ![Request](13-logging-audit/logs-for-request.png) | Opened from a request's **Logs for this request** |
| ![Audit](13-logging-audit/audit.png) | **Audit**: who did what, when and from where |
| ![Audit detail](13-logging-audit/audit-detail.png) | A failed sign-in: username and reason, never the password; link to its logs |
| ![Phone](13-logging-audit/phone-audit.png) | Audit at phone width |

## 14 · Administration

A real walkthrough: an administrator creates a custom **Support** role and a user
holding it, the user signs in with the temporary password, then the
administrator resets it and changes settings. None of the passwords appear in
the audit log.

| | |
|---|---|
| ![Roles](14-administration/1-roles.png) | **Roles**: built-in roles are locked; Administrator is the only one with every permission |
| ![Create role](14-administration/2-create-role.png) | Creating a custom role with a permission checklist grouped by area |
| ![All refused](14-administration/3-role-all-permissions-refused.png) | A role with every permission cannot be saved: that is the Administrator role |
| ![Create user](14-administration/4-create-user.png) | **Users**: creating a user with a temporary password and a role |
| ![Users](14-administration/5-users.png) | The new user, flagged as on a temporary password |
| ![Forced](14-administration/7-forced-password-change.png) | First sign-in: the user must choose a new password before anything else |
| ![Support console](14-administration/8-support-user-console.png) | The Support user's console: only the pages their role allows |
| ![Reset](14-administration/9-reset-password.png) | Resetting a password (signs the user out everywhere) |
| ![Invalid](14-administration/10-settings-invalid.png) | **Settings**: an out-of-range value is refused |
| ![Settings](14-administration/11-settings.png) | Settings saved; changed values are marked and can be reset to the default |
| ![Change password](14-administration/12-change-password.png) | User menu → Change password |
| ![Phone](14-administration/13-settings-phone.png) | Settings at phone width |
| ![Audit](14-administration/14-audit.png) | The audit trail of all of the above |
