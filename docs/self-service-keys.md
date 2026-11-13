# Self-service API keys and key requests

The owner's rule (2026-11-13): creating your own API keys is a **permission**,
keys can **expire daily or after a length of time**, and people without the
permission can **request** a key. The request notifies everyone who can create
keys and **does not share a role** with the requester.

## Who can do what

| Permission | Can |
|---|---|
| `api_keys.own` | Create, view and revoke **their own** keys (Gateway → My API keys). |
| `api_keys.write` | Create, change and revoke **any** key (API Access), and **approve or deny key requests**. |
| any signed-in user | View and revoke keys they own; **request** a key if they hold neither permission above. |

`api_keys.own` is a new permission. Administrator has it, like every permission,
and Operator has it too (owner confirmed 2026-11-13). Viewer does not, so grant it through a **custom role**
(Administration → Roles), e.g. a "Developer" role with `models.read` and
`api_keys.own`.

A key **belongs to** the user it acts for: their per-user rate limits apply, it
shows on their My API keys page, and it is **suspended** while they are disabled
(phase 15). Self-service keys use the default per-key limit; only `api_keys.write`
can give a key its own limit.

## Expiry

Every key, whether self-service, administrator-made or from a request, chooses one of:

| Choice | Meaning |
|---|---|
| Never | Works until revoked. |
| **End of today** | Until the next midnight in the **user's time zone** (sent by the console, e.g. `America/New_York`): a key for today only. Daylight-saving changes are handled. |
| **After a length of time** | N hours or days after the key is created (up to ten years). |
| On a date | Until a chosen date and time. |

The API takes `expiry: { type: "never" | "end_of_day" | "after" | "at", ... }`
(`KeyExpiry` in `packages/shared/src/gateway.ts`), and the server works out the
moment (`packages/gateway/src/expiry.ts`). For a request, the expiry counts from
when the key is **created**, not from when it was requested. The older
`expiresAt` field still works for `POST /api/api-keys`.

## Key requests

1. **Request.** Someone without `api_keys.own` or `api_keys.write` opens My API
   keys → *Request a key*: name, what it is for, optional models, expiry. At most
   5 requests can wait at once per user.
2. **Notify.** Every active user with `api_keys.write` who shares **none** of the
   requester's roles gets a notification linking to API Access → Key requests. If
   nobody qualifies, nobody is notified (a warning is logged), but the request is
   still listed for every approver.
3. **Decide.** An `api_keys.write` holder who shares no role with the requester approves, optionally narrowing the models
   or the expiry and adding a note, or denies with a reason. The requester is
   notified either way. Approvers **never see the key**.
4. **Create.** On My API keys, the requester clicks *Create key* on the approved
   request. The key is created **owned by them**, with what was approved, and shown
   **once**. A request makes one key; a second attempt is refused.

Requesters can cancel a waiting request. Decided requests cannot change again.
Other people's requests and keys answer "not found", so ids cannot be probed.

Audit: `API_KEY_REQUESTED`, `API_KEY_REQUEST_APPROVED` (with requested vs.
approved models/expiry), `API_KEY_REQUEST_DENIED` (with the reason),
`API_KEY_REQUEST_CANCELLED`, then `API_KEY_CREATED` with `via: request:<id>` and
the owner. Live updates: `api_key_request.changed` reaches approvers;
requesters hear through their notifications.

## Endpoints

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/me/api-keys` | signed in | Your keys |
| POST | `/api/me/api-keys` | `api_keys.own` | Create your own key (`name`, `allowedModels`, `expiry`; no `rateLimit`). The secret is in this response only |
| DELETE | `/api/me/api-keys/:id` | signed in | Revoke one of your keys |
| GET | `/api/me/api-key-requests` | signed in | Your requests |
| POST | `/api/me/api-key-requests` | signed in, without `api_keys.own`/`write` | Request a key (`name`, `purpose`, `allowedModels`, `expiry`) |
| DELETE | `/api/me/api-key-requests/:id` | signed in | Cancel your waiting request |
| POST | `/api/me/api-key-requests/:id/create` | signed in | Create the key from your approved request. The secret is in this response only |
| GET | `/api/api-key-requests?status=&page=&pageSize=` | `api_keys.write` | All requests, waiting first |
| POST | `/api/api-key-requests/:id/approve` | `api_keys.write` | `{ allowedModels?, expiry?, note? }` |
| POST | `/api/api-key-requests/:id/deny` | `api_keys.write` | `{ reason }` |

Storage: `api_key_requests` (migration `0014`). The secret is never stored for a
request; it exists only when the requester creates the key.

## Maximum key lifetime per provider and model

The owner's request (2026-11-13): administrators choose, when adding or editing a
provider or a model, how long an API key may live and still use it. This is
"maximum key length" in the request, read as lifetime.

- **Where:** *Maximum key lifetime* (hours or days; blank = no limit) in the
  provider and model dialogs, stored as `max_key_lifetime_hours` on both
  (migration `0015`). The API fields are `maxKeyLifetimeHours` on providers and
  models (`null` removes a limit). Changes are audited with the other provider and
  model changes.
- **Effective limit:** a model's limit is the **stricter** of its own and its
  provider's (`ModelInfo.keyLifetimeLimit`, with the source). A model can tighten
  its provider's limit, never loosen it. The Providers and Models tables show it.
- **When a key is created** for specific models (by an administrator, as an own
  key, or from an approved request), its expiry must fit within the strictest limit
  among those models. Aliases count through their targets. "Never" is refused with
  a message naming the model, e.g. *"Expiry must be at most 7 days from now:
  openai/gpt-4o allows keys of at most 7 days (set on the model)."* Requests are
  checked when submitted and again when approved.
- **When a key is used**, a key **older** than a model's limit cannot reach that
  model. Routing skips it (the plan says why), `/v1/models` hides it, and if
  nothing else is left the request gets **403** `key_too_old`: *"This API key is
  older than the 7 days maximum key lifetime for openai/gpt-4o (set on the
  provider). Create a new key."* This covers keys for **any model**, which are not
  checked at creation (one strict model would otherwise force every such key to be
  short), and limits added after a key was created.

Code: `packages/gateway/src/key-lifetime.ts` (resolution and creation check), the
`exclude` hook in `packages/routing/src/engine.ts`, and `tooOldFor` in
`packages/gateway/src/service.ts`. Tests: `packages/api/test/key-lifetime-api.test.ts`.

## Owner's decisions (2026-11-13)

- **Deciding is also limited to people outside the requester's roles**, not only
  being notified. An `api_keys.write` holder who shares a role with the requester
  sees the request but cannot approve or deny it (403). The list marks each request
  with `decidableByYou`.
- **Operators have `api_keys.own`** by default. Viewers do not; grant it with a
  custom role if wanted.

Still to confirm: "maximum key length" was read as **lifetime**. If it meant
something else (e.g. the length of the provider's own API key), say so.

## Screenshots

[`docs/screenshots/16-self-service-keys`](screenshots/README.md#16--self-service-api-keys).
