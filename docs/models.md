# Model registry (phase 6)

Models are first-class entities (spec §9). The registry is how providers
expose usable models to the rest of ClawAPI: routing (phase 7) chooses among
them, and the gateway (phase 8) calls them through the provider engine.

## A model

| Field | Notes |
|---|---|
| `ref` | Stable public reference `<provider identifier>/<provider model id>`, e.g. `openai/gpt-4o-mini`. Unique, because provider identifiers cannot contain `/` |
| `providerModelId` | Exactly what the provider calls it (may itself contain `/` or `:`) |
| `displayName` | Defaults to the provider's display name, or the id |
| `capabilities` | `CHAT`, `CODING`, `REASONING`, `VISION`, `EMBEDDINGS`, `TOOL_USE`, `RESEARCH` |
| `contextLength`, `maxOutputTokens` | Filled from discovery when the provider publishes them (Google does); otherwise entered by hand |
| `cost` | Input and output price in USD per million tokens. Entered by hand: providers do not publish prices through their APIs. Used for cost estimates in phase 10 |
| `enabled` | Administrator switch |
| `availability` | The model's own state: `AVAILABLE`, `UNAVAILABLE`, `UNKNOWN` |
| `source` | `DISCOVERED` (imported from the provider's list) or `MANUAL` |

Models belong to their provider and are deleted with it.

## Availability vs. usability

Two things are kept apart, as the spec asks:

- **Model availability**: whether the provider still offers the model.
  `AVAILABLE` when its last model list included it, `UNAVAILABLE` when a later
  list did not, `UNKNOWN` until checked (e.g. a manually added model).
- **Usable** (computed): the model is enabled, not `UNAVAILABLE`, and its
  provider is enabled and not offline or disabled. `UNKNOWN` models and
  providers that are not checked yet count as usable but unverified, so a fresh
  setup can be used before the first check.

`unusableReason` says why not, in this order: model disabled, provider disabled,
provider offline, no longer offered. The same definition is used in SQL (the
"usable only" filter) and in code (`unusableReason`).

## Keeping availability current, for free

Connection tests, health checks and discovery all fetch the provider's model
list. Each listing emits the internal event `provider.models_listed`, and the
registry applies it:

- listed models become `AVAILABLE`, and missing limits are filled in (values an
  administrator entered are never overwritten);
- registered models that are not listed become `UNAVAILABLE`.

No extra provider calls are made. When an available model disappears, or comes
back, people with `models.read` get a notification.

## Discovery and import

1. **Discover** (`GET /api/providers/:id/models/discover`): the live list from
   the provider, each entry marked `registered` if already imported, with
   capabilities guessed: chat → `CHAT`, embeddings → `EMBEDDINGS`, anything else
   none. Google says which methods a model supports; for other providers the
   guess comes from the model id.
2. **Import** (`POST /api/providers/:id/models/import` with `providerModelIds`):
   the server fetches the list **again** and only imports ids the provider
   really offers. Already registered ids are skipped. At most 500 per request.

Capabilities and limits are a first guess. Review them after importing:
capability matching in routing depends on them.

## API

| Method | Path | Requires |
|---|---|---|
| GET | `/api/models?page=&pageSize=&providerId=&capability=&q=&usable=true` | `models.read` |
| GET | `/api/models/:id` | `models.read` |
| POST | `/api/models` (manual) | `models.write` |
| PATCH | `/api/models/:id` | `models.write` |
| DELETE | `/api/models/:id` | `models.write` |
| GET | `/api/providers/:id/models/discover` | `models.write` (calls the provider) |
| POST | `/api/providers/:id/models/import` | `models.write` |

Lists are paginated and filtered on the server (`meta: { page, pageSize, total }`,
at most 200 per page), ordered by provider priority, provider name and model
name. Search is case-insensitive over the display name, model id and provider
identifier.

Audit: `MODEL_CREATED` (one per model, with `source`), `MODEL_UPDATED` (changed
fields), `MODEL_ENABLED`, `MODEL_DISABLED`, `MODEL_DELETED`. Events:
`model.changed`, `model.availability`.

## For routing and the gateway

```ts
models.listUsable('CHAT');          // usable chat models, in priority order
models.resolveRef('openai/gpt-4o'); // ModelInfo | undefined
providers.chat(model.providerId, { model: model.providerModelId, messages });
```

## Console

AI Infrastructure → **Models**: filter bar (search, provider, capability,
usable only), availability with its reason, capabilities, context length and
prices. *Discover models* lets you pick models to import, with new chat and
embedding models pre-selected. *Add manually* covers providers that cannot list
models. Providers → *Discover models* / *View models* jump straight to a
provider's models.
