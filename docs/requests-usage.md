# Requests and usage (phase 10)

Makes gateway activity observable (spec §22, §23): every request the gateway
handles, how it was routed and how it ended, and how many tokens and how much
estimated cost it produced.

## What is recorded

Every `/v1` request with a valid API key gets one row in `requests`, written when
the request arrives and completed when it ends. That includes requests that fail
validation, ask for an unknown model, or are refused by a rate limit. Requests
without a valid key are not recorded (they are counted by the per-address
invalid-key limit).

| Field | Notes |
|---|---|
| Request ID | The `x-request-id` the client received |
| Received, completed, duration | Duration includes retries and backoff |
| Status | `EXECUTING`, `STREAMING` while running; then `COMPLETED`, `FAILED`, `TIMEOUT` or `CANCELLED` |
| Endpoint, stream | `chat.completions` or `embeddings` |
| API key, key owner | Names are looked up when shown, so they stay current; deleted ones show as "(deleted …)" |
| Requested model, answering model, provider | The answering model is the last one tried when the request failed |
| Attempts, retries, failovers | Plus the **attempt log**: each try's model, outcome and duration, and models skipped for their rate limit |
| HTTP status, error code and message | Client-safe only (the same text the client got); provider internals stay in the server log |
| Input and output tokens, usage source | `provider` (reported), `estimated` (see below) or `none` |
| Estimated cost (USD) | From the model's prices **at the time**; later price changes do not rewrite history |

**Never stored:** prompts, completions, embeddings input, API keys or any other
request content (spec §22). There is no payload retention setting because there
is no payload storage; adding one would be a deliberate, opt-in feature.

`HTTP status` is 499 for a client that disconnected, and 200 with
`STREAM_INTERRUPTED` for a stream that broke after it had started.

### Token counts

The provider's reported usage is used when there is one. When a provider reports
none (Google embeddings, some local servers, streams cut short), the gateway
estimates at about four characters per token and marks the record `estimated`
(shown with ≈ in the console). Estimated tokens count toward token rate limits
and usage like reported ones, and the Usage page shows how many were estimated.
The client's own response never contains an invented `usage` block.

### Cost

`cost = input tokens × input price + output tokens × output price` (prices per
million tokens, set on each model in the model registry). If a model has no price
for tokens it used, the cost is **unknown** (`null`), not zero; usage reports count
those as "unpriced" requests.

## Usage records

`usage_records` holds hourly totals per API key, model and provider: requests,
errors, input, output and estimated tokens, cost, unpriced requests and total
duration. They are written alongside each finished request and kept much longer
than request rows, so usage reports survive the pruning of request detail.

## Retention

| Setting | Default | |
|---|---|---|
| `CLAWROUTER_REQUEST_RETENTION_DAYS` | 30 | Request rows (with attempt logs). 0 keeps them forever |
| `CLAWROUTER_USAGE_RETENTION_DAYS` | 400 | Hourly usage records. 0 keeps them forever |

Pruning runs on the hourly housekeeping timer. At startup, requests a previous
process left `EXECUTING` or `STREAMING` are marked `FAILED` with `INTERRUPTED`.

## API

| Route | Permission | |
|---|---|---|
| `GET /api/requests` | `requests.read` | Paged (`page`, `pageSize` ≤ 200) and filtered on the server: `status`, `problems=true` (failed, timed out, cancelled), `apiKeyId`, `providerId`, `model` (requested or answering), `from`, `to` (ISO) |
| `GET /api/requests/:id` | `requests.read` | One request with its attempt log |
| `GET /api/usage` | `usage.read` | `from`, `to` (default: the last 24 hours, including the hour in progress), `bucket` (`hour` / `day`; chosen from the period), `groupBy` (`model`, `provider`, `apiKey`, `user`). Returns totals, a series with empty buckets filled in, and the breakdown. At most 400 days |

Buckets are UTC hours or days.

## Console

- **Gateway → Requests**: the history with filters (status, API key, model,
  period, problems only) and server-side paging. Selecting a row opens the request
  with its attempts in order.
- **Gateway → Usage**: totals (requests, tokens, estimated cost, average
  duration) for 24 hours to 90 days, requests and tokens over time, and a
  breakdown by model, provider, API key or user.
- **Dashboard**: estimated cost and tokens over the last 24 hours, and the latest
  failed requests.

## Design notes

- `packages/requests` owns the tables (repository + service). The gateway reports
  each request through a `RequestHandle` (`begin`, `streaming`, `finish`), so the
  history, metrics, events and rate-limit charging all see the same outcome.
- Recording never breaks a request: storage errors are logged and swallowed.
- No foreign keys from history to keys, users, models or providers: history must
  outlive them.

## Not yet

- Live updates: the pages poll or refresh on demand (WebSocket events are phase 11).
- Export (CSV) and per-request search by text.
- Currency other than USD.
