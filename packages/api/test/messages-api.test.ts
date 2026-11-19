import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ApiSuccess, CreatedApiKey, ProviderInfo, RequestRecord } from '@clawrouter/shared';
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
  mock.requests.length = 0;
});

const actor = { id: 'u', username: 'admin' };
const client = { ip: null };
const json = async <T>(res: Response) => (await res.json()) as T;

type Message = {
  id: string; type: string; role: string; model: string; stop_reason: string; stop_sequence: null;
  content: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> })[];
  usage: { input_tokens: number; output_tokens: number };
};
type AnthropicError = { type: 'error'; error: { type: string; message: string }; request_id: string };

async function world() {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const openai: ProviderInfo = await h.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key }, client);
  h.models.create(actor, { providerId: openai.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT', 'TOOL_USE', 'VISION'] }, client);
  const res = await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'claude-code' } });
  const key = (await json<ApiSuccess<CreatedApiKey>>(res)).data;
  return { h, admin, key: key.secret, keyId: key.key.id };
}

/** As Anthropic's SDKs send it: the key in x-api-key, plus anthropic-version. */
const messages = (h: Harness, key: string | null, body: unknown, path = '/v1/messages') =>
  h.request(path, { method: 'POST', json: body, headers: { ...(key ? { 'x-api-key': key } : {}), 'anthropic-version': '2023-06-01' } });
const hello = (extra: Record<string, unknown> = {}) => ({ model: 'openai/gpt-4o-mini', max_tokens: 1024, messages: [{ role: 'user', content: 'Hi' }], ...extra });
const weather = { name: 'get_weather', description: 'Weather for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
const lastProviderBody = () => mock.requests.filter((r) => r.path.endsWith('/chat/completions')).at(-1)!.body as { messages: Record<string, unknown>[]; tools?: unknown[]; max_tokens?: number; max_completion_tokens?: number; stop?: string[]; tool_choice?: unknown };

/** Reads a Messages stream into its events. */
async function events(res: Response): Promise<{ event: string; data: Record<string, unknown> }[]> {
  return (await res.text()).split('\n\n').filter(Boolean).map((block) => {
    const [eventLine, dataLine] = block.split('\n');
    return { event: eventLine!.slice(7), data: JSON.parse(dataLine!.slice(6)) as Record<string, unknown> };
  });
}

describe('POST /v1/messages (Anthropic Messages API)', () => {
  test('a message in Anthropic\'s shape, from a provider that is not Anthropic, recorded as /v1/messages', async () => {
    const { h, admin, keyId, key } = await world();
    const res = await messages(h, key, hello({ system: [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }] }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-clawrouter-model')).toBe('openai/gpt-4o-mini');
    const body = await json<Message>(res);
    expect(body).toMatchObject({
      type: 'message', role: 'assistant', model: 'openai/gpt-4o-mini', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: 'Hello from OpenAI' }], usage: { input_tokens: 7, output_tokens: 4 },
    });
    expect(body.id).toStartWith('msg_');
    // The provider got an OpenAI request: system first, max_tokens carried over.
    const sent = lastProviderBody();
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'Be brief.' });
    expect(sent.max_completion_tokens ?? sent.max_tokens).toBe(1024);
    const history = (await json<ApiSuccess<RequestRecord[]>>(await h.request('/api/requests', { cookie: admin }))).data;
    expect(history[0]).toMatchObject({ endpoint: 'messages', status: 'COMPLETED', stream: false, apiKey: { id: keyId } });
  });

  test('Authorization: Bearer works too (Claude Code with ANTHROPIC_AUTH_TOKEN)', async () => {
    const { h, key } = await world();
    const res = await h.request('/v1/messages', { method: 'POST', json: hello(), headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(200);
  });

  test('errors in Anthropic\'s shape: no key, a missing max_tokens, an unknown model', async () => {
    const { h, key } = await world();
    const anonymous = await messages(h, null, hello());
    expect(anonymous.status).toBe(401);
    const a = await json<AnthropicError>(anonymous);
    expect(a.type).toBe('error');
    expect(a.error.type).toBe('authentication_error');
    expect(anonymous.headers.get('request-id')).toBe(a.request_id);

    const noMax = await messages(h, key, { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] });
    expect(noMax.status).toBe(400);
    expect((await json<AnthropicError>(noMax)).error).toEqual({ type: 'invalid_request_error', message: "'max_tokens' is required." });

    const unknown = await messages(h, key, hello({ model: 'claude-sonnet-4-5' }));
    expect(unknown.status).toBe(404);
    expect((await json<AnthropicError>(unknown)).error.type).toBe('not_found_error');
  });

  test('every provider rate limiting: rate_limit_error with Retry-After', async () => {
    const { h, key } = await world();
    mock.mode = 'rate_limited';
    const res = await messages(h, key, hello());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect((await json<AnthropicError>(res)).error.type).toBe('rate_limit_error');
  });

  test('content blocks: images, PDF and text documents reach the provider; thinking settings are accepted and ignored', async () => {
    const { h, key } = await world();
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await messages(h, key, hello({
      thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, metadata: { user_id: 'u1' }, top_k: 5,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
          { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Notes body' }, title: 'Notes' },
          { type: 'text', text: 'What is this?' },
        ],
      }],
    }));
    expect(res.status).toBe(200);
    const sent = lastProviderBody().messages[0] as { role: string; content: { type: string; text?: string; image_url?: { url: string } }[] };
    expect(sent.role).toBe('user');
    expect(sent.content.map((p) => p.type)).toEqual(['image_url', 'text', 'text']);
    expect(sent.content[0]!.image_url!.url).toBe(`data:image/png;base64,${png}`);
    expect(sent.content[1]!.text).toBe('Notes\n\nNotes body');
  });

  test('tool use round trip: tool_use out, tool_result back (thinking blocks in history are dropped)', async () => {
    const { h, key } = await world();
    const first = await messages(h, key, hello({ tools: [weather], tool_choice: { type: 'auto', disable_parallel_tool_use: true }, messages: [{ role: 'user', content: 'Weather in Paris?' }] }));
    expect(first.status).toBe(200);
    const call = await json<Message>(first);
    expect(call.stop_reason).toBe('tool_use');
    expect(call.content).toEqual([{ type: 'tool_use', id: 'call_abc', name: 'get_weather', input: { city: 'Paris' } }]);
    // The provider got an OpenAI function tool.
    const offered = lastProviderBody();
    expect(offered.tools).toEqual([{ type: 'function', function: { name: 'get_weather', description: 'Weather for a city', parameters: weather.input_schema } }]);

    const second = await messages(h, key, hello({
      tools: [weather],
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'Use the tool.', signature: 'sig' }, { type: 'text', text: 'Checking.' }, ...call.content] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_abc', content: [{ type: 'text', text: '18°C, sunny' }] }, { type: 'text', text: 'Thanks' }] },
      ],
    }));
    expect(second.status).toBe(200);
    expect((await json<Message>(second)).content).toEqual([{ type: 'text', text: 'Hello from OpenAI' }]);
    const sent = lastProviderBody().messages;
    expect(sent[1]).toEqual({ role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] });
    expect(sent[2]).toEqual({ role: 'tool', tool_call_id: 'call_abc', content: '18°C, sunny' });
    expect(sent[3]).toEqual({ role: 'user', content: 'Thanks' });
  });

  test('a tool_result that answers no tool_use, and a server tool, are refused in Messages terms', async () => {
    const { h, key } = await world();
    const orphan = await messages(h, key, hello({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'x' }] }, { role: 'user', content: 'Hi' }] }));
    expect(orphan.status).toBe(400);
    expect((await json<AnthropicError>(orphan)).error.message).toContain('This tool_result answers no tool_use');

    const server = await messages(h, key, hello({ tools: [{ type: 'web_search_20260209', name: 'web_search' }] }));
    expect(server.status).toBe(400);
    expect((await json<AnthropicError>(server)).error.message).toContain("The server tool 'web_search_20260209' runs on Anthropic's servers");
  });

  test('streams text as Anthropic events, recorded as a stream', async () => {
    const { h, admin, key } = await world();
    const res = await messages(h, key, hello({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const evs = await events(res);
    expect(evs.map((e) => e.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    for (const e of evs) expect(e.data.type).toBe(e.event);
    expect((evs[0]!.data.message as Message).usage.input_tokens).toBeGreaterThan(0);
    expect(evs.filter((e) => e.event === 'content_block_delta').map((e) => (e.data.delta as { text: string }).text).join('')).toBe('Hello');
    expect(evs[5]!.data).toMatchObject({ delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2, input_tokens: 7 } });
    const history = (await json<ApiSuccess<RequestRecord[]>>(await h.request('/api/requests', { cookie: admin }))).data;
    expect(history[0]).toMatchObject({ endpoint: 'messages', stream: true, status: 'COMPLETED' });
  });

  test('streams a tool call as a tool_use block with input_json_delta', async () => {
    const { h, key } = await world();
    const evs = await events(await messages(h, key, hello({ stream: true, tools: [weather] })));
    expect(evs.map((e) => e.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(evs[1]!.data.content_block).toEqual({ type: 'tool_use', id: 'call_abc', name: 'get_weather', input: {} });
    expect(evs.filter((e) => e.event === 'content_block_delta').map((e) => (e.data.delta as { type: string; partial_json: string })).map((d) => `${d.type}:${d.partial_json}`)).toEqual(['input_json_delta:{"city":', 'input_json_delta:"Paris"}']);
    expect((evs[5]!.data.delta as { stop_reason: string }).stop_reason).toBe('tool_use');
  });

  test('a stream that breaks ends with an Anthropic error event', async () => {
    const { h, key } = await world();
    mock.streamBreak = true;
    const evs = await events(await messages(h, key, hello({ stream: true })));
    expect(evs.at(-1)).toEqual({ event: 'error', data: { type: 'error', error: { type: 'api_error', message: 'The model provider failed while streaming the response.' } } });
  });
});

describe('POST /v1/messages/count_tokens', () => {
  test('an estimate, with the same checks as a request, and nothing sent to a provider', async () => {
    const { h, admin, key } = await world();
    const res = await messages(h, key, { model: 'openai/gpt-4o-mini', system: 'Be brief.', tools: [weather], messages: [{ role: 'user', content: 'How warm is it in Paris today?' }] }, '/v1/messages/count_tokens');
    expect(res.status).toBe(200);
    const { input_tokens } = await json<{ input_tokens: number }>(res);
    expect(input_tokens).toBeGreaterThan(30);
    expect(mock.requests).toHaveLength(0);
    expect((await json<ApiSuccess<RequestRecord[]>>(await h.request('/api/requests', { cookie: admin }))).data).toHaveLength(0);
    const unknown = await messages(h, key, { model: 'nope', messages: [{ role: 'user', content: 'Hi' }] }, '/v1/messages/count_tokens');
    expect(unknown.status).toBe(404);
    expect((await json<AnthropicError>(unknown)).error.type).toBe('not_found_error');
  });
});

describe('GET /v1/models for Anthropic clients', () => {
  test("Anthropic's list shape when anthropic-version is sent, OpenAI's otherwise", async () => {
    const { h, key } = await world();
    const anthropic = await json<{ data: { type: string; id: string; display_name: string; created_at: string }[]; has_more: boolean; first_id: string }>(
      await h.request('/v1/models', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }),
    );
    expect(anthropic.has_more).toBe(false);
    expect(anthropic.data[0]).toMatchObject({ type: 'model', id: 'openai/gpt-4o-mini', display_name: 'openai/gpt-4o-mini' });
    expect(Date.parse(anthropic.data[0]!.created_at)).toBeGreaterThan(0);
    expect(anthropic.first_id).toBe('openai/gpt-4o-mini');
    const openai = await json<{ object: string }>(await h.request('/v1/models', { headers: { authorization: `Bearer ${key}` } }));
    expect(openai.object).toBe('list');
  });
});
