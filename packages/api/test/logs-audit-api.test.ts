import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ApiSuccess, AuditRecord, CreatedApiKey, LogPage } from '@clawrouter/shared';
import { ADMIN, createHarness } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

let mock: MockProviders;
beforeAll(() => {
  mock = startMockProviders();
});
afterAll(() => mock.stop());

const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;
const logs = async (h: ReturnType<typeof createHarness>, cookie: string, query = '') => {
  const res = await h.request(`/api/logs${query}`, { cookie });
  expect(res.status).toBe(200);
  return data<LogPage>(res);
};

describe('GET /api/logs (spec §27)', () => {
  test('filters on the server: request id, level, component and text', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const res = await h.request('/api/health', { cookie: admin });
    const requestId = res.headers.get('x-request-id')!;
    const byRequest = await logs(h, admin, `?requestId=${requestId}`);
    expect(byRequest.items.length).toBeGreaterThan(0);
    expect(byRequest.items.every((e) => e.requestId === requestId)).toBe(true);
    expect(byRequest.items.map((e) => e.msg)).toContain('http request');

    await h.request('/api/auth/login', { method: 'POST', json: { username: 'admin', password: 'wrong password!' } });
    const warnings = await logs(h, admin, '?level=warn');
    expect(warnings.items.every((e) => ['warn', 'error', 'fatal'].includes(e.level))).toBe(true);
    const auth = await logs(h, admin, '?component=auth');
    expect(auth.items.every((e) => e.component === 'auth')).toBe(true);
    expect((await logs(h, admin, '?q=SIGN')).items.length).toBeGreaterThan(0);
    expect((await logs(h, admin, '')).components).toContain('http');

    expect((await h.request('/api/logs?level=loud', { cookie: admin })).status).toBe(400);
    expect((await h.request('/api/logs?before=-1', { cookie: admin })).status).toBe(400);
  });

  test('only administrators and operators may read logs', async () => {
    const h = createHarness();
    await h.completeSetup();
    await h.addUser('op', ['OPERATOR']);
    await h.addUser('viewer', ['VIEWER']);
    expect((await h.request('/api/logs', { cookie: await h.login('op') })).status).toBe(200);
    expect((await h.request('/api/logs', { cookie: await h.login('viewer') })).status).toBe(403);
    expect((await h.request('/api/logs')).status).toBe(401);
  });

  test('no password, provider key, API key or session token reaches the log buffer', async () => {
    const h = createHarness();
    h.setProviderFetch(fetch);
    const admin = await h.completeSetup();
    // A provider whose error message echoes the key (the mock does that on a wrong key).
    await h.request('/api/providers', { method: 'POST', cookie: admin, json: { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: 'sk-wrongkeywrongkeywrongkey12' } });
    const providerId = (await h.providers.list())[0]!.id;
    await h.request(`/api/providers/${providerId}/test`, { method: 'POST', cookie: admin });
    await h.request(`/api/providers/${providerId}/credential`, { method: 'PUT', cookie: admin, json: { apiKey: mock.key } });
    const key = await data<CreatedApiKey>(await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'ci' } }));
    await h.request('/v1/models', { headers: { authorization: `Bearer ${key.secret}` } });
    await h.request('/v1/models', { headers: { authorization: `Bearer ${key.secret.slice(0, -2)}xx` } });
    await h.request('/api/auth/login', { method: 'POST', json: { username: 'admin', password: 'not-the-password-123' } });

    const all = JSON.stringify((await logs(h, admin, '?limit=500')).items);
    const sessionToken = admin.split('=')[1]!;
    for (const secret of ['sk-wrongkeywrongkeywrongkey12', mock.key, key.secret, key.secret.slice(13), ADMIN.password, 'not-the-password-123', sessionToken]) {
      expect([secret, all.includes(secret)]).toEqual([secret, false]);
    }
  });
});

describe('GET /api/audit (spec §28)', () => {
  test('filters, pages and searches on the server', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    for (let i = 0; i < 3; i++) {
      await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: `key-${i}` } });
      h.clock.advance(1000);
    }
    await h.request('/api/auth/login', { method: 'POST', json: { username: 'admin', password: 'wrong password!' } });

    const all = await h.request('/api/audit?pageSize=2', { cookie: admin });
    const body = (await all.json()) as ApiSuccess<AuditRecord[]> & { meta: { total: number; resources: string[] } };
    expect(body.data).toHaveLength(2);
    expect(body.meta.total).toBeGreaterThanOrEqual(5); // setup, 3 keys, failed login
    expect(body.meta.resources).toEqual(expect.arrayContaining(['api_key']));

    const keys = await data<AuditRecord[]>(await h.request('/api/audit?action=API_KEY_CREATED', { cookie: admin }));
    expect(keys.map((r) => r.metadata?.name)).toEqual(['key-2', 'key-1', 'key-0']);
    expect((await data<AuditRecord[]>(await h.request('/api/audit?result=FAILURE', { cookie: admin }))).map((r) => r.action)).toEqual(['LOGIN_FAILED']);
    expect(await data<AuditRecord[]>(await h.request('/api/audit?q=key-1', { cookie: admin }))).toHaveLength(1);
    expect(await data<AuditRecord[]>(await h.request('/api/audit?actor=adm', { cookie: admin }))).not.toHaveLength(0);
    // Wildcards typed in the browser are literal.
    expect(await data<AuditRecord[]>(await h.request(`/api/audit?q=${encodeURIComponent('%')}`, { cookie: admin }))).toHaveLength(0);
    // Text of 3+ characters goes through the trigram index: still a case-insensitive
    // substring, with quotes and wildcards taken literally; shorter text scans.
    const search = async (q: string) => (await data<AuditRecord[]>(await h.request(`/api/audit?q=${encodeURIComponent(q)}`, { cookie: admin }))).length;
    expect(await search('KEY-1')).toBe(1);
    expect(await search('ey-')).toBe(3);
    expect(await search('key-%')).toBe(0);
    expect(await search('"key-')).toBe(3); // metadata is JSON: {"name":"key-1"}
    expect(await search('key"x')).toBe(0);
    expect(await search('y-2')).toBe(1);
    expect(await search('y-')).toBeGreaterThanOrEqual(3); // two characters: the LIKE scan
    const since = new Date(h.clock.time - 1500).toISOString();
    expect((await data<AuditRecord[]>(await h.request(`/api/audit?action=API_KEY_CREATED&from=${encodeURIComponent(since)}`, { cookie: admin }))).map((r) => r.metadata?.name)).toEqual(['key-2']);

    expect((await h.request('/api/audit?action=DANCE', { cookie: admin })).status).toBe(400);
    expect((await h.request('/api/audit?result=MAYBE', { cookie: admin })).status).toBe(400);
  });

  test('viewers may not read the audit log', async () => {
    const h = createHarness();
    await h.completeSetup();
    await h.addUser('viewer', ['VIEWER']);
    await h.addUser('op', ['OPERATOR']);
    expect((await h.request('/api/audit', { cookie: await h.login('viewer') })).status).toBe(403);
    expect((await h.request('/api/audit', { cookie: await h.login('op') })).status).toBe(200);
  });
});
