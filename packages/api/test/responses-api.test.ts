/*
 * ClawRouter - Self-hosted AI gateway and control platform
 * https://github.com/iant89/ClawRouter
 *
 * Copyright (C) 2026 Ian Thomas
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * in the LICENSE file for more details.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ApiSuccess, Capability, CreatedApiKey, ProviderKind, RequestDetail } from '@clawrouter/shared';
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
type Item = { type: string; id: string; status: string; role?: string; content?: { type: string; text: string; [k: string]: unknown }[]; call_id?: string; name?: string; arguments?: string };
type ResponseObject = {
  id: string; object: string; status: string; model: string; output: Item[]; store: boolean; instructions: string | null;
  incomplete_details: { reason: string } | null; usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
};
const json = async <T>(res: Response) => (await res.json()) as T;

const weather = { type: 'function', name: 'get_weather', description: 'Current weather in a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };

async function world() {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const caps: Capability[] = ['CHAT', 'TOOL_USE', 'VISION'];
  const add = async (identifier: string, kind: ProviderKind, path: string, model: string, priority: number) => {
    const p = await h.providers.create(actor, { name: identifier, identifier, kind, endpoint: `${mock.url}${path}`, apiKey: mock.key, priority }, client);
    h.models.create(actor, { providerId: p.id, providerModelId: model, capabilities: caps }, client);
  };
  await add('openai', 'openai', '/openai/v1', 'gpt-4o-mini', 10);
  await add('anthropic', 'anthropic', '/anthropic', 'claude-sonnet-4-5', 20);
  const res = await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'ci' } });
  const key = ((await res.json()) as ApiSuccess<CreatedApiKey>).data.secret;
  const responses = (body: unknown) => h.request('/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${key}` }, json: body });
  return { h, admin, responses };
}

const sent = () => mock.requests.filter((r) => r.method === 'POST').at(-1)!.body as Record<string, unknown>;

/** Reads a Responses stream: the events in order, with their data. */
async function events(res: Response) {
  const text = await res.text();
  return text.split('\n\n').filter((b) => b.startsWith('event: ')).map((b) => {
    const [head, data] = b.split('\n');
    return { event: head!.slice(7), data: JSON.parse(data!.slice(6)) as Record<string, unknown> & { type: string; sequence_number: number } };
  });
}

describe('POST /v1/responses', () => {
  test('text input gives a response object with a message item and usage', async () => {
    const { responses } = await world();
    const res = await responses({ model: 'openai/gpt-4o-mini', input: 'Hi', instructions: 'Be brief.', max_output_tokens: 50, metadata: { team: 'ops' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-clawrouter-model')).toBe('openai/gpt-4o-mini');
    const r = await json<ResponseObject & { metadata: unknown; max_output_tokens: number }>(res);
    expect(r).toMatchObject({
      object: 'response', status: 'completed', model: 'openai/gpt-4o-mini', store: false, instructions: 'Be brief.', max_output_tokens: 50, metadata: { team: 'ops' },
      incomplete_details: null, usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 },
    });
    expect(r.id).toMatch(/^resp_/);
    expect(r.output).toEqual([{ type: 'message', id: expect.stringMatching(/^msg_/), status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Hello from OpenAI', annotations: [], logprobs: [] }] }]);
    expect(sent()).toMatchObject({ messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }], max_completion_tokens: 50 });
  });

  test('message items with input parts and assistant history reach the provider as chat messages', async () => {
    const { responses } = await world();
    const res = await responses({
      model: 'anthropic/claude-sonnet-4-5',
      input: [
        { role: 'developer', content: 'Answer in French.' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Bonjour' }] },
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { role: 'user', content: [{ type: 'input_text', text: 'What is this?' }, { type: 'input_image', image_url: 'https://example.com/cat.png', detail: 'low' }] },
      ],
    });
    expect(res.status).toBe(200);
    expect(sent()).toMatchObject({
      system: 'Answer in French.',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Bonjour' },
        { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } }] },
      ],
    });
  });

  test('function tools: a call comes back as a function_call item; the output goes back as a tool result', async () => {
    const { responses } = await world();
    const first = await json<ResponseObject>(await responses({ model: 'openai/gpt-4o-mini', input: 'Weather in Paris?', tools: [weather], tool_choice: { type: 'function', name: 'get_weather' } }));
    expect(sent()).toMatchObject({
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Current weather in a city', parameters: weather.parameters } }],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    });
    expect(first.output).toEqual([{ type: 'function_call', id: expect.stringMatching(/^fc_/), call_id: 'call_abc', name: 'get_weather', arguments: '{"city":"Paris"}', status: 'completed' }]);

    const call = first.output[0]!;
    const second = await responses({
      model: 'openai/gpt-4o-mini', tools: [weather],
      input: [
        { role: 'user', content: 'Weather in Paris?' },
        { type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments },
        { type: 'function_call_output', call_id: call.call_id, output: '{"temp_c":21}' },
      ],
    });
    expect(second.status).toBe(200);
    expect(sent().messages).toEqual([
      { role: 'user', content: 'Weather in Paris?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'call_abc', content: '{"temp_c":21}' },
    ]);
    expect((await json<ResponseObject>(second)).output[0]).toMatchObject({ type: 'message', content: [{ text: 'Hello from OpenAI' }] });
  });

  test('streamed text: created, item and part added, deltas, done events, then response.completed', async () => {
    const { responses } = await world();
    const res = await responses({ model: 'openai/gpt-4o-mini', input: 'Hi', stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const ev = await events(res);
    expect(ev.map((e) => e.event)).toEqual([
      'response.created', 'response.in_progress',
      'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.delta',
      'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed',
    ]);
    expect(ev.every((e) => e.event === e.data.type)).toBe(true);
    expect(ev.map((e) => e.data.sequence_number)).toEqual(ev.map((_, i) => i));
    expect(ev.find((e) => e.event === 'response.output_text.done')!.data.text).toBe('Hello');
    const done = ev.at(-1)!.data.response as ResponseObject;
    expect(done).toMatchObject({ status: 'completed', usage: { input_tokens: 7, output_tokens: 2 } });
    expect(done.output[0]).toMatchObject({ type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Hello' }] });
  });

  test('streamed tool calls: function_call item, argument deltas, done; text before it is closed first', async () => {
    const { responses } = await world();
    const ev = await events(await responses({ model: 'anthropic/claude-sonnet-4-5', input: 'Weather in Paris?', tools: [weather], stream: true }));
    const types = ev.map((e) => e.event);
    expect(types).toEqual([
      'response.created', 'response.in_progress',
      'response.output_item.added', 'response.content_part.added', 'response.output_text.delta',
      'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
      'response.output_item.added', 'response.function_call_arguments.delta', 'response.function_call_arguments.delta',
      'response.function_call_arguments.done', 'response.output_item.done', 'response.completed',
    ]);
    const added = ev[8]!.data as unknown as { output_index: number; item: Item };
    expect(added).toMatchObject({ output_index: 1, item: { type: 'function_call', call_id: 'toolu_01', name: 'get_weather', arguments: '', status: 'in_progress' } });
    const final = ev.at(-1)!.data.response as ResponseObject;
    expect(final.output.map((i) => i.type)).toEqual(['message', 'function_call']);
    expect(JSON.parse(final.output[1]!.arguments!)).toEqual({ city: 'Paris' });
  });

  test('an answer cut by the length limit is incomplete', async () => {
    const { responses } = await world();
    // The fake Anthropic stream stops with max_tokens.
    const ev = await events(await responses({ model: 'anthropic/claude-sonnet-4-5', input: 'Hi', stream: true }));
    expect(ev.at(-1)).toMatchObject({ event: 'response.incomplete', data: { response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } } });
  });

  test('requests are recorded under the responses endpoint', async () => {
    const { h, admin, responses } = await world();
    const res = await responses({ model: 'openai/gpt-4o-mini', input: 'Hi' });
    const detail = await json<ApiSuccess<RequestDetail>>(await h.request(`/api/requests/${res.headers.get('x-request-id')}`, { cookie: admin }));
    expect(detail.data).toMatchObject({ endpoint: 'responses', status: 'COMPLETED', modelRef: 'openai/gpt-4o-mini' });
  });

  test('what needs stored state or OpenAI\'s servers is refused with the parameter named', async () => {
    const { responses } = await world();
    const m = 'openai/gpt-4o-mini';
    const cases: [unknown, string][] = [
      [{ model: m, input: 'x', previous_response_id: 'resp_1' }, 'previous_response_id'],
      [{ model: m, input: 'x', conversation: 'conv_1' }, 'conversation'],
      [{ model: m, input: [{ type: 'item_reference', id: 'msg_1' }] }, 'input[0]'],
      [{ model: m, input: 'x', tools: [{ type: 'web_search' }] }, 'tools[0].type'],
      [{ model: m, input: 'x', text: { format: { type: 'json_schema', name: 'x', schema: {} } } }, 'text.format'],
      [{ model: m, input: [] }, 'input'],
      [{ model: m, input: 'x', max_output_tokens: 0 }, 'max_output_tokens'],
      [{ model: m, input: [{ role: 'user', content: 'x' }, { type: 'function_call_output', call_id: 'nope', output: 'r' }] }, 'input[1].call_id'],
      [{ model: m, input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file_1' }] }] }, 'input[0].content[0].file_id'],
      [{ model: m, input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'ftp://x/y.png' }] }] }, 'input[0].content[0].url'],
      [{ model: m, input: 'x', tools: [{ type: 'function', name: 'bad name!' }] }, 'tools[0].name'],
    ];
    for (const [body, param] of cases) {
      const res = await responses(body);
      expect([param, res.status]).toEqual([param, 400]);
      expect((await json<OpenAiError>(res)).error.param).toBe(param);
    }
  });
});

describe('routing refusals in Responses terms', () => {
  test('a PDF no model accepts is refused naming input, not messages', async () => {
    const { responses } = await world();
    const res = await responses({ model: 'openai/gpt-4o-mini', input: [{ role: 'user', content: [{ type: 'input_file', file_data: 'data:application/pdf;base64,JVBERi0xLjQK', filename: 'a.pdf' }] }] });
    // OpenAI takes PDFs: allowed.
    expect(res.status).toBe(200);
    expect((sent().messages as { content: unknown }[])[0]!.content).toEqual([{ type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,JVBERi0xLjQK' } }]);
    const audio = await responses({ model: 'anthropic/claude-sonnet-4-5', input: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'UklGRiQAAABXQVZF', format: 'wav' } }] }] });
    expect(audio.status).toBe(400);
    expect((await json<OpenAiError>(audio)).error).toMatchObject({ param: 'input', message: expect.stringContaining('accepts audio') });
  });
});
