import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ApiSuccess, ApiKeyInfo, CreatedApiKey, GatewayMetrics, ModelAlias, ProviderInfo } from '@clawrouter/shared';
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
  mock.badRequestFamilies.clear();
  mock.streamBreak = false;
  mock.streamDelayMs = 0;
});

const actor = { id: 'u', username: 'admin' };
const client = { ip: null };
type OpenAiError = { error: { message: string; type: string; param: string | null; code: string } };
const json = async <T>(res: Response) => (await res.json()) as T;

/** OpenAI (mock), a local OpenAI-compatible server (mock) and Google (mock), with chat and embedding models. */
async function world() {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const p = async (name: string, identifier: string, kind: ProviderInfo['kind'], path: string, apiKey?: string, priority = 100) =>
    h.providers.create(actor, { name, identifier, kind, endpoint: `${mock.url}${path}`, apiKey, priority }, client);
  const openai = await p('OpenAI', 'openai', 'openai', '/openai/v1', mock.key, 10);
  const local = await p('Local', 'local', 'openai_compatible', '/local/v1', undefined, 20);
  const google = await p('Google', 'google', 'google', '/google/v1beta', mock.key, 30);
  h.models.create(actor, { providerId: openai.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'] }, client);
  h.models.create(actor, { providerId: local.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'] }, client);
  h.models.create(actor, { providerId: openai.id, providerModelId: 'text-embedding-3-small', capabilities: ['EMBEDDINGS'] }, client);
  h.models.create(actor, { providerId: google.id, providerModelId: 'text-embedding-004', capabilities: ['EMBEDDINGS'] }, client);
  const key = await createKey(h, admin, { name: 'ci' });
  return { h, admin, key: key.secret, keyInfo: key.key, openai, local, google };
}

async function createKey(h: Harness, cookie: string, body: Record<string, unknown>): Promise<CreatedApiKey> {
  const res = await h.request('/api/api-keys', { method: 'POST', cookie, json: body });
  expect(res.status).toBe(201);
  return (await json<ApiSuccess<CreatedApiKey>>(res)).data;
}

const v1 = (h: Harness, key: string | null, path: string, body?: unknown, init: RequestInit = {}) =>
  h.request(`/v1${path}`, { method: body === undefined ? 'GET' : 'POST', json: body, headers: key ? { authorization: `Bearer ${key}` } : {}, ...init });

const chat = (model: string, extra: Record<string, unknown> = {}) => ({ model, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }], ...extra });

async function setAliases(h: Harness, aliases: ModelAlias[]) {
  const current = h.routing.get();
  h.routing.update(actor, { version: current.version, defaultPolicy: current.defaultPolicy, aliases }, client);
}

/** Reads an SSE response into its data payloads. */
async function sseEvents(res: Response): Promise<unknown[]> {
  const text = await res.text();
  return text.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => {
    const data = b.slice(6);
    return data === '[DONE]' ? '[DONE]' : JSON.parse(data);
  });
}

describe('API keys (admin)', () => {
  test('the secret is shown once; lists never contain it; only a hash is stored', async () => {
    const { h, admin, key, keyInfo } = await world();
    expect(key).toMatch(/^crk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(keyInfo).toMatchObject({ name: 'ci', status: 'ACTIVE', prefix: key.slice(0, 12), allowedModels: [], createdBy: { username: 'admin' } });
    const list = await h.request('/api/api-keys', { cookie: admin });
    const text = await list.text();
    expect(text).not.toContain(key.slice(13));
    expect(JSON.stringify(h.db.all('SELECT * FROM api_keys')) + JSON.stringify(h.db.all('SELECT * FROM audit_log'))).not.toContain(key.slice(13));
    expect(h.audit.list({ action: 'API_KEY_CREATED' })).toHaveLength(1);
  });

  test('revoked and expired keys stop working', async () => {
    const { h, admin, key, keyInfo } = await world();
    expect((await v1(h, key, '/models')).status).toBe(200);
    const revoked = await h.request(`/api/api-keys/${keyInfo.id}`, { method: 'DELETE', cookie: admin });
    expect((await json<ApiSuccess<ApiKeyInfo>>(revoked)).data.status).toBe('REVOKED');
    expect((await v1(h, key, '/models')).status).toBe(401);
    expect(h.audit.list({ action: 'API_KEY_REVOKED' })).toHaveLength(1);

    const soon = await createKey(h, admin, { name: 'short', expiresAt: new Date(h.clock.time + 60_000).toISOString() });
    expect((await v1(h, soon.secret, '/models')).status).toBe(200);
    h.clock.advance(61_000);
    expect((await v1(h, soon.secret, '/models')).status).toBe(401);
  });

  test('validation and permissions', async () => {
    const { h, admin } = await world();
    expect((await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: '' } })).status).toBe(400);
    expect((await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'x', expiresAt: '2000-01-01T00:00:00Z' } })).status).toBe(400);
    await h.addUser('op', ['OPERATOR']);
    const op = await h.login('op');
    expect((await h.request('/api/api-keys', { cookie: op })).status).toBe(403);
  });
});

describe('/v1 authentication (spec §32)', () => {
  test('missing, wrong and session-only requests are rejected in the OpenAI format', async () => {
    const { h, admin, key } = await world();
    const missing = await v1(h, null, '/models');
    expect(missing.status).toBe(401);
    expect((await json<OpenAiError>(missing)).error).toMatchObject({ type: 'authentication_error', code: 'invalid_api_key', message: expect.stringContaining('Missing API key') });
    expect((await v1(h, `${key.slice(0, -1)}X`, '/models')).status).toBe(401);
    // A console session never grants gateway access.
    expect((await h.request('/v1/models', { cookie: admin })).status).toBe(401);
    // x-api-key works too (Anthropic-style clients).
    expect((await h.request('/v1/models', { headers: { 'x-api-key': key } })).status).toBe(200);
  });
});

describe('GET /v1/models', () => {
  test('aliases and usable models, limited to what the key may use', async () => {
    const { h, admin, key } = await world();
    await setAliases(h, [{ name: 'fast', description: '', enabled: true, capabilities: [], policy: null, targets: [{ modelRef: 'openai/gpt-4o-mini', priority: 0, weight: 1 }] }]);
    const all = await json<{ object: string; data: { id: string; owned_by: string }[] }>(await v1(h, key, '/models'));
    expect(all.object).toBe('list');
    expect(all.data.map((m) => m.id)).toEqual(expect.arrayContaining(['fast', 'openai/gpt-4o-mini', 'local/gpt-4o-mini', 'google/text-embedding-004']));
    const limited = await createKey(h, admin, { name: 'limited', allowedModels: ['fast'] });
    expect((await json<{ data: { id: string }[] }>(await v1(h, limited.secret, '/models'))).data.map((m) => m.id)).toEqual(['fast']);
  });
});

describe('POST /v1/chat/completions', () => {
  test('returns an OpenAI chat completion; the client does not need to know the provider', async () => {
    const { h, key } = await world();
    const res = await v1(h, key, '/chat/completions', chat('openai/gpt-4o-mini'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-clawrouter-model')).toBe('openai/gpt-4o-mini');
    expect(res.headers.get('x-request-id')).toMatch(/^req_/);
    const body = await json<Record<string, unknown>>(res);
    expect(body).toMatchObject({
      object: 'chat.completion', model: 'openai/gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from OpenAI' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
    });
    expect(String(body.id)).toStartWith('chatcmpl-');
    // The provider received the provider's own model id and normalized fields.
    expect(mock.requests.at(-1)!.body).toMatchObject({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }] });
  });

  test('request validation errors name the parameter', async () => {
    const { h, key } = await world();
    const cases: [unknown, string][] = [
      [{ model: 'openai/gpt-4o-mini' }, 'messages'],
      [{ messages: [{ role: 'user', content: 'x' }] }, 'model'],
      [chat('openai/gpt-4o-mini', { n: 2 }), 'n'],
      [chat('openai/gpt-4o-mini', { tools: [{}] }), 'tools'],
      [chat('openai/gpt-4o-mini', { temperature: 5 }), 'temperature'],
      [{ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }, 'messages[0].content[0]'],
    ];
    for (const [body, param] of cases) {
      const res = await v1(h, key, '/chat/completions', body);
      expect([param, res.status]).toEqual([param, 400]);
      expect((await json<OpenAiError>(res)).error).toMatchObject({ type: 'invalid_request_error', param });
    }
  });

  test('model access: unknown model 404, key restrictions 403', async () => {
    const { h, admin, key } = await world();
    const unknown = await v1(h, key, '/chat/completions', chat('nope'));
    expect(unknown.status).toBe(404);
    expect((await json<OpenAiError>(unknown)).error).toMatchObject({ code: 'model_not_found', param: 'model' });
    const limited = await createKey(h, admin, { name: 'limited', allowedModels: ['local/gpt-4o-mini'] });
    const denied = await v1(h, limited.secret, '/chat/completions', chat('openai/gpt-4o-mini'));
    expect(denied.status).toBe(403);
    expect((await json<OpenAiError>(denied)).error.type).toBe('permission_error');
  });

  test('retries, then fails over to the next model (spec §11) and records the failures', async () => {
    const { h, key, openai } = await world();
    mock.failFamilies.add('openai');
    const res = await v1(h, key, '/chat/completions', chat('gpt-4o-mini'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-clawrouter-model')).toBe('local/gpt-4o-mini');
    expect(res.headers.get('x-clawrouter-attempts')).toBe('3'); // openai, openai (retry), local
    expect(h.routing.failures.count(openai.id)).toBe(2);
    expect(h.gateway.metrics.snapshot()).toMatchObject({ retriedRequests: 1, failedOverRequests: 1 });
  });

  test('all attempts failing gives a generic 502 without provider details', async () => {
    const { h, key } = await world();
    mock.failFamilies.add('openai');
    mock.failFamilies.add('local');
    const failed: string[] = [];
    h.events.on('request.failed', (e) => { failed.push(e.code); });
    const res = await v1(h, key, '/chat/completions', chat('gpt-4o-mini'));
    expect(res.status).toBe(502);
    const err = (await json<OpenAiError>(res)).error;
    expect(err.type).toBe('api_error');
    expect(err.message).toContain('3 attempts');
    expect(err.message).not.toContain('is down');
    expect(failed).toEqual(['PROVIDER_ERROR']);
  });

  test('a request the provider rejects (400) is not retried elsewhere', async () => {
    const { h, key } = await world();
    mock.badRequestFamilies.add('openai');
    mock.requests.length = 0;
    const res = await v1(h, key, '/chat/completions', chat('gpt-4o-mini'));
    expect(res.status).toBe(400);
    expect((await json<OpenAiError>(res)).error.message).toContain('maximum context length');
    expect(mock.requests.filter((r) => r.path.startsWith('/local'))).toHaveLength(0);
  });

  test('an alias routes through its targets', async () => {
    const { h, key } = await world();
    await setAliases(h, [{ name: 'fast-code', description: '', enabled: true, capabilities: [], policy: null, targets: [{ modelRef: 'local/gpt-4o-mini', priority: 0, weight: 1 }, { modelRef: 'openai/gpt-4o-mini', priority: 1, weight: 1 }] }]);
    const res = await v1(h, key, '/chat/completions', chat('fast-code'));
    expect(res.headers.get('x-clawrouter-model')).toBe('local/gpt-4o-mini');
  });
});

describe('streaming (spec §13)', () => {
  test('streams OpenAI chunks, then usage when asked, then [DONE]', async () => {
    const { h, key } = await world();
    const res = await v1(h, key, '/chat/completions', chat('openai/gpt-4o-mini', { stream: true, stream_options: { include_usage: true } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = await sseEvents(res);
    const chunks = events.filter((e) => e !== '[DONE]') as { object: string; choices: { delta: { content?: string; role?: string }; finish_reason: string | null }[]; usage?: unknown }[];
    expect(chunks.every((c) => c.object === 'chat.completion.chunk')).toBe(true);
    expect(chunks[0]!.choices[0]!.delta.role).toBe('assistant');
    expect(chunks.flatMap((c) => c.choices.map((x) => x.delta.content ?? '')).join('')).toBe('Hello');
    expect(chunks.at(-2)!.choices[0]!.finish_reason).toBe('stop');
    expect(chunks.at(-1)!.usage).toEqual({ prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
    expect(events.at(-1)).toBe('[DONE]');
  });

  test('fails over before the first token', async () => {
    const { h, key } = await world();
    mock.failFamilies.add('openai');
    const res = await v1(h, key, '/chat/completions', chat('gpt-4o-mini', { stream: true }));
    expect(res.headers.get('x-clawrouter-model')).toBe('local/gpt-4o-mini');
    expect((await sseEvents(res)).at(-1)).toBe('[DONE]');
  });

  test('a stream that breaks after the first token ends with an error event', async () => {
    const { h, key } = await world();
    mock.streamBreak = true;
    const failed: string[] = [];
    h.events.on('request.failed', (e) => { failed.push(e.code); });
    const res = await v1(h, key, '/chat/completions', chat('openai/gpt-4o-mini', { stream: true }));
    const events = await sseEvents(res);
    expect(events.at(-1)).toMatchObject({ error: { type: 'api_error', code: 'stream_interrupted' } });
    expect(failed).toEqual(['STREAM_INTERRUPTED']);
  });

  test('a client disconnect stops the provider stream', async () => {
    const { h, key } = await world();
    mock.streamDelayMs = 40;
    mock.streamEventsSent = 0;
    const controller = new AbortController();
    const failed: string[] = [];
    h.events.on('request.failed', (e) => { failed.push(e.code); });
    const res = await v1(h, key, '/chat/completions', chat('openai/gpt-4o-mini', { stream: true }), { signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read(); // role chunk
    controller.abort();
    await reader.cancel();
    await Bun.sleep(250);
    expect(mock.streamEventsSent).toBeLessThan(5);
    expect(failed).toEqual(['CANCELLED']);
  });
});

describe('POST /v1/embeddings', () => {
  test('vectors in input order, from OpenAI or Google', async () => {
    const { h, key } = await world();
    const res = await v1(h, key, '/embeddings', { model: 'openai/text-embedding-3-small', input: ['a', 'b'] });
    expect(res.status).toBe(200);
    expect(await json<unknown>(res)).toEqual({
      object: 'list', model: 'openai/text-embedding-3-small',
      data: [{ object: 'embedding', index: 0, embedding: [0, 0.5, -0.25] }, { object: 'embedding', index: 1, embedding: [1, 0.5, -0.25] }],
      usage: { prompt_tokens: 8, total_tokens: 8 },
    });
    const g = await json<{ data: { embedding: number[] }[] }>(await v1(h, key, '/embeddings', { model: 'google/text-embedding-004', input: 'hello' }));
    expect(g.data[0]!.embedding).toEqual([0, 1, 2]);
  });

  test('a chat model is not an embeddings model', async () => {
    const { h, key } = await world();
    const res = await v1(h, key, '/embeddings', { model: 'openai/gpt-4o-mini', input: 'x' });
    expect(res.status).toBe(503);
    expect((await v1(h, key, '/embeddings', { model: 'openai/text-embedding-3-small', input: [] })).status).toBe(400);
  });
});

describe('other endpoints', () => {
  test('/v1/responses explains it is not supported yet', async () => {
    const { h, key } = await world();
    const res = await v1(h, key, '/responses', { model: 'x', input: 'hi' });
    expect(res.status).toBe(400);
    expect((await json<OpenAiError>(res)).error.message).toContain('/v1/chat/completions');
  });

  test('GET /api/gateway/metrics counts requests, errors, latency and tokens', async () => {
    const { h, admin, key } = await world();
    await v1(h, key, '/chat/completions', chat('openai/gpt-4o-mini'));
    await v1(h, key, '/chat/completions', chat('nope'));
    const m = (await json<ApiSuccess<GatewayMetrics>>(await h.request('/api/gateway/metrics', { cookie: admin }))).data;
    expect(m).toMatchObject({ activeRequests: 0, totalRequests: 1, totalErrors: 0, requestsLastMinute: 1, tokensLastHour: { input: 7, output: 4 } });
    expect(m.averageLatencyMs).not.toBeNull();
  });
});
