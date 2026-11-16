import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ApiSuccess, CreatedApiKey, DiscoveredModelInfo, ProviderInfo } from '@clawrouter/shared';
import { createHarness } from '../../../tests/support/harness.ts';

/**
 * A fake of Google's OpenAI-compatible endpoint, shaped like the live answers of
 * 2026-11-16: `models/` ids with `display_name`, thought signatures in
 * `extra_content` on tool calls, streams that end tool calls with "stop", and
 * errors wrapped in a list.
 */
const SIG = 'Et4CCtsCAWkUfRNVmSj3d3B2Z7e8MVWT+/sig==';
const seen: Record<string, unknown>[] = [];
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/v1beta/openai/models') {
        return Response.json({ object: 'list', data: [
          { id: 'models/gemini-3.5-flash', object: 'model', owned_by: 'google', display_name: 'Gemini 3.5 Flash' },
          { id: 'models/gemini-2.5-flash', object: 'model', owned_by: 'google', display_name: 'Gemini 2.5 Flash' },
        ] });
      }
      const body = (await req.json()) as { model: string; stream?: boolean; messages: { role: string }[]; tools?: unknown[] };
      seen.push(body);
      if (body.model === 'gemini-2.5-flash') {
        return Response.json([{ error: { code: 404, message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash.', status: 'NOT_FOUND' } }], { status: 404 });
      }
      const answered = body.messages.some((m) => m.role === 'tool');
      const call = { extra_content: { google: { thought_signature: SIG } }, function: { arguments: '{"city":"Oslo"}', name: 'get_weather' }, id: 'call_2125615609808974611', type: 'function' };
      if (body.tools && !answered && !body.stream) {
        return Response.json({ choices: [{ finish_reason: 'tool_calls', index: 0, message: { role: 'assistant', tool_calls: [call] } }], model: body.model, object: 'chat.completion', usage: { completion_tokens: 17, prompt_tokens: 41, total_tokens: 58 } });
      }
      if (body.tools && !answered) {
        const lines = [
          { choices: [{ delta: { role: 'assistant', tool_calls: [{ ...call, index: 0 }] }, index: 0 }] },
          { choices: [{ delta: { role: 'assistant' }, finish_reason: 'stop', index: 0 }] },
        ].map((d) => `data: ${JSON.stringify(d)}\n\n`).join('') + 'data: [DONE]\n\n';
        return new Response(lines, { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({ choices: [{ finish_reason: 'stop', index: 0, message: { role: 'assistant', content: 'It is 4 °C in Oslo.' } }], model: body.model, object: 'chat.completion', usage: { completion_tokens: 9, prompt_tokens: 60, total_tokens: 69 } });
    },
  });
});
afterAll(() => server.stop(true));

const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;
const weather = { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } };

async function world() {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const p = await data<ProviderInfo>(await h.request('/api/providers', { method: 'POST', cookie: admin, json: { name: 'Gemini', identifier: 'gemini', kind: 'openai_compatible', endpoint: `http://127.0.0.1:${server.port}/v1beta/openai`, apiKey: 'key-0123456789' } }));
  await h.request(`/api/providers/${p.id}/models/import`, { method: 'POST', cookie: admin, json: { providerModelIds: ['gemini-3.5-flash', 'gemini-2.5-flash'] } });
  for (const m of h.models.listAll()) await h.request(`/api/models/${m.id}`, { method: 'PATCH', cookie: admin, json: { capabilities: ['CHAT', 'TOOL_USE'] } });
  const key = (await data<CreatedApiKey>(await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'ci' } }))).secret;
  const chat = (body: unknown) => h.request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, json: body });
  return { h, admin, p, chat };
}

describe('Google through its OpenAI-compatible endpoint', () => {
  test('discovery drops the models/ prefix and uses display_name', async () => {
    const { h, admin, p } = await world();
    const found = await data<DiscoveredModelInfo[]>(await h.request(`/api/providers/${p.id}/models/discover`, { cookie: admin }));
    expect(found.map((m) => [m.providerModelId, m.displayName])).toEqual([['gemini-2.5-flash', 'Gemini 2.5 Flash'], ['gemini-3.5-flash', 'Gemini 3.5 Flash']]);
  });

  test('the thought signature travels in the tool call id and goes back in extra_content', async () => {
    const { chat } = await world();
    const user = { role: 'user', content: 'Weather in Oslo?' };
    const first = (await (await chat({ model: 'gemini/gemini-3.5-flash', messages: [user], tools: [weather] })).json()) as { choices: { message: { tool_calls: { id: string; function: { name: string; arguments: string } }[] } }[] };
    const call = first.choices[0]!.message.tool_calls[0]!;
    expect(call.id).toBe(`call_2125615609808974611~${SIG}`);
    expect(call.function).toEqual({ name: 'get_weather', arguments: '{"city":"Oslo"}' });

    const res = await chat({ model: 'gemini/gemini-3.5-flash', tools: [weather], messages: [user, { role: 'assistant', content: null, tool_calls: [{ ...call, type: 'function' }] }, { role: 'tool', tool_call_id: call.id, content: '{"temp_c":4}' }] });
    expect(res.status).toBe(200);
    const sent = seen.at(-1) as { messages: unknown[] };
    expect(sent.messages[1]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'call_2125615609808974611', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' }, extra_content: { google: { thought_signature: SIG } } }] });
    expect(sent.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_2125615609808974611', content: '{"temp_c":4}' });
  });

  test('a streamed tool call carries the signature, and the stream ends with tool_calls, not stop', async () => {
    const { chat } = await world();
    const text = await (await chat({ model: 'gemini/gemini-3.5-flash', messages: [{ role: 'user', content: 'Weather in Oslo?' }], tools: [weather], stream: true })).text();
    const chunks = text.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)) as { choices: { delta: { tool_calls?: { id?: string }[] }; finish_reason: string | null }[] });
    expect(chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []).find((t) => t.id)?.id).toBe(`call_2125615609808974611~${SIG}`);
    expect(chunks.map((c) => c.choices[0]?.finish_reason).filter(Boolean)).toEqual(['tool_calls']);
  });

  test('a retired model: the error says what the provider said, unwrapped from Google\'s list', async () => {
    const { chat } = await world();
    const res = await chat({ model: 'gemini/gemini-2.5-flash', messages: [{ role: 'user', content: 'Hi' }] });
    expect(res.status).toBe(502);
    const message = ((await res.json()) as { error: { message: string } }).error.message;
    expect(message).toContain('last error: not_found). The provider said: This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash.');
    expect(message).not.toContain('[{');
  });
});
