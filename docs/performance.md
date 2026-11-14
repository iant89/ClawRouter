# Performance (phase 16)

Spec §35: hundreds of providers, thousands of models, large request, audit and log
histories; server-side pagination and filtering; indexed queries; nothing
unbounded in the browser. Everything below was measured, changed, and measured
again with the two benchmark scripts.

## Benchmarks

| Command | What it does |
|---|---|
| `bun run bench:db` | Seeds a temporary SQLite database (300 providers, 5,000 models, 1,000 keys, 500k requests, 400 days of hourly usage, 300k audit records) and times the console's queries through the real repositories, with each statement's query plan. Options: `--requests N`, `--audit N`, `--models N`, `--runs N`, `--keep`. |
| `bun run bench:gateway` | Runs the whole application in memory against the mock provider and times `/v1/chat/completions`: latency added by ClawRouter, throughput with 20 concurrent clients, and (`--memory N`) the heap over N requests. Options: `--models N`, `--requests N`, `--concurrency N`. |
| `bun --cpu-prof-md scripts/bench-gateway.ts` | The same with a CPU profile in Markdown. `--heap-prof-md` for the heap. |

Neither touches the configured database or a real provider.

## Results

Times are medians on the development container; compare runs on one machine only.

### Database (500k requests, 300k audit records)

| Query | Before | After | Change |
|---|---:|---:|---|
| Requests by model | 143 ms | 0.6 ms | NOCASE indexes on both model columns; the filter is a union of two index lookups (a plain `OR` walked the date index) |
| Requests by provider | 119 ms | 0.3 ms | index `requests(provider_id, received_at)` |
| Audit free text | 201 ms | 0.7 ms | trigram full-text index `audit_fts` (3+ characters) |
| Audit by resource id | 48 ms | 0.2 ms | index |
| Audit by request id | 46 ms | 0.03 ms | index |
| Audit resource filter options | 93 ms | 0.01 ms | index on `resource` |
| Other list, detail and chart queries | ≤ 30 ms | unchanged | already indexed |

Left as they are, and why:

- **Usage over a whole year, grouped by user: ~220 ms.** It sums ~290k hourly
  rows. Shorter ranges are a few milliseconds. Daily roll-ups would fix it if
  year-long charts become common.
- **Deep pages (page 200 of the request list): ~29 ms.** Offset paging reads the
  skipped rows; filters narrow results faster than paging.
- **Audit filter by actor: ~33 ms.** Actor names repeat across many records, so
  the trigram index matched too many rows (it was slower, 70 ms); it scans.

Cost of `audit_fts`: about 82 MB for 300k audit records (roughly 70% of the audit
table). It is filled from existing records by migration 0017 and kept in step by
triggers.

### Gateway (5,000 models, 251 providers)

| | Before | After |
|---|---:|---:|
| Time added per request (p50) | 17.7 ms | 0.6 ms |
| p99 | 29.5 ms | 4.0 ms |
| Throughput, 20 concurrent clients | 56 req/s | ~2,400 req/s |

The CPU profile showed 95% of the time in route planning, which reloaded the whole
registry from SQLite for every request. Routing now reuses a **snapshot** of the
configuration, models and provider priorities. A `model.*`, `provider.*` or
`routing.changed` event drops it at once, and it is reloaded after 5 seconds in any
case (`SNAPSHOT_MAX_AGE_MS` in `packages/routing/src/service.ts`). The console's
routing view always reads current data. With 50 models the figures were already
0.6 ms and ~1,800 req/s; the registry's size no longer matters.

### Memory

The dashboard metrics and the rate limiter kept one list entry per request
(token counts for a whole hour) and trimmed them only when read. At 100 requests/s
that was ~360,000 objects held; the benchmark missed it because its clock barely
moved. Both now use `RollingSum` (`packages/core/src/rolling-sum.ts`): fixed time
buckets, constant memory and time. Over 40,000 requests the heap stays at
9–11 MB (the routing snapshot of 5,000 models is ~3 MB of it). Rate-limit counters
were already bounded (at most 50,000 keys, idle windows swept).

### Live channel

Gateway activity was already coalesced into one message per second. Every
broadcast is now serialized once rather than once per connection.

### Console

| | Before | After |
|---|---:|---:|
| First script | 1.19 MB | 0.39 MB |
| …as sent (brotli) | 1.19 MB | 115 KB |
| Pages | all in the first script | one file each (4–25 KB), loaded on first visit |

- **Code splitting** (`bun build --splitting`, `React.lazy` per page in `App.tsx`).
  The icon set (~0.47 MB) is its own file, fetched in parallel. ENTERPRISE-UI's icon
  collection imports all 1,410 icons statically, so they still arrive together;
  only a change in ENTERPRISE-UI (per-icon loading) would avoid that.
- **Compression** (`apps/server/src/console-assets.ts`): scripts, styles and the page
  are sent brotli (quality 9) or gzip, compressed on first request and kept in
  memory, with `Vary: Accept-Encoding` and an ETag per encoding. Hashed files stay
  cached for a year. A script or style that is not in the build answers 404, and the
  console shows "ClawRouter was updated: reload" when a page file from an older
  build cannot load (an open tab during an upgrade).
- **API keys page on the server.** `GET /api/api-keys` takes `page`, `pageSize`
  (≤ 200), `q` (name, prefix or owner) and `status`; `meta` adds `total` and
  `active`. API Access has a search box, a status filter and pagination; the
  Requests page's key filter (`ApiKeyPicker`) searches keys as you type.
- **Model discovery** renders only the visible rows past 150 models (ENTERPRISE-UI
  `Table` virtualization; one line per model, the full name on hover).

Every other list that can grow was already paged on the server (requests, audit,
logs, sessions, operations, key requests, models). Providers, users and roles are
expected in the hundreds at most and are rendered in full.

### Connections

Bun's `fetch` keeps connections to providers alive and reuses them, so there is no
separate pool. SQLite runs on one connection in WAL mode (one writer, readers do
not block), with prepared statements cached (`raw.query`).

## Not done

- Year-long usage charts (~220 ms at this volume): daily roll-ups if needed.
- Per-icon loading needs ENTERPRISE-UI.
- Several ClawRouter nodes: the routing snapshot is per process like the other
  caches; a change made on one node reaches others within 5 seconds.
