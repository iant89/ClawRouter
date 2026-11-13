# Rate limiting (phase 9)

Protects the gateway, and the provider quotas behind it, from clients that send
too much (spec §12). Limits apply to `/v1/*` only; the console's sign-in has its
own throttle (see [authentication](authentication.md)).

## What can be limited

All limits are **per minute over a sliding window**. Each measure can be left
empty for "no limit".

| Scope | Requests / min | Tokens / min | Other | Default |
|---|---|---|---|---|
| Per API key | ✓ | ✓ | | 120 requests / min |
| Per user (all keys that user created, combined) | ✓ | ✓ | | none |
| Per model (`provider/model`) | ✓ | ✓ | | none |
| Whole gateway | ✓ | ✓ | requests at the same time | 100 at the same time |
| Per client address | | | invalid API keys / min | 20 |

- **Per key.** The default applies to every key without its own limit. A key can
  have its own limit (set when it is created, or with **Change rate limit** on the
  API Access page, `PATCH /api/api-keys/:id`), including "no limit for this key".
  `rateLimit: null` means "use the default".
- **Per user.** Keys are owned by the user who created them. One user's keys share
  this budget, so creating more keys does not bypass it.
- **Per model.** Checked when a model is about to be tried. A model at its limit is
  **skipped like an unavailable one**: the next model in the route is tried, the
  provider is not called, and the failure tracker is not touched. Only when every
  candidate is limited does the client get 429. Use it to stay inside a provider's
  quota while overflow goes to the fallback.
- **Gateway.** Overall requests and tokens per minute, and requests in progress at
  the same time (a stream counts until it ends).
- **Invalid keys per address.** After N failed key checks in a minute, **every**
  `/v1` request from that address gets 429 until the window has passed, valid key
  or not, so the address cannot keep probing. Behind a reverse proxy all clients
  share the proxy's address unless `CLAWROUTER_TRUSTED_PROXIES` lists it (see [security](security.md)).

### Tokens

Token limits use the provider-reported usage (input + output). A request is let
through while the budget has at least one token left, and charged with its real
usage when it completes, so a single large request can overshoot a token limit;
the next requests then wait. Requests whose provider reports no usage are not
charged.

## Responses

Every admitted `/v1` request carries OpenAI-style headers for the **tightest**
limit that applies (the one with the fewest remaining):

```
x-ratelimit-limit-requests: 120
x-ratelimit-remaining-requests: 117
x-ratelimit-reset-requests: 42s
x-ratelimit-limit-tokens: 50000        (only when a token limit applies)
x-ratelimit-remaining-tokens: 48812
x-ratelimit-reset-tokens: 42s
```

A refused request gets **429** in the OpenAI format with `Retry-After` (seconds):

```json
{ "error": { "message": "Rate limit reached for this API key (120 requests per minute). Try again in 12 s.",
  "type": "rate_limit_error", "param": null, "code": "rate_limit_exceeded", "request_id": "req_…" } }
```

OpenAI SDKs retry 429s automatically, honouring `Retry-After`. A refused request
does not count against any limit, and is not counted as a gateway request or
error; it shows in the dashboard's **Refused by rate limits** tile.

## Order of checks

1. Address blocked for invalid keys? (before the key is looked up)
2. Concurrency slot (gateway).
3. Token budgets (key, user, gateway), then request limits (key, user, gateway).
   The request is counted in every scope only when all of them allow it.
4. Routing; then, per attempt, the model's limits.
5. After the response: tokens charged to key, user, gateway and model.

## Algorithm and storage

- **Sliding-window counter**: the current and previous fixed windows, the previous
  one weighted by how much of it still overlaps the last minute. Constant memory
  per counter, close to a true sliding log, and a burst at the end of one minute
  still counts at the start of the next (no doubling at window edges).
- `Retry-After` is exact for this model: the time until enough of the old count has
  decayed (tested).
- Counters live behind the async `CounterStore` interface
  (`packages/rate-limits/src/counters.ts`). Today that is `MemoryCounterStore`:
  single node, reset on restart, bounded to 50,000 counters. A Redis store can
  implement the same interface for several nodes (spec §12).
- The configuration is one versioned document (`rate_limit_config`, migration
  `0010_rate_limits`), cached in memory and replaced on save. A key's own limit is
  the `api_keys.rate_limit` column.

## Administration

- **Gateway → Rate Limits**: the limits, an **Edit limits** dialog, and live usage
  per gateway, key, user, model and address (refreshes every 5 s), with "Within
  limit / Near limit (80%) / At limit / Blocked".
- API: `GET /api/rate-limits`, `PUT /api/rate-limits` (whole document with the
  `version` you loaded; 409 if someone saved first), `GET /api/rate-limits/usage`.
- Permissions: `rate_limits.read` (Administrator, Operator, Viewer) and
  `rate_limits.write` (Administrator, Operator). Per-key limits need
  `api_keys.write` (Administrator).
- Audit: `RATE_LIMITS_UPDATED` (with what changed) and `API_KEY_UPDATED`.
- Events: `ratelimits.changed`, and `ratelimit.exceeded` (scope, subject, kind,
  limit, retry seconds) for every refusal.
- Limits on models that are no longer registered are kept but reported
  (`unknownModels`), since they never apply.

## Not yet

- Counters are per process (fine for one node); a shared store is future work.
- No notification when a limit is hit repeatedly (events exist; alerts are a later phase).
- Per-provider limits: use per-model limits on that provider's models.
