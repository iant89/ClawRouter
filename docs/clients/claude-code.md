# Claude Code with ClawRouter

[Claude Code](https://code.claude.com) speaks the Anthropic Messages API. ClawRouter
answers it at `/v1/messages`, so Claude Code can run on any model ClawRouter
routes to, with ClawRouter's keys, limits, quotas, usage tracking and audit.

**Tested** on 2026-11-19 with Claude Code **2.1.328** and ClawRouter `main`. See
[What was tested](#what-was-tested).

## 1. Prepare ClawRouter

- **An API key** for Claude Code: **Gateway → My API keys** (or **API Access**). Copy
  the key (`crk_…`); it is shown once.
- **A model that can use tools.** Claude Code offers tools with every request, so the
  model (or every target of the alias) must be marked **Tool use** under Models.
- **Enough room.** With its default tools, Claude Code's requests are tens of
  thousands of tokens. A provider with a small per-minute token limit (Groq's free
  tier: 7,000–8,000 per model) cannot serve them; see [Smaller requests](#smaller-requests).
- **An alias** is the simplest model name to give Claude Code, for example `code`
  pointing at your best tool-using model, with fallbacks.

## 2. Point Claude Code at ClawRouter

Set these environment variables where you start Claude Code (shell profile, or the
`env` block of Claude Code's `settings.json`):

```bash
export ANTHROPIC_BASE_URL=https://clawrouter.example.com   # no /v1: Claude Code adds it
export ANTHROPIC_AUTH_TOKEN=crk_your_key                   # sent as Authorization: Bearer
export ANTHROPIC_MODEL=code                                # the main model: an alias or provider/model
export ANTHROPIC_DEFAULT_HAIKU_MODEL=code                  # background work (titles, summaries)
```

- `ANTHROPIC_API_KEY=crk_…` works too (sent as `x-api-key`). Set only one of the two:
  when both are set, Claude Code uses the API key.
- To have Claude Code's `/model` menu pick ClawRouter models, also set
  `ANTHROPIC_DEFAULT_SONNET_MODEL` and `ANTHROPIC_DEFAULT_OPUS_MODEL`.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` keeps Claude Code from contacting
  Anthropic for anything else (updates, telemetry).

Then run `claude` as usual.

## What to expect

- **Requests and usage** appear under **Gateway → Requests** as `/v1/messages`, with the
  key's name, the model that answered, attempts, tokens and estimated cost.
- **Cost shown by Claude Code** is its own guess from Claude's prices, and it prints
  `unrecognized_model` for names it does not know. ClawRouter's Usage page has the real
  cost.
- **Announcements and notices** travel in the `X-ClawRouter-Notices` header only:
  ClawRouter never writes text into requests that offer tools, and Claude Code always
  does.
- **Claude-only features are ignored or refused.** Thinking and effort settings, prompt
  caching and `top_k` are accepted and ignored (other models have no equivalent). Thinking
  blocks from earlier turns are dropped. Anthropic's server tools (web search and web
  fetch run by Anthropic) are refused: Claude Code's WebSearch fails, while its own
  WebFetch and every local tool work.
- **Errors** come back in Anthropic's format, so Claude Code shows them and retries
  rate limits after the `Retry-After` that ClawRouter passes on from the provider.

## Smaller requests

For a provider with tight limits, start Claude Code with fewer tools and a short system
prompt. This is how it was tested live on Groq's free tier:

```bash
claude -p "Read note.txt and tell me the secret word." \
  --tools "Read" --system-prompt "You are a terse assistant."
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `authentication_error` | The key is wrong, revoked or expired, or `ANTHROPIC_API_KEY` is also set and holds another key. |
| `not_found_error: The model '…' does not exist` | `ANTHROPIC_MODEL` (or the Haiku/Sonnet/Opus variables) names no alias or model in ClawRouter. Claude's own names (e.g. `claude-sonnet-5-5`) work only if you create an alias with that name. |
| `No model for '…' supports tools` | Mark the model Tool use under Models. |
| `The request is too large for the model` or `rate_limit_error` | The provider's per-minute token limit; see [Smaller requests](#smaller-requests), or add fallback targets to the alias. |
| `The server tool 'web_search_…' runs on Anthropic's servers` | Claude Code's WebSearch: not available through ClawRouter. |

## What was tested

Tested on 2026-11-19 with Claude Code 2.1.328, started with a clean environment
(`env -i`) and only the variables above, against a development ClawRouter:

- **Live, with Groq** (the alias `chat` on `groq/openai/gpt-oss-20b`): a question
  answered correctly with no tools (`--tools ""`); and an agent loop with the Read tool
  (`--tools "Read"`): Claude Code called Read, sent the file back as a `tool_result`,
  and the model answered from it, in two turns.
- **Claude Code's full default request** (every tool, its full system prompt and
  settings) against the project's mock OpenAI server, because it is too large for
  Groq's free tier: accepted, a tool call and its result went round, the run finished
  without errors.
- The official Anthropic TypeScript SDK (1.10.0) against Groq: messages, streams, a
  tool round trip, a streamed tool call, `count_tokens`, the model list and typed errors.
