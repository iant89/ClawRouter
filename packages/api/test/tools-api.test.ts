import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ApiSuccess, Capability, CreatedApiKey, ProviderKind } from '@clawrouter/shared';
import { createHarness } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

let mock: MockProviders;
beforeAll(() => {
  mock = startMockProviders();
});
afterAll(() => mock.stop());
beforeEach(() => {
  mock.mode = 'ok';
  mock.requests.length = 0;
});

const actor = { id: 'u', username: 'admin' };
const client = { ip: null };
type OpenAiError = { error: { message: string; type: string; param: string | null } };
type Completion = { choices: { message: { role: string; content: string | null; tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[] }; finish_reason: string }[] };
const json = async <T>(res: Response) => (await res.json()) as T;

const weather = {
  type: 'function',
  function: { name: 'get_weather', description: 'Current weather in a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } },
};
const ask = (model: string, extra: Record<string, unknown> = {}) => ({ model, messages: [{ role: 'user', content: 'Weather in Paris?' }], tools: [weather], ...extra });

/** One provider of each kind with one chat model, marked Tool use unless said otherwise. */
async function world(tools = true) {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const caps: Capability[] = tools ? ['CHAT', 'TOOL_USE'] : ['CHAT'];
  const add = async (identifier: string, kind: ProviderKind, path: string, model: string, priority: number) => {
    const p = await h.providers.create(actor, { name: identifier, identifier, kind, endpoint: `${mock.url}${path}`, apiKey: mock.key, priority }, client);
    h.models.create(actor, { providerId: p.id, providerModelId: model, capabilities: caps }, client);
  };
  await add('openai', 'openai', '/openai/v1', 'gpt-4o-mini', 10);
  await add('anthropic', 'anthropic', '/anthropic', 'claude-sonnet-4-5', 20);
  await add('google', 'google', '/google/v1beta', 'gemini-2.0-flash', 30);
  const res = await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'ci' } });
  const key = ((await res.json()) as ApiSuccess<CreatedApiKey>).data.secret;
  const v1 = (body: unknown) => h.request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, json: body });
  return { h, v1 };
}

const sent = () => mock.requests.filter((r) => r.method === 'POST').at(-1)!.body as Record<string, unknown>;

/** Reads a streamed completion: the text and the tool calls rebuilt from their pieces. */
async function readStream(res: Response) {
  const text = await res.text();
  const chunks = text.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)) as { choices: { delta: { content?: string; tool_calls?: { index: number; id?: string; type?: string; function: { name?: string; arguments?: string } }[] }; finish_reason: string | null }[] });
  const calls: { id?: string; type?: string; name: string; arguments: string }[] = [];
  let content = '';
  let finish: string | null = null;
  for (const c of chunks) {
    const choice = c.choices[0];
    if (!choice) continue;
    content += choice.delta.content ?? '';
    for (const t of choice.delta.tool_calls ?? []) {
      calls[t.index] ??= { name: '', arguments: '' };
      const call = calls[t.index]!;
      if (t.id) Object.assign(call, { id: t.id, type: t.type });
      call.name += t.function.name ?? '';
      call.arguments += t.function.arguments ?? '';
    }
    finish = choice.finish_reason ?? finish;
  }
  return { content, calls, finish, done: text.includes('[DONE]') };
}

describe('tools through each provider', () => {
  test('OpenAI: tools pass through, and the answer carries the tool call', async () => {
    const { v1 } = await world();
    const res = await v1(ask('openai/gpt-4o-mini', { tool_choice: 'required', parallel_tool_calls: false }));
    expect(res.status).toBe(200);
    expect(sent()).toMatchObject({ tools: [weather], tool_choice: 'required', parallel_tool_calls: false });
    const body = await json<Completion>(res);
    expect(body.choices[0]).toMatchObject({
      finish_reason: 'tool_calls',
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
    });
  });

  test('Anthropic: tools become input_schema; tool_use blocks become tool calls', async () => {
    const { v1 } = await world();
    const res = await v1(ask('anthropic/claude-sonnet-4-5', { tool_choice: { type: 'function', function: { name: 'get_weather' } }, parallel_tool_calls: false }));
    expect(res.status).toBe(200);
    expect(sent()).toMatchObject({
      tools: [{ name: 'get_weather', description: 'Current weather in a city', input_schema: weather.function.parameters }],
      tool_choice: { type: 'tool', name: 'get_weather', disable_parallel_tool_use: true },
    });
    expect((await json<Completion>(res)).choices[0]).toMatchObject({
      finish_reason: 'tool_calls',
      message: { content: 'Let me check.', tool_calls: [{ id: 'toolu_01', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
    });
  });

  test('Gemini: tools become function declarations; function calls become tool calls with the signature kept in the id', async () => {
    const { v1 } = await world();
    const res = await v1(ask('google/gemini-2.0-flash', { tool_choice: 'auto' }));
    expect(res.status).toBe(200);
    expect(sent()).toMatchObject({
      tools: [{ functionDeclarations: [{ name: 'get_weather', description: 'Current weather in a city', parametersJsonSchema: weather.function.parameters }] }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    });
    const call = (await json<Completion>(res)).choices[0]!;
    expect(call.finish_reason).toBe('tool_calls');
    expect(call.message.tool_calls![0]).toMatchObject({ type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } });
    expect(call.message.tool_calls![0]!.id).toMatch(/^call_[0-9a-f]{24}~c2lnbmF0dXJlLTE=$/);
  });

  test('a full round trip: the tool result goes back in each provider\'s own format', async () => {
    const { v1 } = await world();
    for (const model of ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4-5', 'google/gemini-2.0-flash']) {
      const first = await json<Completion>(await v1(ask(model)));
      const call = first.choices[0]!.message;
      const res = await v1({
        model, tools: [weather],
        messages: [
          { role: 'user', content: 'Weather in Paris?' },
          { role: 'assistant', content: call.content, tool_calls: call.tool_calls },
          { role: 'tool', tool_call_id: call.tool_calls![0]!.id, content: '{"temp_c":21,"sky":"clear"}' },
        ],
      });
      expect([model, res.status]).toEqual([model, 200]);
      const answer = await json<Completion>(res);
      expect([model, answer.choices[0]!.finish_reason]).not.toEqual([model, 'tool_calls']);
      const body = sent();
      if (model.startsWith('openai')) {
        expect(body.messages).toEqual([
          { role: 'user', content: 'Weather in Paris?' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
          { role: 'tool', tool_call_id: 'call_abc', content: '{"temp_c":21,"sky":"clear"}' },
        ]);
      } else if (model.startsWith('anthropic')) {
        expect(body.messages).toEqual([
          { role: 'user', content: 'Weather in Paris?' },
          { role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Paris' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '{"temp_c":21,"sky":"clear"}' }] },
        ]);
      } else {
        expect(body.contents).toEqual([
          { role: 'user', parts: [{ text: 'Weather in Paris?' }] },
          { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } }, thoughtSignature: 'c2lnbmF0dXJlLTE=' }] },
          { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp_c: 21, sky: 'clear' } } }] },
        ]);
      }
    }
  });

  test('several tool results in a row share one turn (Anthropic, Gemini)', async () => {
    const { v1 } = await world();
    const calls = [
      { id: 'toolu_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
      { id: 'toolu_b', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } },
    ];
    const messages = [
      { role: 'user', content: 'Paris and Oslo?' },
      { role: 'assistant', content: null, tool_calls: calls },
      { role: 'tool', tool_call_id: 'toolu_a', content: 'sunny' },
      { role: 'tool', tool_call_id: 'toolu_b', content: 'snow' },
    ];
    expect((await v1({ model: 'anthropic/claude-sonnet-4-5', tools: [weather], messages })).status).toBe(200);
    expect((sent().messages as unknown[])[2]).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_a', content: 'sunny' },
      { type: 'tool_result', tool_use_id: 'toolu_b', content: 'snow' },
    ] });
    expect((await v1({ model: 'google/gemini-2.0-flash', tools: [weather], messages })).status).toBe(200);
    expect((sent().contents as unknown[])[2]).toEqual({ role: 'user', parts: [
      { functionResponse: { name: 'get_weather', response: { content: 'sunny' } } },
      { functionResponse: { name: 'get_weather', response: { content: 'snow' } } },
    ] });
  });
});

describe('streamed tool calls', () => {
  test('each provider streams the call in OpenAI pieces: id and name first, then the arguments', async () => {
    const { v1 } = await world();
    for (const model of ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4-5', 'google/gemini-2.0-flash']) {
      const res = await v1(ask(model, { stream: true }));
      expect([model, res.status]).toEqual([model, 200]);
      const s = await readStream(res);
      expect([model, s.finish, s.done]).toEqual([model, 'tool_calls', true]);
      expect(s.calls).toHaveLength(1);
      expect(s.calls[0]).toMatchObject({ type: 'function', name: 'get_weather' });
      expect(JSON.parse(s.calls[0]!.arguments)).toEqual({ city: 'Paris' });
      expect(s.calls[0]!.id).toBeTruthy();
    }
  });
});

describe('routing and validation', () => {
  test('tools need a model marked Tool use; a clear 400 otherwise', async () => {
    const { v1 } = await world(false);
    const res = await v1(ask('openai/gpt-4o-mini'));
    expect(res.status).toBe(400);
    expect((await json<OpenAiError>(res)).error).toMatchObject({ param: 'tools', message: expect.stringContaining('supports tools') });
    // Without tools the same model answers.
    expect((await v1({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] })).status).toBe(200);
  });

  test('bad tool requests are refused with the parameter named', async () => {
    const { v1 } = await world();
    const m = 'openai/gpt-4o-mini';
    const cases: [unknown, string][] = [
      [ask(m, { tools: [] }), 'tools'],
      [ask(m, { tools: [{ type: 'retrieval' }] }), 'tools[0]'],
      [ask(m, { tools: [{ type: 'function', function: { name: 'bad name!' } }] }), 'tools[0].function.name'],
      [ask(m, { tools: [weather, weather] }), 'tools[1].function.name'],
      [ask(m, { tools: [{ type: 'function', function: { name: 'f', parameters: 'x' } }] }), 'tools[0].function.parameters'],
      [ask(m, { tool_choice: 'sometimes' }), 'tool_choice'],
      [ask(m, { tool_choice: { type: 'function', function: { name: 'other' } } }), 'tool_choice'],
      [{ model: m, messages: [{ role: 'user', content: 'x' }], tool_choice: 'auto' }, 'tool_choice'],
      [ask(m, { parallel_tool_calls: 'yes' }), 'parallel_tool_calls'],
      [ask(m, { functions: [{ name: 'f' }] }), 'functions'],
      [{ model: m, tools: [weather], messages: [{ role: 'user', content: 'x' }, { role: 'tool', tool_call_id: 'nope', content: 'r' }] }, 'messages[1].tool_call_id'],
      [{ model: m, tools: [weather], messages: [{ role: 'user', content: 'x' }, { role: 'tool', content: 'r' }] }, 'messages[1].tool_call_id'],
      [{ model: m, tools: [weather], messages: [{ role: 'user', content: 'x' }, { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'get_weather', arguments: { city: 'Paris' } } }] }] }, 'messages[1].tool_calls[0].function.arguments'],
      [{ model: m, messages: [{ role: 'user', content: 'x' }, { role: 'function', name: 'f', content: 'r' }] }, 'messages[1].role'],
    ];
    for (const [body, param] of cases) {
      const res = await v1(body);
      expect([param, res.status]).toEqual([param, 400]);
      expect((await json<OpenAiError>(res)).error.param).toBe(param);
    }
  });

  test('import pre-selects Tool use for chat models; Groq decides per model', async () => {
    const { h } = await world();
    const provider = await h.providers.create(actor, { name: 'Groq', identifier: 'groq', kind: 'groq', endpoint: `${mock.url}/groq/openai/v1`, apiKey: mock.key }, client);
    const found = await h.models.discover(provider.id);
    expect(found.find((m) => m.providerModelId === 'llama-3.3-70b-versatile')!.capabilities).toContain('TOOL_USE');
    expect(found.find((m) => m.providerModelId === 'qwen/qwen3.8-27b')!.capabilities).not.toContain('TOOL_USE');
  });
});
