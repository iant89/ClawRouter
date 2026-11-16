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
| `POST /v1/responses` | The Responses API (stateless), over the same pipeline: see [Responses API](#responses-api) |

`model` may be an alias, a model reference (`openai/gpt-4o`) or a provider model id
(`gpt-4o-mini`), resolved as described in [routing](routing.md). The response's
`model` is the reference that answered; the `x-clawrouter-model` and
`x-clawrouter-attempts` headers say which model answered and after how many
attempts. Every response has an `x-request-id`.

### Supported request fields (chat)

`model`, `messages` (roles `system`, `developer` (treated as system), `user`,
`assistant`, `tool`; content as a string or parts), `max_completion_tokens` /
`max_tokens`, `temperature` (0–2), `top_p` (0–1), `stop` (a string or up to 4),
`tools`, `tool_choice`, `parallel_tool_calls`, `stream`,
`stream_options.include_usage`. Unknown fields are ignored.

Rejected with a clear 400 rather than silently ignored: `n` other than 1,
non-text `response_format`, and the deprecated `functions` / `function_call` / role
`function` (send `tools` instead).

### Tools (function calling)

The OpenAI format, for every provider: `tools` (up to 128 function tools with a JSON
Schema `parameters`), `tool_choice` (`auto`, `none`, `required` or
`{ "type": "function", "function": { "name": … } }`) and `parallel_tool_calls`. The
answer carries `tool_calls` with `finish_reason: "tool_calls"`; when streaming, each
call arrives in pieces (`index`, then `id`, `type` and `name`, then `arguments`
pieces), exactly as OpenAI streams them. The client runs the tool and sends the
result back as a `tool` message with the call's `tool_call_id`.

| | OpenAI, Groq, compatible | Anthropic | Google (Gemini) |
|---|---|---|---|
| Tools | passed through | `input_schema` | `functionDeclarations` (`parametersJsonSchema`) |
| `tool_choice` | passed through | `auto` / `any` / `tool` / `none` | `AUTO` / `ANY` (+ allowed name) / `NONE` |
| `parallel_tool_calls: false` | passed through | `disable_parallel_tool_use` | not available (ignored) |
| Calls in the answer | `tool_calls` | `tool_use` blocks | `functionCall` parts |
| Results sent back | `tool` messages | `tool_result` blocks, together in one user turn | `functionResponse` parts, named after the call |

- Routing needs a model marked **Tool use** when a request has tools, or tool calls or
  results in its history; otherwise 400 says so. Import pre-selects Tool use for chat
  models; Groq says per model (`supported_features`).
- Gemini 3 requires each call's *thought signature* on the next turn. ClawRouter keeps
  no state between requests, so the signature travels inside the tool call id
  (`call_…~<signature>`): send ids back unchanged.
- A `tool` message must answer a tool call earlier in the conversation.
- Tested live against Groq (gpt-oss-20b): a call, the round trip with a result, a
  streamed call and a named `tool_choice`. Anthropic and Gemini are tested against
  fake providers only.

### Images, audio and PDFs

User messages may carry media as OpenAI content parts. ClawRouter translates them
for each provider:

| Part | Sent as | OpenAI | Groq | Compatible | Anthropic | Google |
|---|---|---|---|---|---|---|
| `image_url` with an http(s) URL | the URL (the provider downloads it) | ✓ | ✓ | ✓ | ✓ | — |
| `image_url` with a `data:` URL (PNG, JPEG, GIF, WebP) | inline base64 | ✓ | ✓ | ✓ | ✓ | ✓ |
| `input_audio` (`wav`, `mp3`) | inline base64 | ✓ | — | — | — | ✓ |
| `file` with `file_data` (PDF data URL) | inline base64 | ✓ | — | — | ✓ (document) | ✓ |

- Routing only picks models whose provider takes every medium in the request, and
  images also need a model marked **Vision**. When nothing qualifies, the client
  gets 400 naming the media and what is needed.
- `detail` (`auto`, `low`, `high`) is passed on where the provider has it.
- Limits: 15 MB per item (decoded), 50 items per request, 25 MB per request body.
  `file_id` (a file stored at one provider) is refused: send `file_data`.
- A URL is downloaded by the provider, not by ClawRouter: it must be public, and
  some providers do not follow redirects (Groq refuses them).
- Media is never stored: request history, logs and events hold metadata only.
  Provider token counts include the images, so usage and cost do too.

## Responses API

`POST /v1/responses` speaks OpenAI's Responses API and runs through the same
pipeline as chat completions: routing, failover, rate limits, quotas, media, tools and
request history (endpoint `responses`) all apply, with every provider. Clients such as
the OpenAI Agents SDK and Codex can point at ClawRouter.

| Request | Becomes |
|---|---|
| `input` as text, or items: messages (`input_text`, `input_image`, `input_file`, `input_audio`; assistant `output_text`), `function_call`, `function_call_output` | the conversation |
| `instructions` | a system message |
| `max_output_tokens`, `temperature`, `top_p` | the same limits |
| `tools` (type `function`), `tool_choice`, `parallel_tool_calls` | tools (see above) |
| `metadata` | echoed in the response |
| `reasoning` items in `input` | skipped (ClawRouter cannot resume a provider's reasoning) |

The answer is a `response` object: `message` items with `output_text`, and
`function_call` items (`call_id`, `name`, `arguments`), with `usage`. An answer cut
by the length limit has `status: "incomplete"` and `incomplete_details.reason:
"max_output_tokens"`. Streaming sends the Responses events with `sequence_number`:
`response.created`, `response.in_progress`, `response.output_item.added`,
`response.content_part.added`, `response.output_text.delta` / `.done`,
`response.function_call_arguments.delta` / `.done`, `response.output_item.done`, and
`response.completed` (or `response.incomplete`, or `response.failed` when the
provider fails mid-stream). There is no `[DONE]`.

**Stateless.** ClawRouter stores no prompts or answers, so it keeps no responses:
send the whole conversation in `input` each time (what clients do with `store:
false`). `previous_response_id`, `conversation` and `item_reference` are refused with
400, and `store` is always `false` in the answer. OpenAI's hosted tools
(`web_search`, `file_search`, `code_interpreter`, …) and structured `text.format`
(JSON schema) are refused too. Errors name the Responses field (`input[2].call_id`,
`max_output_tokens`, …).

Tested live against Groq (gpt-oss-20b): a plain answer, a streamed one, a tool call
and its round trip, and a streamed tool call.

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
- Administration: `GET/POST /api/api-keys` (the list is paged: `page`, `pageSize` up to 200, `q`, `status`; `meta.total`, `meta.active`), `DELETE /api/api-keys/:id` (revoke),
  permissions `api_keys.read` / `api_keys.write` (Administrator only). Creation
  and revocation are audited (`API_KEY_CREATED`, `API_KEY_REVOKED`).
- Users with `api_keys.own` create their own keys, others request one, and every key
  can expire at the end of the day or after a length of time: see
  [self-service keys](self-service-keys.md).
- **MCP access** (`mcpAccess`, off by default): the key may also use ClawRouter's own
  MCP server at `/v1/mcp`, read-only tools with its owner's permissions. See
  [MCP server](mcp.md).
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

- `n > 1` (see above); stored responses (`previous_response_id`) and OpenAI's hosted tools. Image generation, audio output and transcription endpoints.
- Rate limits: see [rate limits](rate-limits.md) (phase 9). A refused request gets 429 `rate_limit_error` with `Retry-After`.
- Request history, usage and cost: see [requests and usage](requests-usage.md) (phase 10).
- CORS: none. Browser apps should call ClawRouter from their backend.
- Never tested against real provider APIs (see `MEMORY.md`).
