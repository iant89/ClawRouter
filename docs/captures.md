# Provider captures

Owner request, 2026-11-17: "a tool that captures the communication between a provider
and a client if an error occurred or is being parsed incorrectly, exported to a file to be
uploaded to me to be fixed."

A capture is the full exchange of one gateway request:

- what the client sent;
- every HTTP call ClawRouter made to a provider (retries and failovers included), as it
  went over the wire: method, URL, headers, body, and the provider's raw reply or stream;
- what the client received (the JSON answer, or the stream events sent until it ended);
- the request's outcome and attempt trace, as request history shows them.

Request history keeps metadata only (spec §22). Captures are the one place message
text is stored, so they are **off by default** and kept to requests that went wrong,
unless an administrator asks for more.

## Owner's choices

| Question | Answer |
| --- | --- |
| When | Automatically on provider errors and unreadable replies, **plus** a manual "capture the next N requests" |
| Content | The full exchange is stored; the export dialog has **Mask message text** |
| Retention | **Until deleted**, capped by count (oldest deleted beyond it) |
| Access | Not decided by the owner ("I don't know"): a new permission, `captures.manage`, which only Administrators hold until a custom role is given it |

## Turning it on

Settings → Data retention → **Provider captures**:

- **Capture provider errors** (`capturesEnabled`, off by default). When off, nothing is
  recorded at all (no copying, no cost) and a manual capture cannot start; existing
  captures stay.
- **Captures kept** (`capturesMaxCount`, 500, 10–10,000). Beyond it, the oldest are deleted
  as new ones arrive.

## What is kept

While captures are on, every gateway request is recorded as it runs. When it ends, the
recording is:

| Kept as | When |
| --- | --- |
| **Unreadable reply** (`parse_error`) | a provider call ended in `invalid_response`: a reply ClawRouter could not parse (not JSON, missing fields, a broken stream event) |
| **Provider error** (`error`) | any provider call failed (HTTP error, timeout, network, a stream cut off), even when a failover then answered |
| **Manual capture** (`manual`) | nothing failed, but a running manual capture matched the request |
| (dropped) | anything else, and requests refused before reaching a provider (bad input, rate limits, unknown model) |

A cancelled call (the client went away) is not an error.

**Manual capture** (System → Captures → *Capture next requests…*): the next 1–100 requests,
optionally only those that tried one provider and/or one model (as requested or as
routed), within 1–1,440 minutes. One at a time, held in memory by the process (a restart
ends it). Use it for replies that look wrong but raise no error. Starting and stopping are
audited.

## Secrets

No credential reaches a capture:

- request headers whose name looks like a credential (`authorization`, `x-api-key`,
  `x-goog-api-key`, `cookie`, anything with `token`/`secret`/`key`) are replaced with `[REDACTED]`;
- credential query parameters (`?key=` for Google) are replaced in the URL;
- the provider's API key is cut out of every recorded text, and secret-shaped strings
  (ClawRouter keys, `sk-…`, `gsk_…`, `AIza…`, bearer tokens) are scrubbed, as in logs;
- the client's ClawRouter key never appears: the client's headers are not recorded.

Tests check that neither key is anywhere in a capture (`packages/api/test/captures-api.test.ts`).

## Export

Select captures (up to 50) or open one, then **Export…**. The file is JSON:

```json
{
  "format": "clawrouter-capture", "version": 1, "clawrouterVersion": "0.1.0",
  "exportedAt": "…", "masked": false,
  "captures": [{ "id": "cap_…", "trigger": "parse_error", "requestId": "req_…", "endpoint": "chat.completions",
                 "outcome": { … }, "attempts": [ … ], "client": { … }, "exchanges": [ … ] }]
}
```

**Mask message text** replaces every string in the bodies with its length
(`[masked: 42 chars]`), except structure (model, role, type, ids, finish reasons, names,
media types…) and anything inside an `error` object. Numbers, booleans and keys stay, so
field-shape problems can still be found. Streams are masked event by event; non-JSON
bodies (an HTML error page) are masked whole. Leave it off when the problem may be in the
text itself. Every export is audited with its capture ids and whether it was masked.

## Checked live (Groq, 2026-11-17)

Through the session's network secret for api.groq.com (ClawRouter held only a placeholder key):

| Scenario | Client got | Kept as |
| --- | --- | --- |
| A model Groq does not have | 502 | Provider error: Groq's own 404 body (`model_not_found`) |
| An alias whose first target is that model | 200 (failover) | Provider error: the 404, then Groq's 200 answer |
| `max_tokens: 900000` on gpt-oss-20b | 400 | Provider error: what was sent (`max_completion_tokens`, as the adapter translates it) and Groq's 400 |
| A streamed tool call on qwen3.8-27b, manual capture | 200 | Manual capture: Groq's raw stream, complete |
| A plain successful request | 200 | Not kept |

A request ClawRouter refuses itself (`max_tokens` over 1,000,000) never reaches a provider, so
there is nothing to capture; it is in request history only. Both exports (full and masked) were
scanned: no placeholder key, no ClawRouter key, no `gsk_` key, no bearer token;
`authorization` shows `[REDACTED]` on every call.

## Limits

- Each body is kept up to **256 KB**; the rest is counted (`bytes`, `truncated`). A large
  inline image can fill that.
- A capture copies bodies in memory while the request runs; with captures on, every
  request pays that (it stays small: one copy, bounded per body).
- Manual captures are per process (several nodes would each run their own).

## Code

| Where | What |
| --- | --- |
| `packages/providers/src/tap.ts` | `ExchangeTap`: wraps the provider `fetch`, copies requests and replies (streams pass through untouched) |
| `packages/gateway/src/capture.ts` | `RequestCapture`: one per request; an attempt per tap; decides at the end |
| `packages/gateway/src/service.ts` | `startRun` creates it while recording; `run.call` gives each attempt its tap |
| `packages/captures/` | repository (migration 0023), masking, the service (manual capture, export, delete, trim) |
| `packages/api/src/controllers/captures.ts` | `/api/captures*`, all `captures.manage` |
| `apps/console/src/features/captures/` | the page, the detail, export and manual dialogs |

## API

| Route | |
| --- | --- |
| `GET /api/captures/state` | switch, manual capture, count, limit |
| `GET /api/captures?page&pageSize&trigger&providerId&requestId` | summaries, newest first |
| `GET /api/captures/:id` | the whole capture |
| `POST /api/captures/manual` | `{ providerId?, model?, count, minutes }` |
| `DELETE /api/captures/manual` | stop it |
| `POST /api/captures/delete` | `{ ids }` or `{ all: true }` |
| `POST /api/captures/export` | `{ ids, maskText }` → the file, as a download |

Screenshots: [`screenshots/30-captures/`](screenshots/README.md#30--provider-captures).
