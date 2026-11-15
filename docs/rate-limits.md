# Rate limiting and user quotas (phase 9, extended)

Protects the gateway, and the provider quotas behind it, from clients that send
too much (spec §12). Limits apply to `/v1/*` only; the console's sign-in has its
own throttle (see [authentication](authentication.md)).

## What can be limited

Each limit counts **requests** and **tokens** over a sliding window of **one second,
one minute or one hour** (chosen per limit), and can add a **token bucket** against
bursts (below). Each measure can be left empty for "no limit".

| Scope | Requests / window | Tokens / window | Other | Default |
|---|---|---|---|---|
| Per API key | ✓ | ✓ | token bucket | 120 requests / min |
| Per user (all keys that user created, combined) | ✓ | ✓ | token bucket | none |
| Per model (`provider/model`) | ✓ | ✓ | token bucket | none |
| Whole gateway | ✓ | ✓ | token bucket, requests at the same time | 100 at the same time |
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
- **Gateway.** Overall requests and tokens per window, a bucket, and requests in progress at
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

### Windows

A limit's `window` is `second`, `minute` or `hour`; `requests` and `tokens` count over
that sliding window. Use a second for "at most 5 requests per second", an hour for
budgets like "200,000 tokens per hour". Changing a limit's window starts its
counters again.

### Token buckets (bursts)

A limit can also have a `bucket` to stop a client from spamming the API:

```json
{ "window": "minute", "requests": 600, "tokens": null,
  "bucket": { "capacity": 10, "refillAmount": 1, "refillEverySeconds": 1 } }
```

The bucket starts full. Each request takes one; when it is empty the request gets
429 (`Retry-After` = time to the next refill). Every `refillEverySeconds`,
`refillAmount` requests are added back at once, never more than `capacity`. So
`capacity` is the largest burst and `refillAmount ÷ refillEverySeconds` the steady
rate: the example allows 10 requests at once, then one per second. Limits: capacity
1–1,000,000, refill amount 1–capacity, refill every 1–86,400 s. A request refused by
another limit takes nothing from the bucket. The message says what was hit:
"Too many requests in a short time for this API key (bursts of up to 10 requests,
then 1 every second). Try again in 1 s."

### Older limits

Before windows existed a limit was `{ "requestsPerMinute", "tokensPerMinute" }`. That
shape is still accepted everywhere (API, configuration files, stored documents and
key columns) and read as a one-minute window without a bucket.

## User quotas

A quota is a budget for one user's API keys together, set by an administrator when
creating the user or later (Users → ⋯ → **Usage quota**). Unlike rate limits it is
not about traffic shape: once used up, the user's keys are refused until it resets.

| Field | Values |
|---|---|
| `unit` | `tokens` (input + output), `requests` (completed only: failed and refused requests do not count), `cost` (estimated US$, from model prices) |
| `amount` | tokens or requests 1–10¹², or dollars 0.01–10⁹ (two decimals) |
| `period` | `day`, `week` or `month` |
| `resetHour` | 0–23 |
| `resetWeekday` | for a week: 1 = Monday … 7 = Sunday |
| `resetDayOfMonth` | for a month: 1–28 (so every month has it) |
| `timeZone` | IANA name; the reset happens at that local time, daylight saving included |

Refused requests get 429 with code `quota_exceeded` and `Retry-After` until the reset:

```json
{ "error": { "message": "Your usage quota is used up: 55 of 50 tokens this month. It resets on Tue, 1 Dec 2026, 00:00 (UTC). An administrator can raise it.",
  "type": "rate_limit_error", "param": null, "code": "quota_exceeded", "request_id": "req_…" } }
```

- **Usage** is read from the stored hourly usage records (`usage_records`), so it
  survives restarts and is shared by every node on the database. Records are hourly
  (UTC): in time zones with a half-hour offset the period counts from the start of
  that UTC hour. Usage older than the usage retention period is gone, so keep that
  longer than a month when using monthly quotas.
- Like token limits, usage is charged when a request finishes: requests running at
  the same time can together go past the quota.
- The quota is checked before the rate limits. Quotas are cached for 30 s per
  process, so on several nodes a change reaches the others within that time.
- API: `GET /api/users/:id/quota` (`users.read`), `PUT /api/users/:id/quota` with
  `{ "quota": … }` or `{ "quota": null }` (`users.write`; changing the quota of
  someone holding permissions you lack is refused), `quota` on `POST /api/users`
  (checked before the user is created), and `GET /api/auth/quota` for your own,
  shown on the API Access page.
- Audit `USER_QUOTA_UPDATED` (from, to); events `quota.changed`, `quota.exceeded`.

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
3. The key owner's usage quota.
4. Token budgets (key, user, gateway), then request limits, then burst buckets (key, user, gateway).
   The request is counted in every scope only when all of them allow it.
5. Routing; then, per attempt, the model's limits.
6. After the response: tokens charged to key, user, gateway and model.

## Algorithm and storage

- **Sliding-window counter**: the current and previous fixed windows, the previous
  one weighted by how much of it still overlaps the window (second, minute or hour). Constant memory
  per counter, close to a true sliding log, and a burst at the end of one minute
  still counts at the start of the next (no doubling at window edges).
- **Token bucket**: a count and the time of the last refill per bucket, refilled in
  whole steps when read. Buckets are kept in memory like the counters.
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

- Counters and buckets are per process (fine for one node); a shared store is future work.
- No notification when a limit is hit repeatedly (events exist; alerts are a later phase).
- Per-provider limits: use per-model limits on that provider's models.
