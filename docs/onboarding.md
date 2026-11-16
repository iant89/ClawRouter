# First-run onboarding

The owner asked (2026-11-16) for a setup wizard after the first administrator is
created, then a skippable guided tour that makes new users familiar with the console.
Both are optional at every step.

## Setup wizard

Right after **Create administrator**, instead of the dashboard, the administrator
gets **Set up ClawRouter**: six steps on ENTERPRISE-UI's `Wizard`.

| Step | What it does | Uses |
|---|---|---|
| Connect a provider | Add a provider and its API key; the connection is tested right away | the Providers dialog |
| Import models | Discover the provider's models and import them (chat models are preselected; prices filled in automatically) | the Models discovery dialog |
| Create an API key | A key for applications; shown once | the API Access dialog (or "My API keys" for roles with only `api_keys.own`) |
| Send a test request | A real request to `/v1/chat/completions` with that key, as an application would send it; the answer, latency, tokens and request id are shown | the gateway |
| Mail server | SMTP for sign-in codes by email (skip if everyone uses an authenticator app) | the Settings card |
| Sign-in security | Who must use two-factor sign-in, with which methods | the Settings card |

- **Skipping:** Next moves on whether or not the step was done. **Cancel** leaves the
  whole wizard after a confirmation; what was done is kept.
- **Resuming:** the current step is saved on the server, so signing in again resumes it.
- **Running it again:** help menu (? in the header) → **Run the setup wizard**, for users
  who can change settings.
- **Permissions:** the wizard is offered only to users with `settings.write`. Each step calls the
  ordinary API, which checks its own permission; a step the role cannot do says so and
  can be skipped.
- **The test key** stays in the page's memory only (never stored, never sent anywhere but
  ClawRouter's own `/v1`).

## Guided tour

ENTERPRISE-UI's `Tour` (added for this, ENTERPRISE-UI pull request 55). Every **new** user
sees it once, at their first sign-in (after a temporary password is changed and
two-factor sign-in is set up, when required). The first administrator sees it after the
wizard.

- A welcome, then the Dashboard, then **one step per area the user can open** (Gateway,
  AI infrastructure, System, Administration), each pointing at the area's first page in the
  sidebar and describing only the pages that user can see; then the header's system
  health, notifications and help. A Viewer's tour has no Administration step and never
  mentions API Access, Logs, Audit or Settings. (`features/onboarding/tour-steps.ts`.)
- **Skip tour**, the close button and Escape skip it; **Start using ClawRouter** finishes
  it. Either way it is saved and does not come back by itself.
- **Replay:** help menu → **Take the guided tour** (on a phone, under **More**).
- On a phone the sidebar is collapsed, so steps that point at it are shown in the middle of
  the screen instead.

## Storage and API

| | |
|---|---|
| `users.tour_state` | `PENDING`, `COMPLETED` or `SKIPPED` (migration `0020_onboarding`) |
| setting `onboarding.setup_wizard` | `{ status: PENDING \| COMPLETED \| DISMISSED, step }`; absent on a fresh installation (= pending) |
| session | `onboarding: { tour, setupWizard }`; `setupWizard` is null without `settings.write` |
| `POST /api/auth/tour` | `{ outcome: COMPLETED \| SKIPPED }`, own tour (`authenticated`) |
| `PUT /api/onboarding/setup-wizard` | `{ status, step? }` (`settings.write`); the wizard's end is audited as `SETUP_WIZARD_COMPLETED` or `SETUP_WIZARD_DISMISSED` |

**Upgrades:** migration 0020 marks every existing user's tour as completed and the
installation's wizard as completed, so neither appears after upgrading. Users created
later get the tour.

## Code and tests

- Server: `packages/authentication/src/onboarding.ts`; routes in `packages/api/src/app.ts`.
- Console: `features/onboarding/SetupWizard.tsx`, `ConsoleTour.tsx`, `tour-steps.ts`; the
  gate in `app/App.tsx`; the help menu in `layouts/ConsoleLayout.tsx`.
- Tests: `packages/api/test/onboarding-api.test.ts` (state, permissions, audit,
  migration), `apps/console/test/tour-steps.test.ts` (steps by role),
  `apps/console/test/auth-state.test.ts` (session refresh picks up onboarding changes).
- Checked in Chromium (2026-11-16) on a production build: the whole wizard with a real
  Groq provider and test request, the tour for an administrator and a Viewer, replay
  from the help menu, and phone width. Screenshots: `docs/screenshots/28-onboarding/`.
