import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ApiErrorBody, ApiSuccess, ConnectionTestResult, ProviderDetail, ProviderInfo, ProviderKindInfo } from '@clawapi/shared';
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
  return { h, admin, operator: await h.login('op'), viewer: await h.login('viewer') };
}

describe('/api/providers', () => {
  test('full lifecycle over HTTP; responses never contain the key', async () => {
    const { h, operator } = await world();
    const created = await h.request('/api/providers', {
      method: 'POST', cookie: operator,
      json: { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toStartWith('/api/providers/');
    const text = await created.text();
    expect(text).not.toContain(mock.key);
    const p = (JSON.parse(text) as ApiSuccess<ProviderInfo>).data;
    expect(p.credential).toMatchObject({ configured: true, hint: 'WXYZ' });

    const tested = await json<ApiSuccess<ConnectionTestResult>>(await h.request(`/api/providers/${p.id}/test`, { method: 'POST', cookie: operator, json: {} }));
    expect(tested.data).toMatchObject({ ok: true, status: 'HEALTHY', modelCount: 3 });

    const detail = await json<ApiSuccess<ProviderDetail>>(await h.request(`/api/providers/${p.id}`, { cookie: operator }));
    expect(detail.data.recentChecks).toHaveLength(1);

    const patched = await json<ApiSuccess<ProviderInfo>>(await h.request(`/api/providers/${p.id}`, { method: 'PATCH', cookie: operator, json: { priority: 5, enabled: false } }));
    expect(patched.data).toMatchObject({ priority: 5, enabled: false, status: 'DISABLED' });

    const keyRes = await h.request(`/api/providers/${p.id}/credential`, { method: 'PUT', cookie: operator, json: { apiKey: 'sk-replacement-key-0000AAAA' } });
    expect((await json<ApiSuccess<ProviderInfo>>(keyRes)).data.credential.hint).toBe('AAAA');
    expect((await h.request(`/api/providers/${p.id}/credential`, { method: 'DELETE', cookie: operator })).status).toBe(200);

    const list = await h.request('/api/providers', { cookie: operator });
    expect(await list.text()).not.toContain('sk-');
    expect((await h.request(`/api/providers/${p.id}`, { method: 'DELETE', cookie: operator })).status).toBe(204);
    expect((await h.request(`/api/providers/${p.id}`, { cookie: operator })).status).toBe(404);
  });

  test('kinds describe each provider type', async () => {
    const { h, viewer } = await world();
    const kinds = (await json<ApiSuccess<ProviderKindInfo[]>>(await h.request('/api/providers/kinds', { cookie: viewer }))).data;
    expect(kinds.map((k) => k.kind)).toEqual(['openai', 'anthropic', 'google', 'openai_compatible']);
    expect(kinds.find((k) => k.kind === 'openai_compatible')).toMatchObject({ apiKeyRequired: false, endpointRequired: true });
  });

  test('viewers can read but not change or test', async () => {
    const { h, operator, viewer } = await world();
    const p = (await json<ApiSuccess<ProviderInfo>>(await h.request('/api/providers', {
      method: 'POST', cookie: operator, json: { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1` },
    }))).data;
    expect((await h.request('/api/providers', { cookie: viewer })).status).toBe(200);
    expect((await h.request(`/api/providers/${p.id}`, { method: 'PATCH', cookie: viewer, json: { priority: 1 } })).status).toBe(403);
    expect((await h.request(`/api/providers/${p.id}/test`, { method: 'POST', cookie: viewer, json: {} })).status).toBe(403);
    expect((await h.request(`/api/providers/${p.id}/credential`, { method: 'PUT', cookie: viewer, json: { apiKey: 'sk-xxxxxxxxxxxx' } })).status).toBe(403);
  });

  test('validation errors are field-level', async () => {
    const { h, operator } = await world();
    const res = await h.request('/api/providers', { method: 'POST', cookie: operator, json: { name: 'x', identifier: 'x y', kind: 'skynet', timeoutMs: 5 } });
    expect(res.status).toBe(400);
    const paths = (await json<ApiErrorBody>(res)).error.details?.issues?.map((i) => i.path).sort();
    expect(paths).toEqual(['kind', 'timeoutMs']);
  });
});
