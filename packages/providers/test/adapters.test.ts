import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDefaultRegistry, ProviderCallError, type ProviderCallContext, type StreamEvent } from '../src/index.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

let mock: MockProviders;
beforeAll(() => {
  mock = startMockProviders();
});
afterAll(() => mock.stop());

const registry = createDefaultRegistry();
const cases = [
  { kind: 'openai', base: '/openai/v1', model: 'gpt-4o-mini', text: 'Hello from OpenAI', streamText: 'Hello', models: 3, usage: [7, 4, 11], streamUsage: [7, 2, 9], streamFinish: 'stop' },
  { kind: 'anthropic', base: '/anthropic', model: 'claude-sonnet-4-5', text: 'Hello from Anthropic', streamText: 'Hi there', models: 1, usage: [9, 5, 14], streamUsage: [9, 2, 11], streamFinish: 'length' },
  { kind: 'google', base: '/google/v1beta', model: 'gemini-2.0-flash', text: 'Hello from Gemini', streamText: 'Gemini', models: 1, usage: [6, 3, 9], streamUsage: [6, 2, 8], streamFinish: 'stop' },
  { kind: 'openai_compatible', base: '/local/v1', model: 'llama3', text: 'Hello from OpenAI', streamText: 'Hello', models: 3, usage: [7, 4, 11], streamUsage: [7, 2, 9], streamFinish: 'stop' },
] as const;

const ctx = (base: string, apiKey: string | null = mock.key): ProviderCallContext => ({ endpoint: mock.url + base, apiKey, timeoutMs: 5000 });
const request = (model: string) => ({ model, messages: [{ role: 'system' as const, content: 'Be brief.' }, { role: 'user' as const, content: 'Hi' }], maxTokens: 50, temperature: 0.2 });

describe.each(cases)('$kind adapter (one standardized interface)', (c) => {
  const adapter = registry.get(c.kind);
  const key = c.kind === 'openai_compatible' ? null : mock?.key;

  test('testConnection lists models and measures latency', async () => {
    mock.mode = 'ok';
    const result = await adapter.testConnection(ctx(c.base, key ?? (c.kind === 'openai_compatible' ? null : mock.key)));
    expect(result.models).toHaveLength(c.models);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('sendRequest returns normalized content and provider-reported usage', async () => {
    mock.mode = 'ok';
    const res = await adapter.sendRequest(ctx(c.base, c.kind === 'openai_compatible' ? null : mock.key), request(c.model));
    expect(res.content).toBe(c.text);
    expect(res.finishReason).toBe('stop');
    expect([res.usage.inputTokens, res.usage.outputTokens, res.usage.totalTokens]).toEqual([...c.usage]);
    expect(res.usage.source).toBe('provider');
  });

  test('sendStreamingRequest yields deltas then a done event', async () => {
    mock.mode = 'ok';
    const events: StreamEvent[] = [];
    for await (const e of adapter.sendStreamingRequest(ctx(c.base, c.kind === 'openai_compatible' ? null : mock.key), request(c.model))) events.push(e);
    const done = events.at(-1)!;
    expect(done.type).toBe('done');
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe(c.streamText);
    if (done.type === 'done') {
      expect(done.finishReason).toBe(c.streamFinish);
      expect([done.usage.inputTokens, done.usage.outputTokens, done.usage.totalTokens]).toEqual([...c.streamUsage]);
    }
  });

  if (c.kind !== 'openai_compatible') {
    test('rejected credentials become an auth failure without leaking the key', async () => {
      mock.mode = 'ok';
      const error = await adapter.listModels(ctx(c.base, 'sk-wrong-key-999999')).catch((e) => e);
      expect(error).toBeInstanceOf(ProviderCallError);
      expect(error.failure).toBe('auth');
      expect(error.message).not.toContain('sk-wrong-key-999999');
    });
  }
});

describe('wire format', () => {
  test('OpenAI: bearer auth, max_completion_tokens, streamed usage requested', async () => {
    mock.requests.length = 0;
    await registry.get('openai').sendStreamingRequest(ctx('/openai/v1'), request('gpt-4o-mini'))[Symbol.asyncIterator]().next();
    const sent = mock.requests.at(-1)!;
    expect(sent.headers.authorization).toBe(`Bearer ${mock.key}`);
    expect(sent.body).toMatchObject({ model: 'gpt-4o-mini', max_completion_tokens: 50, stream: true, stream_options: { include_usage: true } });
  });

  test('compatible servers get max_tokens and no authorization header without a key', async () => {
    mock.requests.length = 0;
    await registry.get('openai_compatible').sendRequest(ctx('/local/v1', null), request('llama3'));
    const sent = mock.requests.at(-1)!;
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.body).toMatchObject({ max_tokens: 50 });
    expect(sent.body).not.toHaveProperty('stream_options');
  });

  test('Anthropic: system prompt separated, version header, default max_tokens', async () => {
    mock.requests.length = 0;
    await registry.get('anthropic').sendRequest(ctx('/anthropic'), { model: 'claude-sonnet-4-5', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }] });
    const sent = mock.requests.at(-1)!;
    expect(sent.headers['anthropic-version']).toBe('2023-06-01');
    expect(sent.body).toEqual({ model: 'claude-sonnet-4-5', max_tokens: 4096, system: 'S', messages: [{ role: 'user', content: 'U' }] });
  });

  test('Google: key in a header, never in the URL; roles mapped to user/model', async () => {
    mock.requests.length = 0;
    await registry.get('google').sendRequest(ctx('/google/v1beta'), { model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] });
    const sent = mock.requests.at(-1)!;
    expect(sent.search).not.toContain(mock.key);
    expect(sent.headers['x-goog-api-key']).toBe(mock.key);
    expect((sent.body as { contents: { role: string }[] }).contents.map((x) => x.role)).toEqual(['user', 'model', 'user']);
  });
});

describe('failure handling', () => {
  test.each([
    ['server_error', 'server_error'],
    ['rate_limited', 'rate_limited'],
    ['redirect', 'invalid_response'],
    ['garbage', 'invalid_response'],
  ] as const)('%s -> %s', async (mode, failure) => {
    mock.mode = mode;
    const error = await registry.get('openai').listModels(ctx('/openai/v1')).catch((e) => e);
    mock.mode = 'ok';
    expect(error).toBeInstanceOf(ProviderCallError);
    expect(error.failure).toBe(failure);
  });

  test('stream cancellation stops reading', async () => {
    const controller = new AbortController();
    const it = registry.get('anthropic').sendStreamingRequest({ ...ctx('/anthropic'), signal: controller.signal }, request('claude-sonnet-4-5'))[Symbol.asyncIterator]();
    expect((await it.next()).value).toMatchObject({ type: 'delta' });
    controller.abort();
    const rest = await (async () => {
      const out = [];
      try {
        for (let r = await it.next(); !r.done; r = await it.next()) out.push(r.value);
      } catch {
        // cancelled
      }
      return out;
    })();
    expect(rest.filter((e) => e.type === 'delta').length).toBeLessThan(2);
  });
});
