import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createSecretBox, generateSecretKey, parseSecretKey } from '@clawapi/core';
import { createDefaultRegistry, createProviderService, createSqliteProviderRepository } from '../src/index.ts';
import { createHarness } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

let mock: MockProviders;
beforeAll(() => {
  mock = startMockProviders();
});
afterAll(() => mock.stop());

const actor = { id: 'u-admin', username: 'admin' };
const client = { ip: '198.51.100.1', requestId: 'req_t' };

function setup() {
  const h = createHarness();
  h.setProviderFetch(fetch);
  mock.mode = 'ok';
  return h;
}

const openai = (overrides = {}) => ({ name: 'OpenAI prod', identifier: 'openai-prod', kind: 'openai' as const, endpoint: `${mock.url}/openai/v1`, apiKey: mock.key, ...overrides });

describe('lifecycle', () => {
  test('create applies defaults and starts UNKNOWN', async () => {
    const h = setup();
    const p = await h.providers.create(actor, { name: 'Anthropic', identifier: 'anthropic', kind: 'anthropic' }, client);
    expect(p).toMatchObject({ endpoint: 'https://api.anthropic.com', enabled: true, priority: 100, timeoutMs: 60000, status: 'UNKNOWN', credential: { configured: false } });
    expect(p.capabilities).toContain('CHAT');
  });

  test('validation: identifier, endpoint, kind-required endpoint, duplicates', async () => {
    const h = setup();
    const bad = await h.providers.create(actor, { name: 'x', identifier: 'Bad Id', kind: 'openai_compatible', endpoint: 'http://api.example.com' }, client).catch((e) => e);
    expect(bad.code).toBe('VALIDATION_ERROR');
    expect(bad.details.issues.map((i: { path: string }) => i.path).sort()).toEqual(['endpoint', 'identifier']);
    const noEndpoint = await h.providers.create(actor, { name: 'x', identifier: 'local', kind: 'openai_compatible' }, client).catch((e) => e);
    expect(noEndpoint.details.issues[0].message).toContain('required');
    await h.providers.create(actor, openai(), client);
    expect((await h.providers.create(actor, openai({ name: 'other' }), client).catch((e) => e)).code).toBe('CONFLICT');
    expect((await h.providers.create(actor, openai({ identifier: 'other' }), client).catch((e) => e)).code).toBe('CONFLICT');
  });

  test('enable/disable sets status and is audited; delete removes everything', async () => {
    const h = setup();
    const p = await h.providers.create(actor, openai(), client);
    expect((await h.providers.update(actor, p.id, { enabled: false }, client)).status).toBe('DISABLED');
    expect((await h.providers.update(actor, p.id, { enabled: true }, client)).status).toBe('UNKNOWN');
    const actions = h.audit.list().map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['PROVIDER_CREATED', 'CREDENTIAL_CREATED', 'PROVIDER_DISABLED', 'PROVIDER_ENABLED']));
    h.providers.remove(actor, p.id, client);
    expect(h.db.all('SELECT * FROM provider_credentials')).toEqual([]);
    expect(h.audit.list({ action: 'PROVIDER_DELETED' })).toHaveLength(1);
  });

  test('updates record what changed', async () => {
    const h = setup();
    const p = await h.providers.create(actor, openai(), client);
    await h.providers.update(actor, p.id, { priority: 10, name: 'OpenAI' }, client);
    const rec = h.audit.list({ action: 'PROVIDER_UPDATED' })[0]!;
    expect(rec.metadata).toMatchObject({ changes: { priority: { from: 100, to: 10 }, name: { from: 'OpenAI prod', to: 'OpenAI' } } });
  });
});

describe('credentials (spec §29)', () => {
  test('are encrypted at rest, bound to the provider, and never returned', async () => {
    const h = setup();
    const p = await h.providers.create(actor, openai(), client);
    const dump = JSON.stringify(h.db.all('SELECT * FROM provider_credentials')) + JSON.stringify(h.db.all('SELECT * FROM audit_log')) + JSON.stringify(h.db.all('SELECT * FROM providers'));
    expect(dump).not.toContain(mock.key);
    const row = h.db.get<{ ciphertext: string; key_fingerprint: string }>('SELECT ciphertext, key_fingerprint FROM provider_credentials')!;
    expect(row.ciphertext).toStartWith('v1.');
    expect(row.key_fingerprint).toBe(h.secrets.fingerprint);
    expect(JSON.stringify(h.providers.get(p.id))).not.toContain(mock.key);
    expect(h.providers.get(p.id).credential).toEqual({ configured: true, hint: 'WXYZ', updatedAt: expect.any(String) });
    expect(JSON.stringify(h.logs)).not.toContain(mock.key);
  });

  test('short keys get no hint', async () => {
    const h = setup();
    const p = await h.providers.create(actor, openai({ apiKey: 'shortkey12' }), client);
    expect(p.credential.hint).toBeNull();
  });

  test('replace and remove are audited', async () => {
    const h = setup();
    const p = await h.providers.create(actor, openai(), client);
    await h.providers.setApiKey(actor, p.id, 'sk-another-key-0000000000', client);
    expect(h.providers.removeApiKey(actor, p.id, client).credential.configured).toBe(false);
    expect(h.audit.list().map((r) => r.action)).toEqual(expect.arrayContaining(['CREDENTIAL_REPLACED', 'CREDENTIAL_REMOVED']));
    expect(() => h.providers.removeApiKey(actor, p.id, client)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  test('keys with whitespace are rejected', async () => {
    const h = setup();
    expect((await h.providers.create(actor, openai({ apiKey: 'sk-abc def-123' }), client).catch((e) => e)).code).toBe('VALIDATION_ERROR');
  });

  test('moving the endpoint to another host requires re-entering the key', async () => {
    const h = setup();
    const p = await h.providers.create(actor, openai(), client);
    const error = await h.providers.update(actor, p.id, { endpoint: 'https://evil.example/v1' }, client).catch((e) => e);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details.issues[0].path).toBe('apiKey');
    // Same host, different path: fine.
    await h.providers.update(actor, p.id, { endpoint: `${mock.url}/openai/v2` }, client);
    // New host with the key: fine.
    await h.providers.update(actor, p.id, { endpoint: 'https://api.openai.com/v1', apiKey: 'sk-new-key-for-new-host-1' }, client);
  });

  test('a credential sealed with another secret key is reported, not used', async () => {
    const h = setup();
    const p = await h.providers.create(actor, openai(), client);
    const other = createProviderService({
      repo: createSqliteProviderRepository(h.db), registry: createDefaultRegistry(), secrets: createSecretBox(parseSecretKey(generateSecretKey())), audit: h.audit, fetch,
    });
    const result = await other.test(actor, p.id, client);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('OFFLINE');
    expect(result.message).toContain('different secret key');
  });
});

describe('connection tests and status', () => {
  test('success: HEALTHY with models; audited; history recorded', async () => {
    const h = setup();
    const p = await h.providers.create(actor, openai(), client);
    const result = await h.providers.test(actor, p.id, client);
    expect(result).toMatchObject({ ok: true, status: 'HEALTHY', modelCount: 3, sampleModels: ['gpt-4o-mini', 'gpt-4o', 'text-embedding-3-small'] });
    expect(h.providers.get(p.id)).toMatchObject({ status: 'HEALTHY', statusDetail: 'Connected' });
    expect(h.providers.get(p.id).recentChecks[0]).toMatchObject({ kind: 'TEST', status: 'HEALTHY' });
    expect(h.audit.list({ action: 'CONNECTION_TEST' })[0]).toMatchObject({ result: 'SUCCESS' });
  });

  test.each([
    ['auth', 'OFFLINE', 'rejected the credentials'],
    ['server_error', 'OFFLINE', 'server error'],
    ['rate_limited', 'DEGRADED', 'rate limiting'],
  ] as const)('%s -> %s', async (mode, status, text) => {
    const h = setup();
    const p = await h.providers.create(actor, openai(), client);
    mock.mode = mode;
    const result = await h.providers.test(actor, p.id, client);
    mock.mode = 'ok';
    expect(result.status).toBe(status);
    expect(result.message).toContain(text);
    expect(result.message).not.toContain(mock.key);
  });

  test('slow responses are DEGRADED', async () => {
    const h = createHarness();
    h.setProviderFetch(fetch);
    const svc = createProviderService({ repo: createSqliteProviderRepository(h.db), registry: createDefaultRegistry(), secrets: h.secrets, audit: h.audit, fetch, slowThresholdMs: 20 });
    const p = await svc.create(actor, openai(), client);
    mock.mode = 'slow';
    mock.slowMs = 60;
    const result = await svc.test(actor, p.id, client);
    mock.mode = 'ok';
    expect(result.status).toBe('DEGRADED');
    expect(result.message).toContain('slowly');
  });

  test('missing key: UNKNOWN, not OFFLINE, and no network call', async () => {
    const h = setup();
    const p = await h.providers.create(actor, openai({ apiKey: undefined }), client);
    mock.requests.length = 0;
    const result = await h.providers.test(actor, p.id, client);
    expect(result).toMatchObject({ ok: false, status: 'UNKNOWN', message: 'No API key is configured.' });
    expect(mock.requests).toHaveLength(0);
  });

  test('a disabled provider can be tested but stays DISABLED', async () => {
    const h = setup();
    const p = await h.providers.create(actor, openai({ enabled: false }), client);
    const result = await h.providers.test(actor, p.id, client);
    expect(result.ok).toBe(true);
    expect(h.providers.get(p.id).status).toBe('DISABLED');
  });

  test('concurrent tests of one provider share a single call', async () => {
    const h = setup();
    const p = await h.providers.create(actor, openai(), client);
    mock.requests.length = 0;
    const [a, b] = await Promise.all([h.providers.test(actor, p.id, client), h.providers.test(actor, p.id, client)]);
    expect(a).toBe(b);
    expect(mock.requests).toHaveLength(1);
  });

  test('status changes emit provider.status and notify providers.read holders', async () => {
    const h = setup();
    const viewer = (await h.addUser('v', ['VIEWER'])).id;
    const p = await h.providers.create(actor, openai(), client);
    const seen: string[] = [];
    h.events.on('provider.status', (e) => { seen.push(`${e.previous}->${e.current}`); });
    await h.providers.checkAll();
    mock.mode = 'server_error';
    await h.providers.checkAll();
    mock.mode = 'ok';
    h.clock.advance(1000);
    await h.providers.checkAll();
    expect(seen).toEqual(['UNKNOWN->HEALTHY', 'HEALTHY->OFFLINE', 'OFFLINE->HEALTHY']);
    const notes = h.notifications.list({ userId: viewer, permissions: [...h.authz.principalFor(viewer).permissions] }).items;
    expect(notes.map((n) => [n.severity, n.title])).toEqual([['SUCCESS', 'Provider OpenAI prod recovered'], ['ERROR', 'Provider OpenAI prod is offline']]);
    expect(p).toBeTruthy();
  });

  test('health summary counts enabled providers only', async () => {
    const h = setup();
    expect(h.providers.healthSummary().status).toBe('DISABLED');
    const a = await h.providers.create(actor, openai(), client);
    await h.providers.create(actor, { ...openai(), name: 'bb', identifier: 'bb', apiKey: 'sk-wrong-key-999999' }, client);
    await h.providers.checkAll();
    expect(h.providers.healthSummary()).toEqual({ status: 'DEGRADED', detail: '1 of 2 enabled provider(s) healthy' });
    expect(a).toBeTruthy();
  });
});

describe('standardized calls (phase 5 exit criterion)', () => {
  test('chat and chatStream reach different providers through one interface', async () => {
    const h = setup();
    const o = await h.providers.create(actor, openai(), client);
    const a = await h.providers.create(actor, { name: 'Anthropic', identifier: 'anthropic', kind: 'anthropic', endpoint: `${mock.url}/anthropic`, apiKey: mock.key }, client);
    const g = await h.providers.create(actor, { name: 'Google', identifier: 'google', kind: 'google', endpoint: `${mock.url}/google/v1beta`, apiKey: mock.key }, client);
    const l = await h.providers.create(actor, { name: 'Local', identifier: 'local', kind: 'openai_compatible', endpoint: `${mock.url}/local/v1` }, client);
    const msgs = [{ role: 'user' as const, content: 'hi' }];
    const answers = await Promise.all([
      h.providers.chat(o.id, { model: 'gpt-4o-mini', messages: msgs }),
      h.providers.chat(a.id, { model: 'claude-sonnet-4-5', messages: msgs }),
      h.providers.chat(g.id, { model: 'gemini-2.0-flash', messages: msgs }),
      h.providers.chat(l.id, { model: 'llama3', messages: msgs }),
    ]);
    expect(answers.map((r) => r.content)).toEqual(['Hello from OpenAI', 'Hello from Anthropic', 'Hello from Gemini', 'Hello from OpenAI']);
    let streamed = '';
    for await (const e of h.providers.chatStream(a.id, { model: 'claude-sonnet-4-5', messages: msgs })) if (e.type === 'delta') streamed += e.text;
    expect(streamed).toBe('Hi there');
  });

  test('disabled providers refuse calls', async () => {
    const h = setup();
    const p = await h.providers.create(actor, openai({ enabled: false }), client);
    await expect(h.providers.chat(p.id, { model: 'x', messages: [] })).rejects.toThrow('disabled');
  });
});
