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

## 15 · Security

Most of phase 15 is invisible (headers, limits, tests; see
[security](../security.md)). The console change: an API key whose owner was
disabled is suspended until the owner is enabled again.

| | |
|---|---|
| ![Suspended key](15-security/suspended-key.png) | **API Access**: a key created by a user who was then disabled shows as suspended and is refused by `/v1` |

## 16 · Self-service API keys

A Viewer (Val) requests a key, the administrator is notified and approves it
with a shorter lifetime, and Val creates the key. A user with `api_keys.own`
(Devon, a custom Developer role) creates a key that works until midnight. The
browser ran in the America/New_York time zone. The key in picture 7 was masked
before the screenshot.

| | |
|---|---|
| ![Request](16-self-service-keys/1-request-key.png) | **My API keys** → *Request a key*: name, purpose and how long it should work |
| ![Waiting](16-self-service-keys/2-request-waiting.png) | The request waits for approval |
| ![Notified](16-self-service-keys/3-approver-notified.png) | The administrator (no shared role) is notified |
| ![Requests](16-self-service-keys/4-key-requests.png) | **API Access → Key requests** |
| ![Approve](16-self-service-keys/5-approve.png) | Approving with a shorter expiry and a note; the approver never sees the key |
| ![Approved](16-self-service-keys/6-request-approved.png) | The requester is told and can create the key |
| ![Created](16-self-service-keys/7-key-from-request.png) | The key, shown once, to the requester only |
| ![End of day](16-self-service-keys/8-own-key-end-of-day.png) | With `api_keys.own`: a key for today only, expiring at local midnight |
| ![Own keys](16-self-service-keys/9-own-keys.png) | Your own keys |
| ![Phone](16-self-service-keys/11-my-keys-phone.png) | My API keys at phone width |
| ![Provider limit](16-self-service-keys/12-1-provider-key-lifetime.png) | **Maximum key lifetime** on a provider (30 days) |
| ![Model limit](16-self-service-keys/12-2-model-key-lifetime.png) | A model with a stricter limit (7 days); the dialog notes the provider's |
| ![Models](16-self-service-keys/12-3-models-key-lifetime.png) | The Models table shows the limit that applies |
| ![Refused](16-self-service-keys/12-4-key-refused.png) | A never-expiring key for that model is refused, with the reason |

## 17 · Two-factor sign-in

The administrator adds an email address, sets up a mail server (a local test
server) and requires two-factor sign-in for everyone. Both users must then set it
up before anything else: Ada with an authenticator app, Olive with email codes.
The setup key and codes in the pictures came from a throwaway test database.

| | |
|---|---|
| ![Sign-in security](17-two-factor/1-sign-in-security-dialog.png) | User menu → **Sign-in security** |
| ![Mail server](17-two-factor/2-mail-server.png) | **Settings → Mail server**, saved and tested |
| ![Policy](17-two-factor/3-two-factor-policy.png) | **Settings → Two-factor sign-in**: allowed methods and who must use it |
| ![Forced setup](17-two-factor/4-forced-setup-authenticator.png) | Required but not set up: only the setup screen (authenticator app) |
| ![Recovery codes](17-two-factor/5-recovery-codes.png) | Recovery codes, shown once |
| ![Email setup](17-two-factor/6-forced-setup-email.png) | Setting up email codes |
| ![Email step](17-two-factor/7-second-step-email.png) | Signing in: a code by email |
| ![App step](17-two-factor/8-second-step-app.png) | Signing in: a code from the app |
| ![Users](17-two-factor/9-users-two-factor.png) | **Users** shows each user's methods |
| ![Reset](17-two-factor/10-reset-two-factor.png) | Resetting a user's two-factor sign-in |
| ![Phone](17-two-factor/11-second-step-phone.png) | The second step at phone width |

## 18 · Maximum key lifetime by creator

Administrators may create keys that never expire; everyone else is limited by a
setting (here lowered to 14 days). Devon has a custom Developer role with `api_keys.own`.

| | |
|---|---|
| ![Setting](18-key-lifetime-by-role/1-setting.png) | **Settings → API keys**: *Maximum key lifetime* (default 30 days) |
| ![Too long](18-key-lifetime-by-role/2-own-key-too-long.png) | Devon: no "Never", and 30 days is more than the limit |
| ![Within](18-key-lifetime-by-role/3-own-key-within-limit.png) | Within the limit |
| ![Lowering](18-key-lifetime-by-role/4-lowering-lists-keys.png) | Lowering the limit to 14 days lists the active keys that outlast it, with their owners (the administrator's never-expiring key is not limited, so not listed) |
| ![Saved](18-key-lifetime-by-role/5-after-saving.png) | After saving, the list stays until those keys expire or are revoked |
| ![Revoke](18-key-lifetime-by-role/6-revoke-from-table.png) | Users with `api_keys.write` can revoke a key from the table (after confirming); it leaves the list at once |

## 19 · Performance

A production build with 120 API keys and a mock provider offering 400 models. See
[performance](../performance.md) for the measurements.

| | |
|---|---|
| ![Paged](19-performance/1-api-access-paged.png) | **API Access** pages on the server: 50 of 120 keys, with search and a status filter |
| ![Search](19-performance/2-api-access-search.png) | Searching by name (30 matches) |
| ![Key picker](19-performance/3-requests-key-picker.png) | **Requests**: the key filter searches keys as you type |
| ![Discover](19-performance/4-discover-virtualized.png) | **Discover models** with 400 models: only the visible rows are rendered |
| ![Updated](19-performance/5-updated-reload.png) | After an upgrade, an open console that asks for a page file from the old build offers a reload |

## 20 · Production

Two servers built from the production bundle: the configuration of the first one
(three providers, five models, an alias, a custom role, two settings) is exported and
imported into a newly set-up second one. See [deployment](../deployment.md).

| | |
|---|---|
| ![Card](20-production/1-configuration-card.png) | **Settings → Configuration**: export downloads one JSON file, never with secrets |
| ![Preview](20-production/2-import-preview.png) | Importing shows what would change first; an import creates and updates, never deletes |
| ![Done](20-production/3-import-done.png) | After the import: where the backup taken just before it is, and what is still to do (provider keys) |
| ![Providers](20-production/4-providers-imported.png) | The imported providers on the second server |

## 21 · Settings in tabs

Administration → Settings, organized in tabs (see [administration](../administration.md#settings)).

| | |
|---|---|
| ![Sign-in](21-settings-tabs/1-sign-in-and-sessions.png) | **Sign-in and sessions**: session lifetimes and failed sign-ins, with their save bar, then the two-factor policy |
| ![API keys](21-settings-tabs/2-api-keys.png) | **API keys**: maximum key lifetime (here saved as 14 days) |
| ![Mail](21-settings-tabs/3-mail-server.png) | **Mail server** |
| ![Retention](21-settings-tabs/4-data-retention.png) | **Data retention**, while the first tab has an unsaved edit: the save bar says so |
| ![Import](21-settings-tabs/5-import-and-export.png) | **Import and export**, opened directly with `?tab=configuration` |
| ![Phone](21-settings-tabs/6-phone.png) | At phone width the tab row scrolls sideways; the page does not |
| ![Phone, last tab](21-settings-tabs/7-phone-last-tab.png) | The last tab, scrolled into view |

## 22 · Field help tips

Across the console, each field's explanation moves into a Bootstrap-shaped tooltip (page
colour behind the cards, an accent border and a shadow, centred text, an arrow, centred on the
field) behind an "i" button
inside the field (`components/custom/FieldHelp.tsx`); the allowed range and default
stay under the field. The tip opens on hover, keyboard focus or a tap, and closes on
its own: move away, click elsewhere, start typing, or press Escape.

| | |
|---|---|
| ![Hover](22-field-help/1-hover.png) | Hovering over the "i": the tip sits centred above the field, below when there is no room above |
| ![Kept open](22-field-help/2-pinned.png) | Clicked: it stays open until you click elsewhere or type |
| ![Retention](22-field-help/3-retention-hover.png) | The same on the Data retention tab |
| ![Phone](22-field-help/4-phone-tap.png) | On a phone, a tap opens it; a tap on the tip or anywhere else closes it |
| ![Provider](22-field-help/5-provider.png) | **Add provider**: "i" inside the identifier field, and beside the key lifetime and the API key (controls with their own buttons); the API key tip |
| ![Model](22-field-help/6-model.png) | **Add model**: the price fields share one tip |
| ![Routing](22-field-help/7-routing-policy.png) | **Routing policy**: what counts as a failure |
| ![User](22-field-help/8-create-user.png) | **Create user**: username, email and temporary password |

## 23 · Authenticator setup with a QR code

User menu → Sign-in security → Authenticator app → Set up (a throwaway test account).

| | |
|---|---|
| ![Setup](23-totp-qr/1-setup.png) | The QR code, centred; below it the setup key in a read-only field with a copy icon on its right |
| ![Enlarged](23-totp-qr/2-enlarged.png) | A click on the QR code opens a larger copy in its own dialog (Escape or Close returns to the setup) |
| ![Copied](23-totp-qr/3-copied.png) | The copy icon puts the key on the clipboard (without spaces) and shows a toast |
| ![Phone](23-totp-qr/4-phone-enlarged.png) | The larger QR code at phone width |

## 24 · Doctor repairs in the audit log

`bun run doctor --fix` on a scratch install (a world-readable key file and a stale
process-ID file), then System → Audit.

| | |
|---|---|
| ![Repair](24-doctor-fix/1-audit-repair.png) | A `DOCTOR_REPAIR` record: by "command line", the repair (`key-permissions`) and its outcome |

## 25 · User quotas and rate-limit windows

A scratch server with the mock providers (each answer uses 11 tokens). The
administrator's own key was used to use up a 50-token quota, then to hit a burst bucket.

| | |
|---|---|
| ![Create](25-quotas-rate-limits/1-create-user-quota.png) | Create user: an optional usage quota (tokens, requests or cost per day, week or month, with the reset day, hour and time zone) |
| ![Used up](25-quotas-rate-limits/2-quota-used-up.png) | Users → Usage quota: where the user stands, and the quota's settings |
| ![Own](25-quotas-rate-limits/3-own-quota.png) | API Access: users see their own quota |
| ![Dialog](25-quotas-rate-limits/4-rate-limit-dialog.png) | Edit rate limits: a window per limit (second, minute, hour) and an optional token bucket |
| ![Page](25-quotas-rate-limits/5-rate-limits-page.png) | Rate Limits: the window, and how much of the burst bucket is left |
| ![Phone](25-quotas-rate-limits/6-create-user-quota-phone.png) | The create dialog at phone width |
| ![Setting](25-quotas-rate-limits/7-settings-enforce-quotas.png) | Settings → API keys and quotas: **Enforce user quotas** turns every quota off at once |
| ![Off](25-quotas-rate-limits/8-quota-turned-off.png) | One quota turned off (**Enforce this quota**), with the notice shown while all quotas are off |
## 26 · Groq provider

A scratch server; the Groq provider was then pointed at the mock providers (no real
Groq account was used).

| | |
|---|---|
| ![Add](26-groq/1-add-groq.png) | Add provider → Groq: the endpoint defaults to `https://api.groq.com/openai/v1`, an API key is required |
| ![Tested](26-groq/2-groq-tested.png) | The connection test lists the models and marks the provider healthy |

## 27 · MCP server

A scratch production build on 2026-11-16, with one real Groq request in its history
(the keys shown belong to that scratch server, which no longer exists). See
[MCP server](../mcp.md).

| | |
|---|---|
| ![Column](27-mcp-server/01-api-access-mcp-column.png) | API Access: the MCP column ("Allowed" / "No", in words) |
| ![Switch](27-mcp-server/02-create-key-mcp-switch.png) | Create key: "Allow MCP access" switch, off by default |
| ![Help](27-mcp-server/03-mcp-field-help.png) | Its "i" tip: what MCP access allows and whose permissions apply |
| ![Created](27-mcp-server/04-key-created-mcp-setup.png) | The key is shown once, with a Claude Code command and an `mcpServers` configuration |
| ![Toggle](27-mcp-server/05-mcp-turned-on.png) | Turning MCP access on from a key's menu |
| ![Phone](27-mcp-server/06-api-access-phone.png) | The same page at phone width (no horizontal scroll) |
| ![Off](27-mcp-server/07-api-access-mcp-off.png) | With the MCP server off (the default): no MCP column, hint or switch anywhere |
| ![Setting](27-mcp-server/08-settings-mcp-switch.png) | Settings → API keys and quotas: the MCP server switch, off by default |

## 28 · First-run setup wizard and guided tour

A scratch production build on 2026-11-16. The provider is the real Groq API (the key is a
network secret of the development environment), so the test request is a real answer.
See [onboarding](../onboarding.md).

| | |
|---|---|
| ![Provider](28-onboarding/01-wizard-provider.png) | Right after the first administrator: the wizard's first step |
| ![Connected](28-onboarding/03-wizard-provider-connected.png) | Groq added and tested at once |
| ![Models](28-onboarding/04-wizard-models.png) | Models imported (chat models preselected in discovery) |
| ![Key](28-onboarding/05-wizard-api-key.png) | An API key created (shown once in its dialog; only the prefix here) |
| ![Test](28-onboarding/06-wizard-test-request.png) | A real request through the gateway with that key: answer, latency, tokens, request id |
| ![Mail](28-onboarding/07-wizard-mail.png) | Mail server (the Settings card), skippable |
| ![Sign-in](28-onboarding/08-wizard-sign-in.png) | Two-factor policy (the Settings card) |
| ![Phone](28-onboarding/09-wizard-phone.png) | The wizard at phone width: every step fits one row; the heading names the current one |
| ![Welcome](28-onboarding/10-tour-welcome.png) | After Finish setup: the tour's welcome, centred |
| ![Gateway](28-onboarding/12-tour-the-gateway.png) | A step pointing at an area in the sidebar, describing its pages |
| ![Admin](28-onboarding/15-tour-administration.png) | Administration, only for roles that can open it |
| ![Help](28-onboarding/18-tour-help.png) | The last step: where to replay it |
| ![Help menu](28-onboarding/19-help-menu.png) | Help menu: take the tour, run the setup wizard |
| ![Viewer](28-onboarding/20-tour-viewer-gateway.png) | A Viewer's tour: only the pages a Viewer can open |
| ![Phone tour](28-onboarding/21-tour-phone.png) | At phone width the sidebar is collapsed, so steps are centred |

## 29 · Theme selection

A scratch production build on 2026-11-17, with two real Groq requests for data. See
[console shell → Theme](../console-shell.md#theme).

| | |
|---|---|
| ![Dialog](29-theme/01-appearance-dialog-dark.png) | User menu → Appearance: Dark (the default), Light, System |
| ![Light](29-theme/02-appearance-dialog-light.png) | Light applies at once, before the dialog closes |
| ![Dashboard](29-theme/03-dashboard-light.png) | The dashboard in light |
| ![Providers](29-theme/04-providers-light.png) | Providers |
| ![Requests](29-theme/05-requests-light.png) | Requests |
| ![Usage](29-theme/06-usage-light.png) | Usage, charts included |
| ![API Access](29-theme/07-api-access-light.png) | API Access |
| ![Field help](29-theme/08-settings-field-help-light.png) | The field help tip: the theme's own shadow on light |
| ![Tour](29-theme/09-tour-light.png) | The guided tour in light |
| ![Sign in](29-theme/10-sign-in-light.png) | After signing out: the sign-in page keeps this browser's last choice |
| ![Phone](29-theme/11-dashboard-phone-light.png) | Phone width, light |
| ![Toggle, dark](29-theme/12-header-toggle-dark.png) | The header toggle next to the bell (sun: switch to light) |
| ![Toggle, light](29-theme/13-header-toggle-light.png) | After toggling (moon: switch back to dark) |
| ![Phone menu](29-theme/14-phone-toggle-in-menu.png) | Phone width: the toggle sits in the "⋯" menu; Uptime ticking |

## 30 · Provider captures

Captured 2026-11-17 against the mock providers (a failover from a provider answering 500, an
HTML reply where JSON was expected, and a manual capture of a stream). See
[`docs/captures.md`](../captures.md).

| Screenshot | Shows |
| --- | --- |
| ![Off](30-captures/01-captures-off.png) | Off by default: nothing is recorded, with a link to Settings |
| ![Settings](30-captures/02-settings-retention.png) | Settings → Data retention: the switch and how many are kept |
| ![List](30-captures/03-captures-list.png) | A provider error (the client still got an answer after failover) and an unreadable reply |
| ![Detail](30-captures/04-capture-detail.png) | One capture: outcome, then each provider call with headers (credentials removed) |
| ![Bodies](30-captures/05-capture-detail-bodies.png) | The body sent to the provider and its raw reply |
| ![Export](30-captures/07-export-dialog-masked.png) | Export with "Mask message text" |
| ![Selected](30-captures/08-list-selected.png) | Several captures selected for one file |
| ![Manual](30-captures/09-manual-dialog.png) | Capture the next requests: provider, model, count, time limit |
| ![Running](30-captures/10-manual-running.png) | A manual capture running, with Stop |
| ![Light](30-captures/11-captures-light.png) | Light theme |
| ![Unreadable](30-captures/12-detail-light-unreadable.png) | An unreadable reply: the raw HTML ClawRouter could not parse |
| ![Phone](30-captures/13-phone.png) | Phone width |
| ![Live list](30-captures/14-live-list.png) | Live against Groq (2026-11-17): an unknown model, a failover and a manual capture of a stream |
| ![Live failover](30-captures/15-live-failover.png) | Groq's real 404 for a model it does not have, before the failover answered |
| ![Live reply](30-captures/16-live-failover-reply.png) | The raw replies Groq sent |
| ![Live stream](30-captures/17-live-stream.png) | A manual capture of a streamed tool call on Groq's Qwen |

## 31 · Client notices and announcements

Captured 2026-11-17 with a live Groq provider. See [`docs/notices.md`](../notices.md).

| Screenshot | Shows |
| --- | --- |
| ![Settings](31-notices/01-settings-notices.png) | Settings → Client notices: header, reply text, cleanup, repeat interval |
| ![Messages](31-notices/02-settings-messages.png) | The editable default messages |
| ![Empty](31-notices/03-announcements-empty.png) | Administration → Announcements, empty |
| ![Dialog](31-notices/04-announcement-dialog.png) | A new announcement: message, how often, where, start, expiry, time zone |
| ![List](31-notices/05-announcements-list.png) | The announcement, active |
| ![Key menu](31-notices/06-key-actions.png) | API Access: turn notices in replies off for one key |
| ![Create key](31-notices/07-create-key-switch.png) | The per-key switch when creating a key |
| ![Reached](31-notices/08-announcements-reached.png) | After live Groq requests: reached 1 user |
| ![Light](31-notices/09-announcements-light.png) | Light theme |
| ![Settings light](31-notices/10-settings-notices-light.png) | Settings tab, light |
| ![Phone](31-notices/11-announcements-phone.png) | Phone width |

Added 2026-11-17 (announcement type and emoji picker; the 🚀 line was then sent live to Groq):

| Screenshot | Shows |
| --- | --- |
| ![Picker](31-notices/12-emoji-picker.png) | The "+" beside the message opens the emoji picker |
| ![Search](31-notices/13-emoji-search.png) | Searching the picker ("party") |
| ![Type](31-notices/14-type-and-preview.png) | The Type combo box (🚀 New feature) and the live preview of the line |
| ![List](31-notices/15-list-with-icon.png) | The list shows each announcement's icon |
| ![Light](31-notices/16-picker-light.png) | The picker in light, editing |
| ![Phone](31-notices/17-picker-phone.png) | Phone width: larger touch targets |
| ![Type open](31-notices/18-type-open-on-click.png) | The Type box opens on a click and cannot be typed in (ENTERPRISE-UI ComboBox `editable={false}` and `openOnClick`) |

## 32 · Components moved to ENTERPRISE-UI

Captured 2026-11-17 on a production build, after FieldHelp, EmojiPicker, the health history
strip (now `StatusHistory`), the page error boundary (`ErrorBoundary`) and the icon-only copy
button (`CopyButton iconOnly`) moved from `components/custom/` into ENTERPRISE-UI. They should
look and behave as before.

| Screenshot | Shows |
| --- | --- |
| ![Dialog](32-design-system-components/01-field-help-dialog.png) | Field help in the Add provider dialog (Escape closes the tip, not the dialog) |
| ![Settings](32-design-system-components/02-field-help-settings.png) | Field help beside a number field in Settings, opened by hover |
| ![Emoji](32-design-system-components/03-emoji-picker.png) | The emoji picker in the announcement dialog, searching "tools" |
| ![Health](32-design-system-components/04-health-status-history.png) | Health history strips (`StatusHistory`), a few minutes after start |
| ![Copy](32-design-system-components/05-copy-setup-key.png) | The setup key copied: check mark in the field and a toast |
| ![Light](32-design-system-components/06-field-help-light.png) | Field help in the light theme |

## 33 · Playground and chat apps

Captured 2026-11-18 on a development server. The provider is the project's mock OpenAI server
(`tests/support/mock-providers.ts`), so answers are short fixed texts; the health badge says
"Degraded" because the mock provider was never checked. Open WebUI 0.13.4 and LibreChat v0.8.9
were pointed at that ClawRouter, with an every-request announcement for the notice pictures.

| Screenshot | Shows |
| --- | --- |
| ![Answer](33-playground/01-streamed-answer.png) | A streamed answer with the model, tokens and timing; the chat apps card below |
| ![Details](33-playground/02-request-details.png) | Request details from an answer through the `chat` alias, as the "Chat apps" key |
| ![Config](33-playground/03-client-configuration.png) | LibreChat's configuration, filled in with this server's address |
| ![Light](33-playground/04-light.png) | Light theme |
| ![Phone](33-playground/05-phone.png) | Phone width: settings above the conversation |
| ![No keys](33-playground/06-no-keys.png) | An Operator without keys: how to get one |
| ![Open WebUI](33-playground/07-open-webui-chat.png) | Open WebUI on ClawRouter: its built-in time tool called through ClawRouter, then the answer |
| ![Builtin Tools](33-playground/08-open-webui-builtin-tools.png) | Open WebUI's Builtin Tools switch, turned off so notices appear |
| ![Open WebUI notice](33-playground/09-open-webui-notice.png) | The announcement at the start of an Open WebUI reply |
| ![LibreChat](33-playground/10-librechat-chat.png) | LibreChat on ClawRouter, with the announcement in the reply and the title |

Added 2026-11-19, live with a Groq provider behind ClawRouter (the `chat` alias on
`groq/openai/gpt-oss-20b`), the every-request announcement still on:

| Screenshot | Shows |
| --- | --- |
| ![Playground on Groq](33-playground/11-live-playground-groq.png) | The playground streaming a Groq answer: model, tokens and timing, the announcement as a notice |
| ![Open WebUI on Groq](33-playground/12-live-open-webui-groq.png) | Open WebUI with a Groq answer, Groq-written follow-ups and the announcement line |
| ![LibreChat on Groq](33-playground/13-live-librechat-groq.png) | LibreChat with a Groq answer; the title also starts with the announcement |

## 34 · Anthropic Messages API

Captured 2026-11-19 on a development server after Claude Code 2.1.328 and the Anthropic SDK ran
against it (Groq, and the mock OpenAI server for Claude Code's full request; "Degraded" comes
from the mock provider, which was never health-checked).

| Screenshot | Shows |
| --- | --- |
| ![Apps](34-anthropic-messages/01-apps-card.png) | The playground's apps card, now with Claude Code |
| ![Config](34-anthropic-messages/02-claude-code-configuration.png) | Claude Code's configuration, filled in with this server's address (no `/v1`) |
| ![Detail](34-anthropic-messages/03-request-detail-messages.png) | A request from Claude Code in the history: endpoint `/v1/messages (stream)` |

## 35 · Native Gemini adapter

Captured 2026-11-19 against Google's real model list (65 models). "Degraded" in the header comes
from a leftover mock provider in the development database.

| Screenshot | Shows |
| --- | --- |
| ![Discover](35-gemini-native/01-discover-classified.png) | Discovery: Antigravity, Deep Research, computer use and Nano Banana detected as "other"; chat models with vision and tool use |
| ![Filtered](35-gemini-native/02-discover-filtered.png) | Filtered to "3.5": the two chat models (registered) beside live-translate, transcription and Lyria (music), detected as "other" |

## 36 · OpenRouter provider

Captured 2026-11-19 against OpenRouter's real model list (445 models) and live requests on free
models. "Degraded" in the header comes from a leftover mock provider in the development database.
The detail dialog was captured before its "Estimated cost" label became "Cost" (the provider's
own charge when it reports one).

| Screenshot | Shows |
| --- | --- |
| ![Add](36-openrouter/01-add-provider.png) | Add provider with the OpenRouter type: the endpoint is filled in |
| ![Discover](36-openrouter/02-discover.png) | Discovery filtered to "claude-haiku": chat models with vision and tools, the `:batch` variant detected as "other" |
| ![Cost](36-openrouter/03-request-reported-cost.png) | A PDF request to a free model: OpenRouter charged $0.002 (its PDF reading), recorded instead of the $0 estimate |

## 37 · Prices in model discovery

Captured 2026-11-19 against OpenRouter's real model list (445 models) and Google's (no published
prices). "Degraded" in the header comes from a leftover mock provider in the development database.

| Screenshot | Shows |
| --- | --- |
| ![Ascending](37-discovery-prices/01-price-ascending.png) | Sorted by price, cheapest first: free models with the Free badge; Lyria (music) detected as "other" |
| ![Descending](37-discovery-prices/02-price-descending.png) | Sorted by price, most expensive first: input · output per million tokens |
| ![Free only](37-discovery-prices/03-free-only.png) | Free only (17): the import button counts only the 12 visible, checked models; 353 hidden selections are named |
| ![No prices](37-discovery-prices/04-no-published-prices.png) | Google publishes no prices: no Price column and no switch |

## 38 · Reasoning in the playground

Captured 2026-11-19 live with Groq's gpt-oss-20b, which sends its reasoning in a separate field.

| Screenshot | Shows |
| --- | --- |
| ![Collapsed](38-reasoning/01-reasoning-collapsed.png) | The answer with its reasoning collapsed above it |
| ![Expanded](38-reasoning/02-reasoning-expanded.png) | The Reasoning panel opened |
| ![Light](38-reasoning/03-light.png) | Light theme |

## 39 · Turning the playground off, and its permission

Captured 2026-11-19. The "Support" custom role was created on the previous version; the upgrade
(migration 0026) gave it `playground.use`.

| Screenshot | Shows |
| --- | --- |
| ![Setting](39-playground-switch/01-setting.png) | Settings → API keys and quotas → Playground |
| ![Permission](39-playground-switch/02-permission.png) | `playground.use` in the permission matrix, for every role including the custom one |
| ![Off](39-playground-switch/03-off.png) | Switched off: no Playground in the menu; `/playground` opened directly says it has been disabled |

## 40 · Cost limits and request limits (SEC-005, SEC-006)

Captured 2026-11-20 on a scratch install. The spending figures come from usage records inserted by a
script (no providers were configured), and the "anthropic" provider row shows $0.00 because no
provider with that identifier existed.

| Screenshot | Shows |
| --- | --- |
| ![Page](40-cost-request-limits/01-rate-limits-page.png) | Gateway → Rate Limits with the Cost limits card, current spending, and the Request limits card |
| ![Cost limits](40-cost-request-limits/02-edit-cost-limits.png) | Edit cost limits: per key, user, gateway, per request, per model and provider |
| ![Request limits](40-cost-request-limits/03-edit-request-limits.png) | Edit request limits, every field with its range and an "i" tip |
| ![Phone](40-cost-request-limits/04-phone.png) | The page at phone width (no sideways scrolling) |

## 41 · Request logging modes (SEC-009)

Captured 2026-11-20 on a scratch install with the mock providers (two requests sent with request
logging set to Full; the prompt carried a fake `sk-proj-…` key to show the scrubbing).

| Screenshot | Shows |
| --- | --- |
| ![Full](41-request-logging/01-settings-full.png) | Settings → Data retention → Request data: Full chosen, its explanation and the privacy warning |
| ![Detail](41-request-logging/03-detail-before.png) | A request stored under Full: the warning, and the prompt loaded only on "Show prompt and reply" |
| ![Content](41-request-logging/04-detail-content.png) | The stored prompt (key scrubbed), the image described by type and size, and the reply |
| ![Metadata](41-request-logging/05-settings-metadata.png) | Back to Metadata: the warning is gone |

## 42 · Configuration import sandbox (SEC-017)

Captured 2026-11-20 on a scratch install: a hostile configuration file (a planted provider key and
mail password, a `../` identifier, a `command` field, an unknown permission
and a `backupPath`) loaded in Settings → Import and export.

| Screenshot | Shows |
| --- | --- |
| ![Refused](42-configuration-security/01-import-refused.png) | The import refused as a whole: every problem listed, nothing changed, the secrets not repeated |

## 43 · Connection lost overlay

Captured 2026-11-21 on a scratch development build, by stopping the server under an open
console and starting it again.

| Screenshot | Shows |
| --- | --- |
| ![Reconnecting](43-connection-overlay/reconnecting.png) | 1.5 s after the server stopped: the page stays visible but covered and inert, with a spinner |
| ![Disconnected](43-connection-overlay/disconnected.png) | About 20–30 s later the quick attempts have failed: large icon, what happened, Retry (focused) |
| ![Light, reconnecting](43-connection-overlay/light-reconnecting.png) | The same in the light theme |
| ![Light, disconnected](43-connection-overlay/light-disconnected.png) | Disconnected in the light theme |
| ![Phone](43-connection-overlay/phone-reconnecting.png) | Reconnecting at phone width |
| ![Phone, disconnected](43-connection-overlay/phone-disconnected.png) | Disconnected at phone width |

## 44 · Manual capture: choosing models

Captured 2026-11-21 on a scratch development build with two providers and models added by
hand (placeholder keys, so the health toast says Degraded; nothing was sent to a provider).

| Screenshot | Shows |
| --- | --- |
| ![All](44-capture-models/01-models-all.png) | Groq chosen: its models as checkboxes, with **All models** at the top and checked |
| ![Checked](44-capture-models/02-models-checked.png) | Two models checked: All is cleared, each shows as a token |
| ![Dialog](44-capture-models/03-dialog.png) | The dialog with the choice made |
| ![Banner](44-capture-models/04-banner.png) | The running capture names the provider and both models |
