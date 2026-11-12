import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type {
  ApiKeyInfo, ApiSuccess, CreatedApiKey, GatewayMetrics, PutRateLimitsRequest, RateLimitConfigView, RateLimitUsage,
} from '@clawrouter/shared';
import { createHarness, type Harness } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

let mock: MockProviders;
beforeAll(() => {
  mock = startMockProviders();
});
afterAll(() => mock.stop());
beforeEach(() => {
  mock.mode = 'ok';
  mock.failFamilies.clear();
  mock.streamDelayMs = 0;
});

const actor = { id: 'u', username: 'admin' };
const client = { ip: null };
type OpenAiError = { error: { message: string; type: string; code: string } };
const json = async <T>(res: Response) => (await res.json()) as T;
const data = async <T>(res: Response) => (await json<ApiSuccess<T>>(res)).data;

/** OpenAI and a local server, both offering gpt-4o-mini; one admin key. */
async function world() {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const openai = await h.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key, priority: 10 }, client);
  const local = await h.providers.create(actor, { name: 'Local', identifier: 'local', kind: 'openai_compatible', endpoint: `${mock.url}/local/v1`, priority: 20 }, client);
  h.models.create(actor, { providerId: openai.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'] }, client);
  h.models.create(actor, { providerId: local.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'] }, client);
  const key = await createKey(h, admin, { name: 'ci' });
  return { h, admin, key };
}

async function createKey(h: Harness, cookie: string, body: Record<string, unknown>): Promise<CreatedApiKey> {
  const res = await h.request('/api/api-keys', { method: 'POST', cookie, json: body });
  expect(res.status).toBe(201);
  return data<CreatedApiKey>(res);
}

async function setLimits(h: Harness, cookie: string, patch: Partial<PutRateLimitsRequest>): Promise<Response> {
  const current = await data<RateLimitConfigView>(await h.request('/api/rate-limits', { cookie }));
  const { unknownModels: _u, updatedAt: _a, updatedBy: _b, ...rest } = current;
  return h.request('/api/rate-limits', { method: 'PUT', cookie, json: { ...rest, ...patch } });
}

const chat = (h: Harness, key: string, extra: Record<string, unknown> = {}, init: RequestInit & { ip?: string } = {}) =>
  h.request('/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${key}` },
    json: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }], ...extra }, ...init,
  });

describe('per-key request limits', () => {
  test('the default per-key limit applies, with OpenAI-style headers and a 429 once used up', async () => {
    const { h, admin, key } = await world();
    expect((await setLimits(h, admin, { perKey: { requestsPerMinute: 3, tokensPerMinute: null } })).status).toBe(200);
    const first = await chat(h, key.secret);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-ratelimit-limit-requests')).toBe('3');
    expect(first.headers.get('x-ratelimit-remaining-requests')).toBe('2');
    expect(first.headers.get('x-ratelimit-reset-requests')).toMatch(/^\d+s$/);
    await chat(h, key.secret);
    await chat(h, key.secret);
    const limited = await chat(h, key.secret);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(limited.headers.get('x-ratelimit-remaining-requests')).toBe('0');
    const err = (await json<OpenAiError>(limited)).error;
    expect(err).toMatchObject({ type: 'rate_limit_error', code: 'rate_limit_exceeded' });
    expect(err.message).toContain('this API key (3 requests per minute)');
    // The window slides: two idle minutes later the key works again.
    h.clock.advance(120_000);
    expect((await chat(h, key.secret)).status).toBe(200);
  });

  test('a key can have its own limit, or none, and PATCH null goes back to the default', async () => {
    const { h, admin, key } = await world();
    await setLimits(h, admin, { perKey: { requestsPerMinute: 1, tokensPerMinute: null } });
    const own = await h.request(`/api/api-keys/${key.key.id}`, { method: 'PATCH', cookie: admin, json: { rateLimit: { requestsPerMinute: null, tokensPerMinute: null } } });
    expect(own.status).toBe(200);
    expect((await data<ApiKeyInfo>(own)).rateLimit).toEqual({ requestsPerMinute: null, tokensPerMinute: null });
    for (let i = 0; i < 4; i++) expect((await chat(h, key.secret)).status).toBe(200);
    expect(h.audit.list({ action: 'API_KEY_UPDATED' })).toHaveLength(1);

    const back = await h.request(`/api/api-keys/${key.key.id}`, { method: 'PATCH', cookie: admin, json: { rateLimit: null } });
    expect((await data<ApiKeyInfo>(back)).rateLimit).toBeNull();
    h.clock.advance(120_000);
    expect((await chat(h, key.secret)).status).toBe(200);
    expect((await chat(h, key.secret)).status).toBe(429);

    const bad = await h.request(`/api/api-keys/${key.key.id}`, { method: 'PATCH', cookie: admin, json: { rateLimit: { requestsPerMinute: -1 } } });
    expect(bad.status).toBe(400);
    const created = await createKey(h, admin, { name: 'own', rateLimit: { requestsPerMinute: 2, tokensPerMinute: 1000 } });
    expect(created.key.rateLimit).toEqual({ requestsPerMinute: 2, tokensPerMinute: 1000 });
  });
});

describe('other scopes', () => {
  test('per-user limits add up all keys created by the same user', async () => {
    const { h, admin, key } = await world();
    await setLimits(h, admin, { perUser: { requestsPerMinute: 2, tokensPerMinute: null } });
    const second = await createKey(h, admin, { name: 'second' });
    expect((await chat(h, key.secret)).status).toBe(200);
    expect((await chat(h, second.secret)).status).toBe(200);
    const limited = await chat(h, second.secret);
    expect(limited.status).toBe(429);
    expect((await json<OpenAiError>(limited)).error.message).toContain("this key's owner");
  });

  test('token limits are checked before and charged after (provider-reported usage)', async () => {
    const { h, admin, key } = await world();
    await setLimits(h, admin, { perKey: { requestsPerMinute: null, tokensPerMinute: 20 } });
    // Each mock completion reports 7 + 4 = 11 tokens.
    const first = await chat(h, key.secret);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-ratelimit-limit-tokens')).toBe('20');
    expect((await chat(h, key.secret)).status).toBe(200); // 11 used: budget left, allowed (may overshoot)
    const limited = await chat(h, key.secret); // 22 used
    expect(limited.status).toBe(429);
    expect((await json<OpenAiError>(limited)).error.message).toContain('20 tokens per minute');
  });

  test('global concurrency: a long stream holds its slot until it ends', async () => {
    const { h, admin, key } = await world();
    await setLimits(h, admin, { global: { requestsPerMinute: null, tokensPerMinute: null, maxConcurrent: 1 } });
    mock.streamDelayMs = 30;
    const stream = await chat(h, key.secret, { stream: true });
    expect(stream.status).toBe(200);
    const busy = await chat(h, key.secret);
    expect(busy.status).toBe(429);
    expect((await json<OpenAiError>(busy)).error.message).toContain('too many requests at once');
    await stream.text(); // the stream finishes
    expect((await chat(h, key.secret)).status).toBe(200);
  });

  test('a model at its limit is skipped like a failed one; when all are limited the client gets 429', async () => {
    const { h, admin, key } = await world();
    const res = await setLimits(h, admin, { perModel: [{ model: 'openai/gpt-4o-mini', requestsPerMinute: 1, tokensPerMinute: null }] });
    expect(res.status).toBe(200);
    const first = await chat(h, key.secret);
    expect(first.headers.get('x-clawrouter-model')).toBe('openai/gpt-4o-mini');
    const second = await chat(h, key.secret);
    expect(second.status).toBe(200);
    expect(second.headers.get('x-clawrouter-model')).toBe('local/gpt-4o-mini');
    expect(second.headers.get('x-clawrouter-attempts')).toBe('1'); // no provider call for the skipped model
    expect(h.routing.failures.count((await h.providers.list()).find((p) => p.identifier === 'openai')!.id)).toBe(0);

    const only = await chat(h, key.secret, { model: 'openai/gpt-4o-mini' });
    expect(only.status).toBe(429);
    expect((await json<OpenAiError>(only)).error.message).toContain('this model (1 requests per minute)');
  });

  test('an address that keeps sending invalid keys is blocked, even with a valid key, until the window passes', async () => {
    const { h, admin, key } = await world();
    await setLimits(h, admin, { invalidKeysPerIp: 3 });
    const wrong = `${key.secret.slice(0, -1)}${key.secret.endsWith('A') ? 'B' : 'A'}`;
    for (let i = 0; i < 3; i++) expect((await chat(h, wrong, {}, { ip: '198.51.100.9' })).status).toBe(401);
    const blocked = await chat(h, key.secret, {}, { ip: '198.51.100.9' });
    expect(blocked.status).toBe(429);
    expect((await json<OpenAiError>(blocked)).error.message).toContain('invalid API keys');
    // Other addresses are not affected.
    expect((await chat(h, key.secret, {}, { ip: '198.51.100.10' })).status).toBe(200);
    h.clock.advance(120_000);
    expect((await chat(h, key.secret, {}, { ip: '198.51.100.9' })).status).toBe(200);
  });
});

describe('administration', () => {
  test('GET/PUT /api/rate-limits: validation, versioning, audit, events, unknown models', async () => {
    const { h, admin } = await world();
    const initial = await data<RateLimitConfigView>(await h.request('/api/rate-limits', { cookie: admin }));
    expect(initial).toMatchObject({ version: 0, perKey: { requestsPerMinute: 120 }, global: { maxConcurrent: 100 }, invalidKeysPerIp: 20, unknownModels: [] });

    const bad = await setLimits(h, admin, { perKey: { requestsPerMinute: 0, tokensPerMinute: null } });
    expect(bad.status).toBe(400);
    const extra = await h.request('/api/rate-limits', { method: 'PUT', cookie: admin, json: { ...initial, surprise: 1 } });
    expect(extra.status).toBe(400);

    const changed: number[] = [];
    h.events.on('ratelimits.changed', (e) => { changed.push(e.version); });
    const saved = await data<RateLimitConfigView>(await setLimits(h, admin, { perModel: [{ model: 'gone/model', requestsPerMinute: 5, tokensPerMinute: null }] }));
    expect(saved.version).toBe(1);
    expect(saved.unknownModels).toEqual(['gone/model']);
    expect(changed).toEqual([1]);
    expect(h.audit.list({ action: 'RATE_LIMITS_UPDATED' })[0]!.metadata).toMatchObject({ perModel: { added: ['gone/model'] } });

    const { unknownModels: _u, updatedAt: _a, updatedBy: _b, ...body } = initial;
    const stale = await h.request('/api/rate-limits', { method: 'PUT', cookie: admin, json: { ...body, version: 0 } });
    expect(stale.status).toBe(409);
  });

  test('permissions: operators may change limits, viewers may only read them', async () => {
    const { h } = await world();
    await h.addUser('op', ['OPERATOR']);
    await h.addUser('viewer', ['VIEWER']);
    const op = await h.login('op');
    const viewer = await h.login('viewer');
    expect((await setLimits(h, op, { invalidKeysPerIp: 10 })).status).toBe(200);
    expect((await h.request('/api/rate-limits', { cookie: viewer })).status).toBe(200);
    expect((await h.request('/api/rate-limits/usage', { cookie: viewer })).status).toBe(200);
    expect((await setLimits(h, viewer, { invalidKeysPerIp: 10 })).status).toBe(403);
  });

  test('usage shows live counters with names, and refusals reach the dashboard metrics and events', async () => {
    const { h, admin, key } = await world();
    await setLimits(h, admin, { perKey: { requestsPerMinute: 2, tokensPerMinute: null } });
    const exceeded: string[] = [];
    h.events.on('ratelimit.exceeded', (e) => { exceeded.push(`${e.scope}:${e.kind}`); });
    await chat(h, key.secret);
    await chat(h, key.secret);
    expect((await chat(h, key.secret)).status).toBe(429);
    expect(exceeded).toEqual(['key:requests']);

    const usage = await data<RateLimitUsage>(await h.request('/api/rate-limits/usage', { cookie: admin }));
    expect(usage.rejectedLastMinute).toBe(1);
    const k = usage.entries.find((e) => e.scope === 'key')!;
    expect(k).toMatchObject({ subject: key.key.id, label: `ci (${key.key.prefix}…)`, requestsLastMinute: 2, tokensLastMinute: 22, limit: { requestsPerMinute: 2 } });
    expect(usage.entries.find((e) => e.scope === 'user')).toMatchObject({ label: 'admin', requestsLastMinute: 2 });
    expect(usage.entries.find((e) => e.scope === 'global')).toMatchObject({ requestsLastMinute: 2, concurrent: 0 });

    const metrics = await data<GatewayMetrics>(await h.request('/api/gateway/metrics', { cookie: admin }));
    expect(metrics).toMatchObject({ totalRequests: 2, rateLimitedLastMinute: 1, rateLimitedTotal: 1 });
  });
});
