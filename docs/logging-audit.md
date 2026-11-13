# Logging and audit (phase 13)

Operational and security traceability (spec §27, §28): what the server did
(logs), and who changed what (audit), without exposing secrets.

## Redaction

Everything written to a log record, an audit record's metadata, or the Logs page
passes through `redact` (`packages/core/src/redact.ts`):

1. **By field name:** values of fields named like secrets (`password`, `secret`,
   `token`, `authorization`, `cookie`, `apiKey`, `credential`, `privateKey`…)
   become `[REDACTED]`.
2. **By shape** (phase 13): secret-shaped strings are scrubbed wherever they
   appear, including inside error messages, stack traces and log messages:
   - ClawRouter API keys keep their public prefix: `crk_3f9a1c2b_[REDACTED]`;
   - OpenAI and Anthropic style keys (`sk-…`, `sk-ant-…`, `sk-proj-…`) become `sk-[REDACTED]`;
   - Google keys (`AIza…`) become `AIza[REDACTED]`;
   - `Bearer` and `Basic` credentials become `Bearer [REDACTED]`.

The second layer catches keys that reach a message rather than a field, for
example a provider error that echoes the key it was sent. A test runs real flows
(sign-in failures, a provider with a wrong key, gateway calls with valid and
invalid API keys) and checks that no password, provider key, API key or session
token is in the log buffer.

Nothing in the console can turn redaction off.

## Logs

- Structured JSON (or pretty) lines on stdout and stderr, as before, at
  `CLAWROUTER_LOG_LEVEL`. **This is the log of record**: collect it with whatever
  runs the server (systemd, Docker, a log shipper).
- In addition, the most recent records are kept **in memory** for the console:
  `CLAWROUTER_LOG_BUFFER_SIZE` (default 5000; 0 turns it off). They are lost on
  restart, and the oldest drop out first. Records above 16 KB keep only a note.
- `GET /api/logs` (`logs.read`: Administrators and Operators; records include
  client addresses):
  - **filters:** minimum `level`, `component`, `requestId`, `providerId`,
    `userId`, and `q` (text in the message or any field);
  - **paging:** newest first, `limit` up to 500; `before=<seq>` loads older
    records, `after=<seq>` fetches only newer ones (follow);
  - the response also says how many records the buffer holds, since when, and
    which components appear.

**Request correlation:** every API and gateway response has an `x-request-id`, and
log records about a request carry it. The Requests detail and the Audit detail
link to `/logs?requestId=…`.

## Audit

- Append-only `audit_log` (phase 2): no update or delete exists in code. Every
  state change worth knowing is recorded with timestamp, actor, action, resource,
  resource id, result, client address, request id and redacted metadata.
- Actions:
  - sign-in, sign-out and failed sign-in, setup;
  - providers and credentials, connection tests;
  - models, routing, rate limits;
  - API keys (created, updated, revoked);
  - roles and sessions;
  - operations (started, cancelled).
- `GET /api/audit` (`audit.read`: Administrators and Operators):
  - **filters:** `action`, `result`, `resource`, `resourceId`, `actor` (text in
    the username), `requestId`, `from` and `to`, and `q` (text in the actor,
    resource id, address, request id or metadata);
  - wildcards typed by users are literal;
  - server-side paging with a total, and the resource types present for the
    filter.

## Console

- **System → Logs:**
  - **filters:** level, component, search, request, provider, user; they are
    kept in the address, so views can be linked to;
  - **Follow new records:** fetches only newer records every 2 s;
  - **Load older records**, and a record's full JSON with a copy button.
- **System → Audit:**
  - **filters:** action, result, resource, actor, search, and a period (24 hours
    to all);
  - paging, and a detail with the metadata and a link to the request's logs.

## Not yet

- Log retention beyond the in-memory buffer is left to the platform running
  ClawRouter (stdout); storing logs in SQLite would compete with request traffic.
- Audit export (CSV) and audit retention settings (the audit log is kept forever).
- Live-updating audit list (refresh on demand; the Logs page follows by polling,
  since a WebSocket feed of every log line would be costly and noisy).
