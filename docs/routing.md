# Routing engine (phase 7)

Decides which models a request goes to, in what order, and what happens when one
fails (spec §10, §11). The gateway (phase 8) executes the plan; routing itself
never calls a provider.

## Design

- **Pure engine.** `planRoute(request, snapshot)` in `packages/routing/src/engine.ts`
  has no HTTP, database, clock or UI dependencies (spec §2.4). It receives the
  routing configuration, every registered model (usable or not), provider
  priorities and recent failures, and returns a plan or a reason why nothing is
  routable.
- **Configuration** is one versioned document (`routing_config`, migration
  `0008_routing`), saved whole with optimistic concurrency.
- **`RoutingService`** loads a fresh snapshot for each plan and turns
  "nothing routable" into a `ROUTING_ERROR`.

## Resolving the requested model

What a client sends as `model` is resolved in this order:

| Order | Form | Example | Meaning |
|---|---|---|---|
| 1 | Alias | `fast-code` | The alias's targets (case-insensitive name). Aliases win over model ids with the same name |
| 2 | Model reference | `openai/gpt-4o` | Exactly that model |
| 3 | Provider model id | `gpt-4o-mini` | That model on **every** provider offering it, by provider priority |

Anything else fails with "Unknown model". A disabled alias fails with "The alias … is disabled".

### Aliases

```
fast-code
  ├─ priority 0  alpha/gpt-4o-mini
  ├─ priority 1  beta/claude-sonnet   (weight 3)
  │              ollama/qwen2.5-coder (weight 1)
  └─ requires CODING · policy: default
```

- **Targets** are model references with a **priority** (lower first) and a
  **weight** (1–1000). Targets with the same priority share traffic by weight.
- **Required capabilities** apply to every target. An alias with **no targets**
  is a *capability alias*: any usable model with those capabilities, by provider
  priority (e.g. `embed` → any `EMBEDDINGS` model).
- **Policy**: the default, or the alias's own.

## Eligibility

A candidate model is used only if it is **usable** (enabled and still offered,
with its provider enabled and not offline or disabled; see [models](models.md))
and has every **required capability**. Capabilities come from the alias plus the
request (the gateway will add e.g. `VISION` for image input, `EMBEDDINGS` for
`/v1/embeddings`). Every model left out is reported with its reason:

```
Model is disabled · Provider is disabled · Provider is offline ·
No longer offered by the provider · Model is not registered · Missing capabilities: VISION
```

## Ordering

1. **Priority**: alias target priority, or provider priority for model-id and
   capability routing. Administrator intent comes first: a degraded primary is
   still tried first.
2. **Health within a priority level**: `HEALTHY`, then `UNKNOWN` (not checked
   yet), then `DEGRADED`.
3. **Weighted random choice** among equals. The random source is injectable:
   with a seeded one (`seededRandom`) plans are fully reproducible, which tests
   rely on.
4. **Failure history**: a provider with 3 or more failures in the last minute
   (`FailureTracker`) moves to the back of the plan. It stays as a last resort
   rather than being dropped. A success clears it. The gateway records outcomes
   from phase 8.

## Failover policies (spec §11)

| Policy | Attempt sequence (3 candidates, 1 retry) |
|---|---|
| `NONE` | A |
| `RETRY_SAME_PROVIDER` | A, A |
| `FAILOVER_PROVIDER` | A, B, C |
| `RETRY_AND_FAILOVER` (default) | A, A, B, B, C, C |

The sequence is cut at **`maxAttempts`** (default 3). The server enforces a hard
ceiling of **10 attempts per request**, so no configuration can cause a retry loop.
`retriesPerTarget` is 0–3. The default policy is `RETRY_AND_FAILOVER`, 3 attempts,
1 retry per model.

## API

| Method | Path | Requires | |
|---|---|---|---|
| GET | `/api/routing` | `routing.read` | Configuration plus `problems` (dangling targets, aliases with nothing usable) |
| PUT | `/api/routing` | `routing.write` | Replace the configuration. Send the `version` you loaded; a stale version is **409** |
| POST | `/api/routing/preview` | `routing.read` | `{ model, capabilities? }` → the plan, or 502 `ROUTING_ERROR` with `details.excluded`. A dry run |

Validation on save:
- alias names: 1–64 characters, no `/`, unique ignoring case;
- targets: registered models, no duplicates, priority 0–1000, weight 1–1000;
- each alias has targets or capabilities; policies are in range;
- at most 500 aliases and 50 targets per alias.

A target whose model was deleted **after** it was saved stays valid, so it doesn't
block unrelated edits. It is reported under `problems` instead.

Every save is audited as `ROUTING_UPDATED`, with the new version and which aliases
were added, removed or changed. It also emits `routing.changed`.

## Console

AI Infrastructure → **Routing**:
- a problems strip;
- the default policy, with an edit dialog;
- the alias table, with targets in order, required capabilities, policy and
  status (Routable, Disabled, or the problem);
- the alias dialog: targets with priority and weight, capabilities, policy override;
- the **route tester**, which shows the attempt sequence for any model name and
  what was left out and why.

If someone else saved first, the console reloads the latest version and asks you
to apply your change again.

## Not yet

- Executing plans, retries and failover, and recording failures: the gateway (phase 8).
- Latency-aware, cost-aware and token-aware routing, and circuit breakers (future roadmap, spec §41).
- The alias dialog lists the first 200 models. A searchable picker is needed for
  very large registries.
