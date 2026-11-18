import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ApiErrorBody, ApiSuccess, CreatedApiKey, ProviderInfo, RequestRecord } from '@clawrouter/shared';
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
});

const actor = { id: 'u', username: 'admin' };
const client = { ip: null };
const json = async <T>(res: Response) => (await res.json()) as T;
const data = async <T>(res: Response) => (await json<ApiSuccess<T>>(res)).data;

async function world() {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const provider: ProviderInfo = await h.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key }, client);
  h.models.create(actor, { providerId: provider.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'] }, client);
  h.models.create(actor, { providerId: provider.id, providerModelId: 'gpt-4o', capabilities: ['CHAT'] }, client);
  await h.addUser('olga', ['OPERATOR']);
  const operator = await h.login('olga');
  const own = async (cookie: string, body: Record<string, unknown> = {}) => {
    const res = await h.request('/api/me/api-keys', { method: 'POST', cookie, json: { name: 'playground', expiry: { type: 'after', hours: 24 }, ...body } });
    expect(res.status).toBe(201);
    return (await data<CreatedApiKey>(res)).key.id;
  };
  return { h, admin, operator, own };
}

const send = (h: Harness, cookie: string | undefined, keyId: string, request: Record<string, unknown>) =>
  h.request('/api/playground/chat', { method: 'POST', cookie, json: { keyId, request } });
const hello = (extra: Record<string, unknown> = {}, model = 'openai/gpt-4o-mini') => ({ model, messages: [{ role: 'user', content: 'Hi' }], ...extra });

describe('playground', () => {
  test('a chat with one of your own keys goes through the gateway and is recorded for that key', async () => {
    const { h, admin, operator, own } = await world();
    const keyId = await own(operator);
    const res = await send(h, operator, keyId, hello());
    expect(res.status).toBe(200);
    expect(res.headers.get('x-clawrouter-model')).toBe('openai/gpt-4o-mini');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const requestId = res.headers.get('x-request-id')!;
    const body = await json<{ choices: { message: { content: string } }[] }>(res);
    expect(body.choices[0]!.message.content.length).toBeGreaterThan(0);
    const history = await data<RequestRecord[]>(await h.request('/api/requests', { cookie: admin }));
    expect(history.find((r) => r.id === requestId)).toMatchObject({ status: 'COMPLETED', apiKey: { id: keyId } });
  });

  test('streams the answer as the gateway does', async () => {
    const { h, operator, own } = await world();
    const res = await send(h, operator, await own(operator), hello({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('chat.completion.chunk');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  test('lists the models the key may use', async () => {
    const { h, operator, own } = await world();
    const any = await data<{ id: string }[]>(await h.request(`/api/playground/models?keyId=${await own(operator)}`, { cookie: operator }));
    expect(any.map((m) => m.id)).toEqual(expect.arrayContaining(['openai/gpt-4o', 'openai/gpt-4o-mini']));
    const one = await own(operator, { name: 'mini only', allowedModels: ['openai/gpt-4o-mini'] });
    expect((await data<{ id: string }[]>(await h.request(`/api/playground/models?keyId=${one}`, { cookie: operator }))).map((m) => m.id)).toEqual(['openai/gpt-4o-mini']);
    // The key's own model list still applies to chats.
    const refused = await send(h, operator, one, hello({}, 'openai/gpt-4o'));
    expect(refused.status).toBe(403);
  });

  test("another user's key, a revoked key and no key are refused alike", async () => {
    const { h, admin, operator, own } = await world();
    const adminKey = await own(admin);
    for (const res of [await send(h, operator, adminKey, hello()), await h.request(`/api/playground/models?keyId=${adminKey}`, { cookie: operator })]) {
      expect(res.status).toBe(400);
      expect((await json<ApiErrorBody>(res)).error.message).toBe('That key is not one of your active API keys.');
    }
    const mine = await own(operator);
    expect((await h.request(`/api/me/api-keys/${mine}`, { method: 'DELETE', cookie: operator })).status).toBe(200);
    expect((await send(h, operator, mine, hello())).status).toBe(400);
    expect((await h.request('/api/playground/chat', { method: 'POST', cookie: operator, json: { request: hello() } })).status).toBe(400);
  });

  test('needs a session, and an invalid body gets the gateway validation error', async () => {
    const { h, operator, own } = await world();
    const keyId = await own(operator);
    expect((await send(h, undefined, keyId, hello())).status).toBe(401);
    expect((await h.request(`/api/playground/models?keyId=${keyId}`)).status).toBe(401);
    const bad = await send(h, operator, keyId, { model: 'openai/gpt-4o-mini', messages: [] });
    expect(bad.status).toBe(400);
  });
});
