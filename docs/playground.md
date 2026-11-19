# Playground and chat apps

Owner request, 2026-11-18: a playground page in the console, with a section near the bottom
listing Open WebUI and LibreChat and links to tested setup guides for each.

**Gateway → Playground** lets any signed-in user chat with a model through the real
gateway, as one of their own API keys. It is for trying a provider, alias or routing rule
without curl or a separate app, and for seeing what an application would get.

## How it works

- **Acts as one of your keys.** You pick one of your own **active** keys. The browser sends
  the key's id, never its secret: your sign-in proves the key is yours. The server loads it
  with `ApiKeyService.ownPrincipal(userId, keyId)` (another user's key, a revoked or expired
  one, or an unknown id are all refused alike, 400 on `keyId`).
- **The real gateway.** `POST /api/playground/chat` hands a Chat Completions body to
  `gateway.chat()`, the same `runChat` pipeline as `/v1/chat/completions`. So the key's
  allowed models, model lifetime limits, rate limits, the owner's quota, routing, retries,
  failover, notices, captures, request history and usage all apply. The request is
  recorded under the key, as endpoint `/v1/chat/completions`.
- **The model list** is `GET /api/playground/models?keyId=`, the same list `/v1/models`
  returns for that key (aliases first).
- **Nothing stored.** The conversation lives in the page and is gone when you leave or press
  **Clear conversation** (spec §22). Failed and stopped answers are not sent back in the
  conversation. Only the chosen key and model are remembered, in this browser.
- **Access:** both routes need the `playground.use` permission (Administrator, Operator and
  Viewer have it; custom roles get it in the role editor, and migration 0026 gave it to every
  custom role that existed before, so nobody lost the playground on upgrade). The key must be
  your own. Users without a key see how to create or request one.
- **Off switch:** Settings → API keys and quotas → Playground ("Let users chat in the
  playground", `playgroundEnabled`, on by default). When off, the menu item and its tour sentence disappear for
  everyone, administrators included; `/playground` opened directly says "The playground has been
  disabled"; and both routes answer **403** to anyone signed in (before the permission check),
  so a program can tell why:

  ```json
  { "error": { "code": "AUTHORIZATION_ERROR", "message": "The playground has been disabled by an administrator.",
    "details": { "reason": "feature_disabled", "feature": "playground" }, "requestId": "req_…" } }
  ```

  Without `playground.use` (while it is on) the answer is the usual 403 with no `reason`. The session's `playground` field tells the console.
  The chat-app guides in `docs/clients/` stay available; only their card in the playground goes.

Each answer shows the model that answered (`X-ClawRouter-Model`), the attempts when more
than one, tokens (streams ask for usage with `stream_options.include_usage`), the time to
the first byte and in total, a finish reason other than `stop`, and the notices ClawRouter
sent (header). Users with `requests.read` get **Request details**, the same dialog as the
Requests page, with each attempt.

When the provider sends the model's reasoning apart from the answer (`reasoning_content`; see
[gateway: reasoning](gateway.md#reasoning)), it appears above the answer in a collapsed
**Reasoning** panel. It is never sent back with the conversation.

Settings: key, model, system prompt, streaming (on by default), temperature and maximum
tokens (empty means the model's default). Text only: images, files and tools are not offered
in the playground.

## Chat apps

The **Use ClawRouter from other apps** card at the bottom shows this server's base URL
(`<origin>/v1`) with a copy button, and one card per tested application
(`features/playground/chat-clients.ts`): a summary, **Show configuration** (the essential
configuration, filled in with this server's address) and a link to its setup guide:

- [Open WebUI](clients/open-webui.md): environment variables; turn off its built-in tools to
  see notices in replies.
- [LibreChat](clients/librechat.md): a custom endpoint in `librechat.yaml`; every-request
  announcements also name conversations.
- [Claude Code](clients/claude-code.md): environment variables, through the Anthropic-compatible
  `/v1/messages`; the model needs Tool use and room for large requests.

The guide links point at the repository on GitHub (`docs/clients/`). Each guide says what was
tested and how. Add a client only after testing it the same way, and update the tested
version when you re-test.

## Tests

`packages/api/test/playground-api.test.ts`: a chat as your own key, recorded under it;
streaming; the model list and the key's allowed models; another user's, revoked and missing
keys refused; no session (401); an invalid body; the off switch (403 `feature_disabled` for everyone, the
session flag) and the permission (403 for a custom role without it). The migration test
checks existing custom roles get `playground.use`. Navigation tests include the page and the
switch. Screenshots: `docs/screenshots/33-playground/`, `39-playground-switch/`.
