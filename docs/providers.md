# Provider engine (phase 5)

How ClawAPI talks to AI providers (spec §8, §29). The gateway (phase 8) sends
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
| `google` | Gemini `generateContent`, `https://generativelanguage.googleapis.com/v1beta` | `x-goog-api-key` header (never `?key=`) | `assistant` → `model` role; system → `systemInstruction` |
| `openai_compatible` | Chat Completions at any URL | optional Bearer | Ollama, vLLM, LM Studio, llama.cpp, LiteLLM… Endpoint required |

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
- The **encryption key is outside the database**: `CLAWAPI_SECRET_KEY` (base64 or
  hex, 32 bytes) or `CLAWAPI_SECRET_KEY_FILE`. Production refuses to start
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
- **Background health checks**: every `CLAWAPI_PROVIDER_HEALTH_INTERVAL_SECONDS`
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
