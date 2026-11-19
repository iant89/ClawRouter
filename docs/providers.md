# Provider engine (phase 5)

How ClawRouter talks to AI providers (spec §8, §29). The gateway (phase 8) sends
every request through this engine; routing (phase 7) decides which provider
gets it.

## One interface, pluggable providers

Each provider kind is an **adapter** implementing `ProviderAdapter`
(`packages/providers/src/types.ts`):

| Method | Purpose |
|---|---|
| `info`, `capabilities` | Metadata: display name, default endpoint, whether a key is required, capabilities |
| `validateConfiguration` | Endpoint policy and required fields |
| `listModels` | The provider's model list (free: no tokens spent) |
| `testConnection` | `listModels` with latency, for the console's *Test* button |
| `healthCheck` | Cheap periodic check (also the model list) |
| `sendRequest` | One chat completion, normalized |
| `sendStreamingRequest` | Normalized stream: `delta` events, then one `done` with finish reason and usage |

| Kind | API | Auth | Notes |
|---|---|---|---|
| `openai` | Chat Completions, `https://api.openai.com/v1` | `Authorization: Bearer` | `max_completion_tokens`; asks for streamed usage |
| `anthropic` | Messages API, `https://api.anthropic.com` | `x-api-key`, `anthropic-version: 2023-06-01` | System messages moved to `system`; `max_tokens` defaults to 4096 |
| `google` | Gemini `generateContent` / `streamGenerateContent`, `https://generativelanguage.googleapis.com/v1beta` | `x-goog-api-key` header (never `?key=`) | `assistant` → `model` role; system → `systemInstruction`; tools as `functionDeclarations`, Gemini 3 thought signatures carried in tool call ids; images, audio and PDFs inline; embeddings with `batchEmbedContents`. The model list follows `nextPageToken`; every chat model is offered with Vision and Tool use; music, image, video, speech, live-audio, transcription, computer-use and Interactions-only models (Deep Research, Antigravity) are not chat models. Thought summaries (`thought: true` parts) never reach the answer, and reasoning tokens (`thoughtsTokenCount`) count as output tokens, as Google bills them. Tested live 2026-11-19 (see below) |
| `groq` | Chat Completions, `https://api.groq.com/openai/v1` | `Authorization: Bearer` (`gsk_…` keys) | `max_completion_tokens`; streamed usage read from `x_groq.usage`. The model list gives names, context window and output limit, image input (Vision) and prices (filled in as the model's cost on import); retired models and models that do not answer in text (Whisper, Orpheus speech) are not chat models. Ids may contain a slash (`openai/gpt-oss-120b`): clients can send them as they are. Chat only: no embeddings. Tested live 2026-11-16 |
| `openrouter` | Chat Completions, `https://openrouter.ai/api/v1` | `Authorization: Bearer` (`sk-or-…` keys) | Hundreds of models from many providers behind one key; free ones end in `:free`. The model list gives names, context window, output limit, image input (Vision), tool support (Tool use) and prices; models that the chat API does not serve (the half-price `:batch` variants, batch API only), image-generation models and expired models (`expiration_date`) are not chat models. Each answer's exact cost (`usage.cost`) is recorded instead of the estimate. Calls name ClawRouter as the app (`HTTP-Referer`, `X-Title`). Images and PDFs (read for any model, which OpenRouter may charge for). No embeddings. Tested live 2026-11-19 (see below) |
| `openai_compatible` | Chat Completions at any URL | optional Bearer | Ollama, vLLM, LM Studio, llama.cpp, LiteLLM… Endpoint required. Also Google's compatible endpoint `https://generativelanguage.googleapis.com/v1beta/openai` (Bearer = the Gemini API key): `models/` is dropped from ids, `display_name` is read, Gemini 3 thought signatures travel in tool call ids and go back in `extra_content`, and a stream that ends tool calls with "stop" is reported as `tool_calls`. Tested live 2026-11-16 |

### Google (native API), tested live

Live on 2026-11-19 against Google's Gemini API (key in `x-goog-api-key`):

- **Discovery:** 65 models on one page: 26 chat models (offered with Vision and Tool use), 3
  embedding models, 36 others. `antigravity-*` answered "This model only supports Interactions
  API"; `gemini-2.5-flash` is "no longer available to new users" (ClawRouter reports a retired
  model).
- **Through `/v1/chat/completions` on gemini-3.5-flash-lite:** a plain answer, a reasoning
  question, `max_tokens` reported as `length`, a stream with usage, an image (colour named),
  a PDF (text read), a tool call and its answer after the result (the id carries the thought
  signature, 198 characters), a streamed tool call; `/v1/responses`; embeddings with
  gemini-embedding-001 (3,072 dimensions).
- **Through `/v1/messages`:** the Anthropic SDK (messages, streams, a tool round trip, a streamed
  tool call) and Claude Code 2.1.328 with its full default request (about 11,500 input tokens):
  it read a file and ran a shell command, in three turns.
- **Thinking models:** gemini-3.8-flash reported 2 answer tokens and 115 reasoning tokens
  (`thoughtsTokenCount`); ClawRouter counts 117 output tokens.
- **Google's side that day:** gemini-3.5-flash, gemini-3.6-flash and gemini-3.8-flash often
  answered 503 "high demand" or not at all within 60 s, and the free tier allows only a few
  requests a minute (429 "You exceeded your current quota"). Give aliases fallbacks, e.g. a
  `-lite` model.

### OpenRouter, tested live

Live on 2026-11-19 with a key whose account had no credit, so free models only (a paid model
answered 403 "Key limit exceeded"):

- **Discovery:** 445 models; 371 offered as chat, with context, output limit and prices, Vision on
  238 and Tool use on 320; 74 not chat (61 `:batch` variants served only by
  `/api/v1/batches`, and image-generation models).
- **Through `/v1/chat/completions`** on nvidia/nemotron-3.5-super-vl:free: a plain answer, a
  stream, an image (colour named), a PDF (text read), a tool call and its answer, a streamed tool
  call. Cost recorded: $0, except the PDF request: $0.002, OpenRouter's charge for reading it.
- **Through `/v1/messages`:** Claude Code 2.1.328 with its full default request (about 12,500
  input tokens) on nvidia/nemotron-3.5-lightning:free read a file and answered, in two turns.
- These free models are reasoning models: with a small `max_tokens` they can spend it all on
  reasoning (in OpenRouter's separate `reasoning` field, never passed on) and answer nothing,
  with finish reason `length`.
- **Every free chat model, the same day** (15; the two free Lyria models make music and are not
  chat): a streamed request offering a tool, then the tool result sent back, not streamed.
  12 passed both (ernie-5.5-flash-preview, dots-3-note-preview, ling-3.2-flash, lfm-3-1.7b,
  nemotron-3-nano-omni-30b-a3b-reasoning, nemotron-3-ultra-550b-a55b, `openrouter/free`,
  particle-1, flint-v1.0, north-mini-code, nemotron-3.5-lightning, nemotron-3.5-super-vl);
  dots-3-note, particle-1 and nemotron-3-nano-omni also named an image's colour. Every one
  cost $0 with OpenRouter's usage. Not ClawRouter's doing: both free Gemma 4 models answered
  429 every time (Google's free capacity behind OpenRouter), and inkling-2-small:free answers
  403 "only available on agentic harnesses" (now classified `forbidden`: the next model is tried and
  OpenRouter is not held responsible; it used none of the daily allowance).
  A free account allows 50 free-model requests a day. A 429 is now tried once, not twice
  (see [gateway](gateway.md)); a re-check showed one attempt and no use of the allowance.

Adding a provider means writing an adapter and registering it in
`createDefaultRegistry()`. Nothing else changes: adapters contain no routing
policy, and the routing engine never imports them.

Usage is reported as `source: 'provider'` when the provider sent token counts,
`'none'` otherwise. Local estimation is phase 10.

## Credentials (spec §29)

- API keys are **write-only**. The API accepts them on create, update and
  `PUT /api/providers/:id/credential`, and never returns them. Responses show
  `credential: { configured, hint, updatedAt }`, where `hint` is the last 4
  characters and only for keys of 16+ characters.
- Stored **encrypted** with AES-256-GCM (`packages/core/src/secrets.ts`): random
  IV per value, and the ciphertext is bound to `provider:<id>:api_key`, so a value
  copied to another row fails to decrypt. The key's fingerprint is stored too, so
  a wrong key is reported clearly.
- The **encryption key is outside the database**: `CLAWROUTER_SECRET_KEY` (base64 or
  hex, 32 bytes) or `CLAWROUTER_SECRET_KEY_FILE`. Production refuses to start
  without one. In development a `secret.key` (mode 0600) is generated next to the
  database. **Back it up**: without it, stored keys cannot be decrypted and must
  be entered again.
- Keys are decrypted only for the duration of a provider call. They never reach
  logs, the audit log, notifications, errors or the browser. Provider error
  messages are scrubbed of the key before being shown.
- **Moving a provider to a different host requires re-entering the key.**
  Changing the endpoint's origin while a key is stored is refused unless the
  same request supplies the key. Otherwise anyone allowed to edit providers could
  point one at their own server and receive the stored key.

## Endpoint policy

- `https` everywhere, except plain `http` for loopback, private (RFC 1918, IPv6
  ULA) and single-label hosts such as a Docker service `ollama`, for local models.
- No credentials, query string or fragment in the URL.
- Cloud metadata and link-local addresses (`169.254.0.0/16`,
  `metadata.google.internal`, …) are refused.
- **Redirects are never followed**, so a key cannot be redirected to another host.
- Every call has a timeout (the provider's `timeoutMs`; checks use at most 15 s)
  and is cancelled when the caller aborts.

## Status

| State | Meaning |
|---|---|
| `UNKNOWN` (console: "Not checked") | Not checked since it was created, enabled, edited or re-keyed; or no API key yet |
| `HEALTHY` | Last check succeeded |
| `DEGRADED` | Responding slowly (over 5 s) or rate limited |
| `OFFLINE` | Credentials rejected, unreachable, timed out, server errors, or a key that can't be decrypted |
| `DISABLED` | Turned off by an administrator; never receives requests |

- **Connection test** (`POST /api/providers/:id/test`): audited as
  `CONNECTION_TEST`. Concurrent tests of one provider share one call. The console
  runs one automatically after adding a provider or changing its key.
- **Background health checks**: every `CLAWROUTER_PROVIDER_HEALTH_INTERVAL_SECONDS`
  (default 300; `0` turns them off), first run 5 s after startup.
- Every check is kept for 7 days (`provider_health_history`), shown under
  *Details and history*.
- Status changes emit `provider.status`. Going offline or degraded, and
  recovering, notify everyone with `providers.read`.
- `/api/health` includes a non-critical `providers` component with counts only
  (the endpoint is public, so no names are exposed).

## API

| Method | Path | Requires |
|---|---|---|
| GET | `/api/providers/kinds` | `providers.read` |
| GET | `/api/providers`, `/api/providers/:id` | `providers.read` |
| POST | `/api/providers` | `providers.write` |
| PATCH | `/api/providers/:id` | `providers.write` |
| DELETE | `/api/providers/:id` | `providers.write` |
| POST | `/api/providers/:id/test` | `providers.write` (it makes outbound calls) |
| PUT / DELETE | `/api/providers/:id/credential` | `providers.write` |

Audit: `PROVIDER_CREATED`, `PROVIDER_UPDATED` (with changed fields),
`PROVIDER_ENABLED`, `PROVIDER_DISABLED`, `PROVIDER_DELETED`,
`CREDENTIAL_CREATED`, `CREDENTIAL_REPLACED`, `CREDENTIAL_REMOVED`,
`CONNECTION_TEST`.

## Testing

`tests/support/mock-providers.ts` is a local HTTP server that imitates the four
APIs, streaming included. Adapter tests run against it over real sockets. No test
calls a real provider; none were reachable from the development environment, so
real-provider testing is still to be done with real keys.
