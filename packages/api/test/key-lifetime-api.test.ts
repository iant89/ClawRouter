import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ApiErrorBody, ApiKeyRequestInfo, ApiSuccess, CreatedApiKey, ModelInfo, ProviderInfo } from '@clawrouter/shared';
import { createHarness, type Harness } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

let mock: MockProviders;
beforeAll(() => {
  mock = startMockProviders();
});
afterAll(() => mock.stop());

const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;
const errorOf = async (res: Response) => ((await res.json()) as ApiErrorBody).error;
const HOUR = 3_600_000;

/** OpenAI (7-day key limit on the provider) and a local server (no limit), with one chat model each. */
async function world() {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const post = (path: string, json: unknown) => h.request(path, { method: 'POST', cookie: admin, json });
  const openai = await data<ProviderInfo>(await post('/api/providers', { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key, maxKeyLifetimeHours: 168 }));
  const local = await data<ProviderInfo>(await post('/api/providers', { name: 'Local', identifier: 'local', kind: 'openai_compatible', endpoint: `${mock.url}/local/v1`, priority: 200 }));
  const gpt = await data<ModelInfo>(await post('/api/models', { providerId: openai.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'] }));
  const llama = await data<ModelInfo>(await post('/api/models', { providerId: local.id, providerModelId: 'llama-3', capabilities: ['CHAT'] }));
  return { h, admin, post, openai, local, gpt, llama };
}

const chat = (h: Harness, key: string, model: string) => h.request('/v1/chat/completions', {
  method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
});

describe('maximum key lifetime on providers and models', () => {
  test('set on providers and models; a model reports the stricter of the two', async () => {
    const { h, admin, openai, gpt, llama } = await world();
    expect(openai.maxKeyLifetimeHours).toBe(168);
    expect(gpt).toMatchObject({ maxKeyLifetimeHours: null, keyLifetimeLimit: { hours: 168, source: 'provider' } });
    expect(llama.keyLifetimeLimit).toBeNull();
    // A model may be stricter than its provider, never looser.
    const stricter = await data<ModelInfo>(await h.request(`/api/models/${gpt.id}`, { method: 'PATCH', cookie: admin, json: { maxKeyLifetimeHours: 24 } }));
    expect(stricter.keyLifetimeLimit).toEqual({ hours: 24, source: 'model' });
    const looser = await data<ModelInfo>(await h.request(`/api/models/${gpt.id}`, { method: 'PATCH', cookie: admin, json: { maxKeyLifetimeHours: 1000 } }));
    expect(looser.keyLifetimeLimit).toEqual({ hours: 168, source: 'provider' });
    // null removes a limit; nonsense is refused.
    const cleared = await data<ProviderInfo>(await h.request(`/api/providers/${openai.id}`, { method: 'PATCH', cookie: admin, json: { maxKeyLifetimeHours: null } }));
    expect(cleared.maxKeyLifetimeHours).toBeNull();
    for (const bad of [0, -5, 1.5, 'week', 24 * 3651]) {
      expect((await h.request(`/api/providers/${openai.id}`, { method: 'PATCH', cookie: admin, json: { maxKeyLifetimeHours: bad } })).status).toBe(400);
    }
    expect(h.audit.list({ action: 'PROVIDER_UPDATED' }).some((r) => JSON.stringify(r.metadata).includes('maxKeyLifetimeHours'))).toBe(true);
  });

  test('a key for limited models must expire within the limit; "never" is refused', async () => {
    const { h, post } = await world();
    const never = await post('/api/api-keys', { name: 'forever', allowedModels: ['openai/gpt-4o-mini'] });
    expect(never.status).toBe(400);
    expect((await errorOf(never)).details).toMatchObject({ issues: [{ path: 'expiresAt', message: expect.stringContaining('openai/gpt-4o-mini allows keys of at most 7 days (set on the provider)') }] });
    expect((await post('/api/api-keys', { name: 'month', allowedModels: ['gpt-4o-mini'], expiry: { type: 'after', hours: 720 } })).status).toBe(400);
    expect((await post('/api/api-keys', { name: 'week', allowedModels: ['gpt-4o-mini'], expiry: { type: 'after', hours: 168 } })).status).toBe(201);
    expect((await post('/api/api-keys', { name: 'today', allowedModels: ['openai/gpt-4o-mini'], expiry: { type: 'end_of_day', timeZone: 'UTC' } })).status).toBe(201);
    // Unlimited models are unaffected; "any model" keys are limited when used instead.
    expect((await post('/api/api-keys', { name: 'local', allowedModels: ['local/llama-3'] })).status).toBe(201);
    expect((await post('/api/api-keys', { name: 'anything' })).status).toBe(201);
    void h;
  });

  test('aliases count through their targets', async () => {
    const { h, admin, post } = await world();
    const config = await data<{ version: number; defaultPolicy: unknown }>(await h.request('/api/routing', { cookie: admin }));
    const saved = await h.request('/api/routing', {
      method: 'PUT', cookie: admin,
      json: { version: config.version, defaultPolicy: config.defaultPolicy, aliases: [{ name: 'fast', description: '', enabled: true, capabilities: [], policy: null, targets: [{ modelRef: 'local/llama-3', priority: 1, weight: 1 }, { modelRef: 'openai/gpt-4o-mini', priority: 2, weight: 1 }] }] },
    });
    expect(saved.status).toBe(200);
    // One of the alias's targets has a 7-day limit, so a key for the alias must fit it.
    expect((await post('/api/api-keys', { name: 'alias', allowedModels: ['fast'] })).status).toBe(400);
    expect((await post('/api/api-keys', { name: 'alias', allowedModels: ['fast'], expiry: { type: 'after', hours: 24 } })).status).toBe(201);
  });

  test('a key older than a model\'s limit cannot use it; other models still work', async () => {
    const { h, post } = await world();
    const any = await data<CreatedApiKey>(await post('/api/api-keys', { name: 'anything' }));
    expect((await chat(h, any.secret, 'openai/gpt-4o-mini')).status).toBe(200);

    h.clock.advance(169 * HOUR);
    const refused = await chat(h, any.secret, 'openai/gpt-4o-mini');
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { error: { message: string; code: string } };
    expect(body.error).toMatchObject({ code: 'key_too_old' });
    expect(body.error.message).toBe('This API key is older than the 7 days maximum key lifetime for openai/gpt-4o-mini (set on the provider). Create a new key.');
    expect((await chat(h, any.secret, 'local/llama-3')).status).toBe(200);

    const listed = (await (await h.request('/v1/models', { headers: { authorization: `Bearer ${any.secret}` } })).json()) as { data: { id: string }[] };
    expect(listed.data.map((m) => m.id)).toEqual(['local/llama-3']);
  });

  test('a limit set later applies to existing keys', async () => {
    const { h, admin, post, local } = await world();
    const key = await data<CreatedApiKey>(await post('/api/api-keys', { name: 'local', allowedModels: ['local/llama-3'] }));
    h.clock.advance(3 * HOUR);
    expect((await chat(h, key.secret, 'local/llama-3')).status).toBe(200);
    await h.request(`/api/providers/${local.id}`, { method: 'PATCH', cookie: await h.login(), json: { maxKeyLifetimeHours: 2 } });
    expect((await chat(h, key.secret, 'local/llama-3')).status).toBe(403);
    void admin;
  });

  test('key requests are checked when asked and when approved', async () => {
    const { h, admin, gpt } = await world();
    await h.addUser('val', ['VIEWER']);
    const val = await h.login('val');
    const ask = (json: unknown) => h.request('/api/me/api-key-requests', { method: 'POST', cookie: val, json });
    expect((await ask({ name: 'x', purpose: 'y', allowedModels: ['openai/gpt-4o-mini'] })).status).toBe(400);
    const ok = await data<ApiKeyRequestInfo>(await ask({ name: 'x', purpose: 'y', allowedModels: ['openai/gpt-4o-mini'], expiry: { type: 'after', hours: 48 } }));
    // The limit tightens before the decision: approving as asked is refused; narrowing works.
    await h.request(`/api/models/${gpt.id}`, { method: 'PATCH', cookie: admin, json: { maxKeyLifetimeHours: 24 } });
    expect((await h.request(`/api/api-key-requests/${ok.id}/approve`, { method: 'POST', cookie: admin, json: {} })).status).toBe(400);
    expect((await h.request(`/api/api-key-requests/${ok.id}/approve`, { method: 'POST', cookie: admin, json: { expiry: { type: 'after', hours: 24 } } })).status).toBe(200);
    expect((await h.request(`/api/me/api-key-requests/${ok.id}/create`, { method: 'POST', cookie: val })).status).toBe(201);
  });
});
