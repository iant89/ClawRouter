import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ApiErrorBody, ApiSuccess, DiscoveredModelInfo, ImportModelsResult, ModelInfo, PageMeta, ProviderInfo } from '@clawapi/shared';
import { createHarness } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

let mock: MockProviders;
beforeAll(() => {
  mock = startMockProviders();
});
afterAll(() => mock.stop());
const json = async <T>(res: Response) => (await res.json()) as T;

async function world() {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  await h.addUser('op', ['OPERATOR']);
  await h.addUser('viewer', ['VIEWER']);
  const operator = await h.login('op');
  const provider = (await json<ApiSuccess<ProviderInfo>>(await h.request('/api/providers', {
    method: 'POST', cookie: operator, json: { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key },
  }))).data;
  return { h, admin, operator, viewer: await h.login('viewer'), provider };
}

describe('model API', () => {
  test('discover -> import -> list -> patch -> delete', async () => {
    const { h, operator, provider } = await world();
    const discovered = await json<ApiSuccess<DiscoveredModelInfo[]>>(await h.request(`/api/providers/${provider.id}/models/discover`, { cookie: operator }));
    expect(discovered.data.map((m) => m.providerModelId)).toEqual(['gpt-4o', 'gpt-4o-mini', 'text-embedding-3-small']);

    const imported = await json<ApiSuccess<ImportModelsResult>>(await h.request(`/api/providers/${provider.id}/models/import`, {
      method: 'POST', cookie: operator, json: { providerModelIds: ['gpt-4o-mini', 'gpt-4o'] },
    }));
    expect(imported.data.imported).toBe(2);

    const list = await json<ApiSuccess<ModelInfo[]> & { meta: PageMeta }>(await h.request('/api/models?pageSize=1&capability=CHAT', { cookie: operator }));
    expect(list.meta).toEqual({ page: 1, pageSize: 1, total: 2 });

    const id = imported.data.models[0]!.id;
    const patched = await json<ApiSuccess<ModelInfo>>(await h.request(`/api/models/${id}`, {
      method: 'PATCH', cookie: operator, json: { capabilities: ['CHAT', 'VISION'], cost: { inputPerMTok: 0.15, outputPerMTok: 0.6 }, contextLength: 128000 },
    }));
    expect(patched.data).toMatchObject({ capabilities: ['CHAT', 'VISION'], contextLength: 128000, cost: { inputPerMTok: 0.15, outputPerMTok: 0.6 } });

    expect((await h.request(`/api/models/${id}`, { method: 'DELETE', cookie: operator })).status).toBe(204);
    expect((await h.request(`/api/models/${id}`, { cookie: operator })).status).toBe(404);
  });

  test('manual create returns 201 with location', async () => {
    const { h, operator, provider } = await world();
    const res = await h.request('/api/models', { method: 'POST', cookie: operator, json: { providerId: provider.id, providerModelId: 'o3-mini', capabilities: ['CHAT', 'REASONING'] } });
    expect(res.status).toBe(201);
    expect(res.headers.get('location')).toStartWith('/api/models/');
  });

  test('viewers read; only writers change or discover', async () => {
    const { h, viewer, provider } = await world();
    expect((await h.request('/api/models', { cookie: viewer })).status).toBe(200);
    expect((await h.request(`/api/providers/${provider.id}/models/discover`, { cookie: viewer })).status).toBe(403);
    expect((await h.request('/api/models', { method: 'POST', cookie: viewer, json: { providerId: provider.id, providerModelId: 'x' } })).status).toBe(403);
  });

  test('validation of queries and bodies', async () => {
    const { h, operator, provider } = await world();
    expect((await h.request('/api/models?capability=MAGIC', { cookie: operator })).status).toBe(400);
    expect((await h.request('/api/models?pageSize=500', { cookie: operator })).status).toBe(400);
    const res = await h.request('/api/models', { method: 'POST', cookie: operator, json: { providerId: provider.id, providerModelId: 'x', cost: { inputPerMTok: 'cheap' } } });
    expect((await json<ApiErrorBody>(res)).error.details?.issues?.[0]?.path).toBe('cost.inputPerMTok');
  });
});
