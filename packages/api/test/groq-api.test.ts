import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ApiSuccess, CreatedApiKey, DiscoveredModelInfo, ImportModelsResult, ProviderInfo, RequestDetail } from '@clawrouter/shared';
import { createHarness } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

let mock: MockProviders;
beforeAll(() => {
  mock = startMockProviders();
});
afterAll(() => mock.stop());

const json = async <T>(res: Response) => (await res.json()) as T;
const data = async <T>(res: Response) => (await json<ApiSuccess<T>>(res)).data;

/** A Groq provider (pointed at the mock), its models discovered and imported, and one key. */
async function world() {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const created = await h.request('/api/providers', { method: 'POST', cookie: admin, json: { name: 'Groq', identifier: 'groq', kind: 'groq', endpoint: `${mock.url}/groq/openai/v1`, apiKey: mock.key } });
  expect(created.status).toBe(201);
  const provider = await data<ProviderInfo>(created);
  const key = await data<CreatedApiKey>(await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'ci' } }));
  return { h, admin, provider, key };
}

describe('Groq provider', () => {
  test('a Groq provider uses the Groq endpoint by default and keeps its API key write-only', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const res = await h.request('/api/providers', { method: 'POST', cookie: admin, json: { name: 'Groq', identifier: 'groq', kind: 'groq', apiKey: 'gsk_test_0123456789abcdefghij' } });
    expect(res.status).toBe(201);
    const p = await data<ProviderInfo>(res);
    expect(p).toMatchObject({ kind: 'groq', endpoint: 'https://api.groq.com/openai/v1' });
    expect(JSON.stringify(p)).not.toContain('0123456789abcdefghij');
  });

  test('discovery lists active models with their limits; import registers them', async () => {
    const { h, admin, provider } = await world();
    const found = await data<DiscoveredModelInfo[]>(await h.request(`/api/providers/${provider.id}/models/discover`, { cookie: admin }));
    expect(found.map((m) => m.providerModelId)).toEqual(['canopylabs/orpheus-v1-english', 'llama-3.3-70b-versatile', 'meta-llama/llama-guard-4-12b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'whisper-large-v3']);
    const by = (id: string) => found.find((m) => m.providerModelId === id)!;
    expect(by('llama-3.3-70b-versatile')).toMatchObject({ displayName: 'Llama 3.3 70B', contextLength: 131072, maxOutputTokens: 32768, capabilities: ['CHAT', 'TOOL_USE'], cost: { inputPerMTok: 0.59, outputPerMTok: 0.79 }, registered: false });
    // Groq says per model whether it supports tools: this one only lists json_mode.
    expect(by('qwen/qwen3.8-27b').capabilities).toEqual(['CHAT', 'VISION']);

    expect(by('canopylabs/orpheus-v1-english').capabilities).toEqual([]); // speech: not a chat model
    expect(by('whisper-large-v3').capabilities).toEqual([]);

    const imported = await data<ImportModelsResult>(await h.request(`/api/providers/${provider.id}/models/import`, {
      method: 'POST', cookie: admin, json: { providerModelIds: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'] },
    }));
    expect(imported.imported).toBe(2);
    expect(imported.models.map((m) => [m.ref, m.displayName, m.contextLength, m.cost])).toEqual([
      ['groq/llama-3.3-70b-versatile', 'Llama 3.3 70B', 131072, { inputPerMTok: 0.59, outputPerMTok: 0.79, currency: 'USD' }],
      ['groq/openai/gpt-oss-120b', 'GPT OSS 120B', 131072, { inputPerMTok: 0.15, outputPerMTok: 0.6, currency: 'USD' }],
    ]);
  });

  test('chat completions go through the gateway, streamed or not, with usage recorded', async () => {
    const { h, admin, provider, key } = await world();
    await h.request(`/api/providers/${provider.id}/models/import`, { method: 'POST', cookie: admin, json: { providerModelIds: ['llama-3.3-70b-versatile'] } });
    const call = (stream: boolean) => h.request('/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${key.secret}` },
      json: { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 64, stream },
    });

    const plain = await call(false);
    expect(plain.status).toBe(200);
    expect(plain.headers.get('x-clawrouter-model')).toBe('groq/llama-3.3-70b-versatile');
    const body = await json<{ choices: { message: { content: string } }[]; usage: { prompt_tokens: number; completion_tokens: number } }>(plain);
    expect(body.choices[0]!.message.content).toBe('Hello from Groq');
    expect(body.usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 5 });
    expect(mock.requests.at(-1)!.body).toMatchObject({ model: 'llama-3.3-70b-versatile', max_completion_tokens: 64 });

    const streamed = await call(true);
    expect(streamed.status).toBe(200);
    const text = await streamed.text();
    expect(text).toContain('"Hel"');
    expect(text).toContain('[DONE]');
    await Bun.sleep(5);

    // The stream's usage came from x_groq.usage and was recorded with the request.
    const id = streamed.headers.get('x-request-id')!;
    const detail = await data<RequestDetail>(await h.request(`/api/requests/${id}`, { cookie: admin }));
    expect(detail).toMatchObject({ modelRef: 'groq/llama-3.3-70b-versatile', inputTokens: 12, outputTokens: 2, usageSource: 'provider' });
    // The cost comes from Groq's published prices, set when the model was imported.
    expect(detail.costUsd).toBeCloseTo((12 * 0.59 + 2 * 0.79) / 1e6, 12);
  });

  test('a wrong Groq key fails the connection test without showing the key', async () => {
    const h = createHarness();
    h.setProviderFetch(fetch);
    const admin = await h.completeSetup();
    const p = await data<ProviderInfo>(await h.request('/api/providers', { method: 'POST', cookie: admin, json: { name: 'Groq', identifier: 'groq', kind: 'groq', endpoint: `${mock.url}/groq/openai/v1`, apiKey: 'gsk_wrong_key_9876543210zyxw' } }));
    const res = await h.request(`/api/providers/${p.id}/test`, { method: 'POST', cookie: admin });
    const text = await res.text();
    expect(text).not.toContain('9876543210zyxw');
    expect(text.toLowerCase()).toMatch(/auth|key|credential/);
  });
});
