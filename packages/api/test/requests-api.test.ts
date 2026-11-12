import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ApiSuccess, CreatedApiKey, GatewayMetrics, RequestDetail, RequestRecord, UsageReport } from '@clawrouter/shared';
import { estimateCost } from '@clawrouter/requests';
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
  mock.streamBreak = false;
  mock.streamDelayMs = 0;
});

const actor = { id: 'u', username: 'admin' };
const client = { ip: null };
const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;
const SECRET_PROMPT = 'my secret prompt text 4f9a';

/** OpenAI (priced) and a local server (unpriced), both offering gpt-4o-mini; Google embeddings. */
async function world() {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const openai = await h.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key, priority: 10 }, client);
  const local = await h.providers.create(actor, { name: 'Local', identifier: 'local', kind: 'openai_compatible', endpoint: `${mock.url}/local/v1`, priority: 20 }, client);
  const google = await h.providers.create(actor, { name: 'Google', identifier: 'google', kind: 'google', endpoint: `${mock.url}/google/v1beta`, apiKey: mock.key, priority: 30 }, client);
  h.models.create(actor, { providerId: openai.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'], cost: { inputPerMTok: 2.5, outputPerMTok: 10 } }, client);
  h.models.create(actor, { providerId: local.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'] }, client);
  h.models.create(actor, { providerId: google.id, providerModelId: 'text-embedding-004', capabilities: ['EMBEDDINGS'], cost: { inputPerMTok: 0.1, outputPerMTok: null } }, client);
  const res = await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'ci' } });
  const key = await data<CreatedApiKey>(res);
  return { h, admin, key, openai };
}

const v1 = (h: Harness, key: string, path: string, body: unknown, init: RequestInit = {}) =>
  h.request(`/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, json: body, ...init });
const chat = (model: string, extra: Record<string, unknown> = {}) => ({ model, messages: [{ role: 'user', content: SECRET_PROMPT }], ...extra });
const detail = async (h: Harness, cookie: string, id: string) => data<RequestDetail>(await h.request(`/api/requests/${id}`, { cookie }));
const list = async (h: Harness, cookie: string, query = '') => {
  const res = await h.request(`/api/requests${query}`, { cookie });
  expect(res.status).toBe(200);
  const body = (await res.json()) as ApiSuccess<RequestRecord[]> & { meta: { total: number } };
  return { items: body.data, total: body.meta.total };
};

describe('every authenticated gateway request is recorded (spec §22)', () => {
  test('a completed request: model, provider, attempts, provider-reported tokens and estimated cost', async () => {
    const { h, admin, key } = await world();
    const res = await v1(h, key.secret, '/chat/completions', chat('gpt-4o-mini'));
    const id = res.headers.get('x-request-id')!;
    const r = await detail(h, admin, id);
    expect(r).toMatchObject({
      id, status: 'COMPLETED', endpoint: 'chat.completions', stream: false, httpStatus: 200,
      apiKey: { id: key.key.id, name: 'ci', prefix: key.key.prefix }, user: { username: 'admin' },
      requestedModel: 'gpt-4o-mini', modelRef: 'openai/gpt-4o-mini', provider: { name: 'OpenAI' },
      attempts: 1, retries: 0, failovers: 0, inputTokens: 7, outputTokens: 4, usageSource: 'provider',
      errorCode: null, attemptLog: [{ modelRef: 'openai/gpt-4o-mini', outcome: 'ok' }],
    });
    // 7 × $2.50 + 4 × $10.00 per million tokens
    expect(r.costUsd).toBeCloseTo(0.0000575, 10);
    expect(r.completedAt).not.toBeNull();
  });

  test('retries and failover are visible attempt by attempt; an unpriced model has no cost', async () => {
    const { h, admin, key } = await world();
    mock.failFamilies.add('openai');
    const res = await v1(h, key.secret, '/chat/completions', chat('gpt-4o-mini'));
    const r = await detail(h, admin, res.headers.get('x-request-id')!);
    expect(r).toMatchObject({ status: 'COMPLETED', modelRef: 'local/gpt-4o-mini', provider: { name: 'Local' }, attempts: 3, retries: 1, failovers: 1, costUsd: null });
    expect(r.attemptLog.map((a) => `${a.modelRef}:${a.outcome}`)).toEqual(['openai/gpt-4o-mini:server_error', 'openai/gpt-4o-mini:server_error', 'local/gpt-4o-mini:ok']);
  });

  test('failures are recorded with a client-safe error: validation, unknown model, all providers down', async () => {
    const { h, admin, key } = await world();
    await v1(h, key.secret, '/chat/completions', { model: 'gpt-4o-mini', messages: [] });
    h.clock.advance(1000);
    await v1(h, key.secret, '/chat/completions', chat('nope'));
    h.clock.advance(1000);
    mock.failFamilies.add('openai');
    mock.failFamilies.add('local');
    await v1(h, key.secret, '/chat/completions', chat('gpt-4o-mini'));
    const { items } = await list(h, admin);
    expect(items.map((r) => [r.requestedModel, r.status, r.httpStatus, r.errorCode])).toEqual([
      ['gpt-4o-mini', 'FAILED', 502, 'PROVIDER_ERROR'],
      ['nope', 'FAILED', 404, 'NOT_FOUND'],
      ['gpt-4o-mini', 'FAILED', 400, 'VALIDATION_ERROR'],
    ]);
    expect(items[0]!.errorMessage).toContain('3 attempts');
    expect(items[0]!.errorMessage).not.toContain('is down'); // provider internals stay in the log
    expect(items[0]!.modelRef).toBe('local/gpt-4o-mini');
  });

  test('a rate-limited request is recorded as a 429 but does not count as a started request', async () => {
    const { h, admin, key } = await world();
    const current = await data<Record<string, unknown>>(await h.request('/api/rate-limits', { cookie: admin }));
    const { unknownModels: _u, updatedAt: _a, updatedBy: _b, ...body } = current;
    await h.request('/api/rate-limits', { method: 'PUT', cookie: admin, json: { ...body, perKey: { requestsPerMinute: 1, tokensPerMinute: null } } });
    await v1(h, key.secret, '/chat/completions', chat('gpt-4o-mini'));
    await v1(h, key.secret, '/chat/completions', chat('gpt-4o-mini'));
    const { items } = await list(h, admin, '?problems=true');
    expect(items.map((r) => [r.status, r.httpStatus, r.errorCode, r.attempts])).toEqual([['FAILED', 429, 'RATE_LIMITED', 0]]);
    expect(h.gateway.metrics.snapshot()).toMatchObject({ totalRequests: 1, totalErrors: 0 });
  });

  test('streams: completed, broken, and cancelled by the client', async () => {
    const { h, admin, key } = await world();
    const ok = await v1(h, key.secret, '/chat/completions', chat('openai/gpt-4o-mini', { stream: true }));
    await ok.text();
    expect(await detail(h, admin, ok.headers.get('x-request-id')!)).toMatchObject({ status: 'COMPLETED', stream: true, inputTokens: 7, outputTokens: 2, usageSource: 'provider' });

    mock.streamBreak = true;
    const broken = await v1(h, key.secret, '/chat/completions', chat('openai/gpt-4o-mini', { stream: true }));
    await broken.text();
    expect(await detail(h, admin, broken.headers.get('x-request-id')!)).toMatchObject({ status: 'FAILED', httpStatus: 200, errorCode: 'STREAM_INTERRUPTED' });

    mock.streamBreak = false;
    mock.streamDelayMs = 40;
    const controller = new AbortController();
    const slow = await v1(h, key.secret, '/chat/completions', chat('openai/gpt-4o-mini', { stream: true }), { signal: controller.signal });
    const id = slow.headers.get('x-request-id')!;
    expect((await detail(h, admin, id)).status).toBe('STREAMING');
    const reader = slow.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel();
    await Bun.sleep(100);
    expect(await detail(h, admin, id)).toMatchObject({ status: 'CANCELLED', httpStatus: 499 });
  });

  test('when the provider reports no usage, tokens are estimated locally and marked as estimated', async () => {
    const { h, admin, key } = await world();
    // The Google embeddings API reports no token usage.
    const res = await v1(h, key.secret, '/embeddings', { model: 'google/text-embedding-004', input: ['x'.repeat(400)] });
    expect(res.status).toBe(200);
    const r = await detail(h, admin, res.headers.get('x-request-id')!);
    expect(r).toMatchObject({ endpoint: 'embeddings', inputTokens: 100, outputTokens: 0, usageSource: 'estimated' });
    expect(r.costUsd).toBeCloseTo(100 * 0.1 / 1e6, 12);
    // The client's response does not invent a usage block.
    const usage = await data<UsageReport>(await h.request('/api/usage', { cookie: admin }));
    expect(usage.totals.estimatedTokens).toBe(100);
  });

  test('prompts and completions are never stored', async () => {
    const { h, key } = await world();
    await v1(h, key.secret, '/chat/completions', chat('gpt-4o-mini'));
    const dump = JSON.stringify([h.db.all('SELECT * FROM requests'), h.db.all('SELECT * FROM usage_records')]);
    expect(dump).not.toContain(SECRET_PROMPT);
    expect(dump).not.toContain('Hello from OpenAI');
    expect(dump).not.toContain(key.secret);
  });
});

describe('GET /api/requests', () => {
  test('filters and pages on the server', async () => {
    const { h, key, openai } = await world();
    for (let i = 0; i < 3; i++) await v1(h, key.secret, '/chat/completions', chat('gpt-4o-mini'));
    await v1(h, key.secret, '/chat/completions', chat('nope'));
    h.clock.advance(1000);
    h.clock.advance(3_600_000);
    const fresh = await h.login();
    await v1(h, key.secret, '/chat/completions', chat('openai/gpt-4o-mini'));

    expect((await list(h, fresh)).total).toBe(5);
    const page = await list(h, fresh, '?pageSize=2&page=2');
    expect([page.items.length, page.total]).toEqual([2, 5]);
    expect((await list(h, fresh, '?status=FAILED')).total).toBe(1);
    expect((await list(h, fresh, '?model=openai/gpt-4o-mini')).total).toBe(4); // requested or answered
    expect((await list(h, fresh, `?providerId=${openai.id}`)).total).toBe(4);
    expect((await list(h, fresh, `?apiKeyId=${key.key.id}`)).total).toBe(5);
    expect((await list(h, fresh, `?from=${encodeURIComponent(new Date(h.clock.time - 60_000).toISOString())}`)).total).toBe(1);
    expect((await h.request('/api/requests?status=WRONG', { cookie: fresh })).status).toBe(400);
    expect((await h.request('/api/requests?from=yesterday', { cookie: fresh })).status).toBe(400);
    expect((await h.request('/api/requests/req_nope', { cookie: fresh })).status).toBe(404);
  });

  test('viewers may read history and usage; users without a role may not', async () => {
    const { h } = await world();
    await h.addUser('viewer', ['VIEWER']);
    await h.addUser('nobody', []);
    const viewer = await h.login('viewer');
    const nobody = await h.login('nobody');
    expect((await h.request('/api/requests', { cookie: viewer })).status).toBe(200);
    expect((await h.request('/api/usage', { cookie: viewer })).status).toBe(200);
    expect((await h.request('/api/requests', { cookie: nobody })).status).toBe(403);
    expect((await h.request('/api/usage', { cookie: nobody })).status).toBe(403);
  });
});

describe('GET /api/usage (spec §23)', () => {
  test('totals, an hourly series with empty hours filled in, and breakdowns', async () => {
    const { h, key } = await world();
    await v1(h, key.secret, '/chat/completions', chat('openai/gpt-4o-mini'));
    await v1(h, key.secret, '/chat/completions', chat('openai/gpt-4o-mini'));
    h.clock.advance(2 * 3_600_000);
    const fresh = await h.login();
    await v1(h, key.secret, '/chat/completions', chat('local/gpt-4o-mini'));
    await v1(h, key.secret, '/chat/completions', chat('nope'));
    h.clock.advance(1000);

    const r = await data<UsageReport>(await h.request('/api/usage', { cookie: fresh }));
    expect(r.bucket).toBe('hour');
    expect(r.series).toHaveLength(24);
    expect(r.totals).toMatchObject({ requests: 4, errors: 1, inputTokens: 21, outputTokens: 12, unpricedRequests: 1 });
    expect(r.totals.costUsd).toBeCloseTo(2 * 0.0000575, 10);
    expect(r.series.filter((b) => b.requests > 0).map((b) => b.requests)).toEqual([2, 2]);
    expect(r.breakdown.map((b) => [b.label, b.requests])).toEqual([['openai/gpt-4o-mini', 2], ['local/gpt-4o-mini', 1], ['(not routed)', 1]]);

    const byKey = await data<UsageReport>(await h.request('/api/usage?groupBy=apiKey', { cookie: fresh }));
    expect(byKey.breakdown).toEqual([expect.objectContaining({ key: key.key.id, label: `ci (${key.key.prefix}…)`, requests: 4 })]);
    const byUser = await data<UsageReport>(await h.request('/api/usage?groupBy=user', { cookie: fresh }));
    expect(byUser.breakdown[0]).toMatchObject({ label: 'admin', requests: 4 });
    const byProvider = await data<UsageReport>(await h.request('/api/usage?groupBy=provider', { cookie: fresh }));
    expect(byProvider.breakdown.map((b) => b.label)).toEqual(['OpenAI', 'Local', '(not routed)']);

    const week = await data<UsageReport>(await h.request(`/api/usage?from=${new Date(h.clock.time - 7 * 86_400_000).toISOString()}`, { cookie: fresh }));
    expect(week.bucket).toBe('day');
    expect(week.totals.requests).toBe(4);
    expect((await h.request('/api/usage?from=2020-01-01T00:00:00Z', { cookie: fresh })).status).toBe(400); // > 400 days
    expect((await h.request('/api/usage?groupBy=color', { cookie: fresh })).status).toBe(400);
  });
});

describe('retention and restarts', () => {
  test('request detail is pruned after its retention period; usage records stay longer', async () => {
    const { h, key } = await world();
    await v1(h, key.secret, '/chat/completions', chat('gpt-4o-mini'));
    h.clock.advance(31 * 86_400_000);
    const fresh = await h.login();
    expect(h.requests.prune()).toEqual({ requests: 1, usageRecords: 0 });
    expect((await list(h, fresh)).total).toBe(0);
    const usage = await data<UsageReport>(await h.request(`/api/usage?from=${new Date(h.clock.time - 40 * 86_400_000).toISOString()}`, { cookie: fresh }));
    expect(usage.totals.requests).toBe(1);
    h.clock.advance(370 * 86_400_000);
    expect(h.requests.prune()).toEqual({ requests: 0, usageRecords: 1 });
  });

  test('requests left in progress by a stopped server are marked as interrupted', async () => {
    const { h, admin, key } = await world();
    h.requests.begin({ id: 'req_left', endpoint: 'chat.completions', stream: true, apiKeyId: key.key.id, userId: null, requestedModel: 'x' });
    expect(h.requests.recoverInterrupted()).toBe(1);
    expect(await detail(h, admin, 'req_left')).toMatchObject({ status: 'FAILED', errorCode: 'INTERRUPTED' });
  });

  test('the dashboard metrics still count only admitted requests', async () => {
    const { h, admin, key } = await world();
    await v1(h, key.secret, '/chat/completions', { model: 'x', messages: [] });
    const m = await data<GatewayMetrics>(await h.request('/api/gateway/metrics', { cookie: admin }));
    expect(m.totalRequests).toBe(0);
  });
});

describe('estimateCost', () => {
  test('prices per million tokens; a missing price for used tokens means unknown', () => {
    expect(estimateCost({ inputPerMTok: 3, outputPerMTok: 15, currency: 'USD' }, 1_000_000, 100_000)).toBe(4.5);
    expect(estimateCost({ inputPerMTok: 0.1, outputPerMTok: null, currency: 'USD' }, 1000, 0)).toBeCloseTo(0.0001, 10);
    expect(estimateCost({ inputPerMTok: 0.1, outputPerMTok: null, currency: 'USD' }, 1000, 5)).toBeNull();
    expect(estimateCost(null, 10, 10)).toBeNull();
  });
});
