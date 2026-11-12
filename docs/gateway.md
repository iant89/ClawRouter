# Request gateway (phase 8)

The data plane: an OpenAI-compatible API at `/v1` that external AI clients call
with an API key. ClawRouter resolves the requested model through the
[routing engine](routing.md), calls the chosen provider through its
[adapter](providers.md), retries and fails over as the policy says, and answers in
the OpenAI format. Clients never need to know which provider answered (spec §7).

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer crk_…" \
  -H "Content-Type: application/json" \
  -d '{"model": "fast-chat", "messages": [{"role": "user", "content": "Hello"}]}'
```

Any OpenAI SDK works with `base_url = http://<host>/v1` and the key as its API key.

## Endpoints

| Endpoint | Notes |
|---|---|
| `GET /v1/models` | Enabled aliases and usable models (`provider/model`), limited to what the key may use |
| `POST /v1/chat/completions` | JSON or streaming (`stream: true`, `stream_options.include_usage`) |
| `POST /v1/embeddings` | `input` as a string or up to 2048 strings; `encoding_format: "float"` only. OpenAI, OpenAI-compatible and Google; not Anthropic |
| `POST /v1/responses` | **Not supported yet.** Answers 400 pointing to `/v1/chat/completions` |

`model` may be an alias, a model reference (`openai/gpt-4o`) or a provider model id
(`gpt-4o-mini`), resolved as described in [routing](routing.md). The response's
`model` is the reference that answered; the `x-clawrouter-model` and
`x-clawrouter-attempts` headers say which model answered and after how many
attempts. Every response has an `x-request-id`.

### Supported request fields (chat)

`model`, `messages` (roles `system`, `developer` (treated as system), `user`,
`assistant`; content as a string or text parts), `max_completion_tokens` /
`max_tokens`, `temperature` (0–2), `top_p` (0–1), `stop` (a string or up to 4),
`stream`, `stream_options.include_usage`. Unknown fields are ignored.

Rejected with a clear 400 rather than silently ignored: image or audio content,
`tools` / `functions`, `n` other than 1, non-text `response_format`. These need
capabilities the normalized model does not have yet.

## API keys

- Format `crk_<8 hex>_<43 base64url>`. The first part (`crk_3f9a1c2b`) is the public
  prefix shown in lists. The whole key is shown **once**, in the response to
  `POST /api/api-keys` (sent with `cache-control: no-store`).
- Only a SHA-256 hash is stored (`api_keys`, migration `0009_api_keys`); comparison
  is constant-time. Keys have 256 bits of randomness, so a fast hash is adequate.
- Sent as `Authorization: Bearer <key>` or `x-api-key: <key>`, on `/v1/*` only.
  A console session cookie never authorizes `/v1`, and an API key never
  authorizes `/api`.
- Optional **allowed models** (alias names, references or model ids,
  case-insensitive; empty means any model) and **expiry**. Revocation is
  immediate. `last_used_at` is written at most once a minute per key.
- Administration: `GET/POST /api/api-keys`, `DELETE /api/api-keys/:id` (revoke),
  permissions `api_keys.read` / `api_keys.write` (Administrator only). Creation
  and revocation are audited (`API_KEY_CREATED`, `API_KEY_REVOKED`).
- Console: **Gateway → API Access**: list, create (with a copy button and a curl
  example), revoke.

## Execution

`packages/gateway`:

1. Parse and validate the body in OpenAI terms (`openai.ts`). Errors name the
   offending `param`.
2. Check the key's allowed models, then `RoutingService.plan()`.
3. `runAttempts()` (`executor.ts`) walks the plan's attempts:

   | Failure | Effect |
   |---|---|
   | timeout, network, 5xx, 429, unreadable response | retry the same model if the plan has a retry, otherwise next model. Counted in the failure tracker |
   | auth, not found, misconfigured | skip this model's retries, next model. Counted |
   | provider 400 (the request is at fault) | stop; the client gets 400 with the provider's message (credentials scrubbed) |
   | client disconnected | stop |

   Retries back off 250 ms × try (capped at 2 s). The plan caps attempts (at most
   10), so the loop always ends. When every attempt fails the client gets a
   generic 502 (`PROVIDER_ERROR`) or 504 (`PROVIDER_TIMEOUT`) with the attempt
   count; provider details stay in the server log.
4. Every attempt calls `FailureTracker.recordFailure/recordSuccess`, so failing
   providers are demoted in later plans (phase 7).

### Streaming

- Server-sent events, OpenAI `chat.completion.chunk` format, ending with
  `data: [DONE]`. With `include_usage`, a final chunk carries `usage`.
- No buffering: the response stream pulls one provider event at a time.
- **Failover only before the first token.** The gateway waits for the provider's
  first event before answering, so a provider that fails up front is retried or
  replaced transparently. Once output has started, a provider failure ends the
  stream with an error event (`code: stream_interrupted`) instead of silently
  switching models mid-answer.
- A client disconnect aborts the provider request.
- Bun's idle timeout is 255 s (its maximum), so slow models are not cut off.

## Errors

`/v1` uses the OpenAI error shape, so SDKs show useful messages:

```json
{ "error": { "message": "…", "type": "invalid_request_error", "param": "model", "code": "model_not_found", "request_id": "req_…" } }
```

| Status | `type` | When |
|---|---|---|
| 400 | `invalid_request_error` | validation, unsupported feature, provider rejected the request |
| 401 | `authentication_error` (`invalid_api_key`) | missing, wrong, expired or revoked key |
| 403 | `permission_error` | model not allowed for this key |
| 404 | `invalid_request_error` (`model_not_found`) | unknown model or alias |
| 429 | `rate_limit_error` (`rate_limit_exceeded`) | a [rate limit](rate-limits.md) was reached; see `Retry-After` |
| 502 / 504 | `api_error` | every attempt failed / timed out |
| 503 | `api_error` | no usable model (e.g. all providers disabled, or no model with the capability) |

## Metrics and events

- `GET /api/gateway/metrics` (`requests.read`): active requests, requests and errors
  in the last minute, totals, average latency (last 100), tokens in the last hour,
  retried and failed-over requests. In memory: they reset when the server restarts.
  The dashboard receives it live with each activity message (phase 11), polling every 5 s only without the live connection.
- Events `request.started`, `request.completed` (usage, attempts, failovers, model,
  provider) and `request.failed` (code, status, attempts). Since phase 10 every
  request is also stored as history and usage ([requests and usage](requests-usage.md)).

## Not yet

- `/v1/responses`, tools, images, `n > 1` (see above).
- Rate limits: see [rate limits](rate-limits.md) (phase 9). A refused request gets 429 `rate_limit_error` with `Retry-After`.
- Request history, usage and cost: see [requests and usage](requests-usage.md) (phase 10).
- CORS: none. Browser apps should call ClawRouter from their backend.
- Never tested against real provider APIs (see `MEMORY.md`).
