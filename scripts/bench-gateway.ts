/**
 * Gateway benchmark (phase 16): the time ClawRouter adds to a /v1 request, with a
 * registry of realistic size, and the heap over many requests.
 *
 *   bun run bench:gateway                       5,000 models, 2,000 timed requests
 *   bun run bench:gateway --models 50           a small registry, for comparison
 *   bun run bench:gateway --memory 20000        also run 20k requests and report the heap
 *   bun --cpu-prof-md scripts/bench-gateway.ts  CPU profile (markdown) of the run
 *
 * Runs the whole application in memory (tests/support/harness.ts) against the
 * local mock provider; never calls a real provider.
 */
import type { ApiSuccess, CreatedApiKey } from '@clawrouter/shared';
import { createHarness } from '../tests/support/harness.ts';
import { startMockProviders } from '../tests/support/mock-providers.ts';

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const MODELS = arg('models', 5000);
const REQUESTS = arg('requests', 2000);
const CONCURRENCY = arg('concurrency', 20);
const MEMORY = arg('memory', 0);

const mock = startMockProviders();
const h = createHarness();
h.setProviderFetch(fetch);
const admin = await h.completeSetup();
const post = async <T>(path: string, json: unknown) => ((await (await h.request(path, { method: 'POST', cookie: admin, json })).json()) as ApiSuccess<T>).data;

const actor = { id: 'bench', username: 'admin' };
const provider = await h.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key }, { ip: null });
h.models.create(actor, { providerId: provider.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'] }, { ip: null });
// The rest of the registry: other providers' models the router has to consider.
const at = new Date(h.clock.time).toISOString();
const fillers = Math.max(1, Math.ceil(MODELS / 20));
h.db.transaction((tx) => {
  for (let p = 0; p < fillers; p++) {
    tx.run('INSERT INTO providers (id, name, identifier, kind, endpoint, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [`filler-${p}`, `Filler ${p}`, `filler-${p}`, 'openai_compatible', 'http://127.0.0.1:1/v1', 200, at, at]);
  }
  for (let m = 1; m < MODELS; m++) {
    tx.run(`INSERT INTO models (id, provider_id, provider_model_id, display_name, capabilities, availability, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, '["CHAT"]', 'AVAILABLE', 'DISCOVERED', ?, ?)`, [`fm-${m}`, `filler-${m % fillers}`, `model-${m}`, `Model ${m}`, at, at]);
  }
});
const { secret } = await post<CreatedApiKey>('/api/api-keys', { name: 'bench' });
// Plenty of room: the benchmark measures the pipeline, not the limiter refusing it.
const limits = ((await (await h.request('/api/rate-limits', { cookie: admin })).json()) as ApiSuccess<{ version: number }>).data;
const saved = await h.request('/api/rate-limits', {
  method: 'PUT', cookie: admin,
  json: {
    version: limits.version, perKey: { requestsPerMinute: 1_000_000, tokensPerMinute: null }, perUser: { requestsPerMinute: null, tokensPerMinute: null },
    perModel: [], global: { requestsPerMinute: null, tokensPerMinute: null, maxConcurrent: 10_000 }, invalidKeysPerIp: 20,
  },
});
if (saved.status !== 200) throw new Error(`could not raise the rate limits: ${await saved.text()}`);

const body = JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] });
const callGateway = async () => {
  const res = await h.request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body });
  await res.text();
  if (res.status !== 200) throw new Error(`gateway answered ${res.status}`);
};
const callProvider = async () => {
  const res = await fetch(`${mock.url}/openai/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${mock.key}`, 'content-type': 'application/json' }, body });
  await res.text();
};

async function timed(n: number, fn: () => Promise<void>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn();
    out.push(performance.now() - t);
    if (i % 50 === 0) h.clock.advance(1000); // let rate-limit windows and caches see time pass
  }
  return out.sort((a, b) => a - b);
}
const q = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
const fmt = (xs: number[]) => `p50 ${q(xs, 0.5).toFixed(2)}  p95 ${q(xs, 0.95).toFixed(2)}  p99 ${q(xs, 0.99).toFixed(2)} ms`;

await timed(100, callGateway); // warm up
await timed(100, callProvider);
const provider_ = await timed(REQUESTS, callProvider);
const gateway = await timed(REQUESTS, callGateway);
console.log(`Registry: ${MODELS} models, ${fillers + 1} providers`);
console.log(`Provider alone (mock, over HTTP): ${fmt(provider_)}`);
console.log(`Through ClawRouter:              ${fmt(gateway)}`);
console.log(`Added by ClawRouter (p50):       ${(q(gateway, 0.5) - q(provider_, 0.5)).toFixed(2)} ms`);

const t = performance.now();
let done = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (done < REQUESTS) {
    done++;
    await callGateway();
  }
}));
console.log(`Throughput (${CONCURRENCY} concurrent): ${Math.round(REQUESTS / ((performance.now() - t) / 1000))} requests/s`);

if (MEMORY) {
  const heap = () => {
    Bun.gc(true);
    return process.memoryUsage().heapUsed / 1048576;
  };
  const start = heap();
  const marks: string[] = [];
  for (let i = 1; i <= MEMORY; i++) {
    await callGateway();
    // The harness keeps every log record, and the mock every call, for tests to inspect.
    if (i % 1000 === 0) {
      h.logs.length = 0;
      mock.requests.length = 0; // likewise the mock provider's record of calls
    }
    if (i % 50 === 0) h.clock.advance(1000);
    if (i % Math.floor(MEMORY / 4) === 0) marks.push(`${i}: ${heap().toFixed(1)} MB`);
  }
  console.log(`Heap: start ${start.toFixed(1)} MB → ${marks.join(' → ')}`);
}
await mock.stop();
process.exit(0);
