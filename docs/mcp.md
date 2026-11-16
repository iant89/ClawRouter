# MCP server

ClawRouter serves the [Model Context Protocol](https://modelcontextprotocol.io) at
`POST /v1/mcp`. An agent such as Claude Code connects to it and can then ask about
ClawRouter itself: "what did we spend this week?", "why did that request fail over?",
"is the Anthropic provider healthy?".

This is **ClawRouter as an MCP server**. It is separate from MCP servers that
clients use through the gateway: those already work, because the agent turns their
tools into ordinary tool definitions in chat requests (see [gateway](gateway.md)).
ClawRouter does not call MCP servers on anyone's behalf.

## Turning it on

Two switches, both **off by default** (owner, 2026-11-16: "off by default", with the
ability to enable or disable it):

1. **The server:** Settings → API keys and quotas → MCP server → "Let agents use the MCP
   server (/v1/mcp)" (setting `mcpEnabled`, `settings.write`, audited as
   `SETTINGS_CHANGED`, applies at once). While it is off, `/v1/mcp` answers **404 before
   any key is checked**, so its existence is not revealed, and the console hides every
   MCP control (the session reports `mcpServer`). Keys keep their MCP access for when it
   is turned on again.
2. **Each key**, as below.

MCP access is a per-key switch, **off by default** and off for every key that
existed before it. A key made for an application that only calls models can never
read administration data, even if it leaks.

- **API Access → Create key → "Allow MCP access"**, or **Turn on MCP access** in a
  key's menu (needs `api_keys.write`; the change is audited as `API_KEY_UPDATED`).
- **My API keys → Create key** offers the same switch for your own keys.
- API: `mcpAccess: true` in `POST /api/api-keys`, `PATCH /api/api-keys/:id` or
  `POST /api/me/api-keys`. `ApiKeyInfo.mcpAccess` shows it.

When a key with MCP access is created, the dialog shows a ready-made Claude Code
command and an `mcpServers` configuration:

```bash
claude mcp add --transport http clawrouter https://clawrouter.example.com/v1/mcp \
  --header "Authorization: Bearer crk_…"
```

## Whose permissions

A key acts for its owner, so **tools answer with the owner's permissions**, read
again for every message. `tools/list` lists only the tools the owner may use; calling
any other tool answers "unknown tool" (the same as one that does not exist, so a key
cannot probe for permissions). Removing a role takes its tools away immediately. A
disabled owner's keys stop working entirely (401), as on the gateway.

## Tools

Every tool only reads. None creates or changes anything, and none returns a secret:
in particular there is no "create key" tool, so a key never ends up in an agent's
conversation history.

| Tool | Permission | What it answers |
|---|---|---|
| `get_health` | `health.read` | Overall status and every component's check |
| `get_usage` | `usage.read` | Requests, tokens and cost over a period, broken down by model, provider, key or user (`includeSeries` adds hourly or daily buckets) |
| `list_requests` | `requests.read` | Request history, newest first, filtered by status, model, period or "problems only" (at most 50 a page) |
| `get_request` | `requests.read` | One request with every attempt (provider, model, outcome, latency) |
| `list_providers` | `providers.read` | Providers, their health and whether a credential is set (never the credential) |
| `list_models` | `models.read` | Registry entries with capabilities, limits and prices (search, capability, usable only) |
| `get_rate_limits` | `rate_limits.read` | The configured limits |
| `search_audit` | `audit.read` | Audit log search (text, action, result, actor, period) |
| `get_my_quota` | none (own data) | The key owner's quota and its use in the current period |
| `list_my_api_keys` | none (own data) | The key owner's keys (prefixes, never secrets) |

Periods take an ISO date-time or a look-back such as `"24h"` or `"7d"`. Answers are
JSON, both as text (for the model) and as `structuredContent`.

Wrong arguments (an unknown status, a limit out of range, an unknown request id) come
back as a **tool error** that says what to change, so the model can correct itself;
they are not protocol errors.

## Limits and logging

- Each `tools/call` goes through the key's **rate limits** (its own limit or the
  default per-key limit, plus per-user, global and concurrency), and answers 429 when
  over. `initialize`, `ping` and `tools/list` are free. Quotas are not charged: tool
  calls use no tokens.
- Each tool call is logged (`component: mcp`) with the tool, key prefix, outcome
  (`ok`, `tool_error`, `failed`) and duration. Tool calls are not audit records
  (nothing changes) and do not appear in request history (they are not model requests).

## Protocol details

- Streamable HTTP transport, **stateless**: no `Mcp-Session-Id`, no server-sent
  events. Every request is answered with one JSON-RPC response as
  `application/json`; notifications get `202`. `GET` and `DELETE` answer 405.
- Protocol versions `2025-11-25`, `2025-06-18` and `2025-03-26`. `initialize`
  echoes a supported version and otherwise offers the newest; an
  `MCP-Protocol-Version` header with an unsupported version is refused (400).
- Capabilities: `tools` only (no resources, prompts or sampling). Batches are refused
  (removed from the protocol in 2025-06-18).
- An `Origin` header from another host is refused (403), against DNS rebinding of a
  ClawRouter on localhost. Like the rest of `/v1`, there is no CORS.
- Body limit 256 KB. A key without MCP access gets 403; no key or a bad one, 401
  (and counts toward the invalid-key limit per address).

## Verified

- `packages/api/test/mcp-api.test.ts`: access, protocol, permissions, every tool,
  tool errors, rate limits and logging.
- 2026-11-16, against a production build with a real Groq request in its history:
  the official MCP TypeScript SDK client (connect, `tools/list`, tool calls, a
  gateway-only key refused) and Claude Code (`claude mcp add` then `claude mcp list`:
  "Connected"). An agent answering questions through it end to end was not tried
  (the Claude Code here had no account of its own).

## Code

`packages/api/src/mcp/server.ts` (protocol), `packages/api/src/mcp/tools.ts` (tools,
which call the same services as the console's API); the route is registered with the
`'mcp'` access level in `packages/api/src/app.ts`. Migration
`0021_api_key_mcp_access`. A new tool needs a permission (or `null` for the caller's
own data), an input schema, argument checks with `ToolInputError`, and a test.
