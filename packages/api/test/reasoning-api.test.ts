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
import type { ApiSuccess, CreatedApiKey, ProviderInfo } from '@clawrouter/shared';
import { createHarness } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

/**
 * Reasoning that a provider sends apart from the answer reaches the client in each
 * API's own shape: `reasoning_content` in Chat Completions, a `reasoning` item in
 * Responses, a `thinking` block in Messages. It never becomes part of the answer.
 */

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
const json = async <T>(res: Response) => (await res.json()) as T;
const MODEL = 'openai/deepseek-reasoner';
const REASONING = 'The capital of France is Paris.';

async function world() {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const openai: ProviderInfo = await h.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key }, { ip: null });
  h.models.create(actor, { providerId: openai.id, providerModelId: 'deepseek-reasoner', capabilities: ['CHAT', 'REASONING'] }, { ip: null });
  h.models.create(actor, { providerId: openai.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'] }, { ip: null });
  const key = (await json<ApiSuccess<CreatedApiKey>>(await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'apps' } }))).data.secret;
  const post = (path: string, body: unknown) => h.request(path, { method: 'POST', json: body, headers: { authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' } });
  return { h, admin, post };
}

/** The `data:` payloads of an event stream (`[DONE]` left out). */
const payloads = async (res: Response) => (await res.text()).split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]').map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);

describe('reasoning is passed on to clients', () => {
  test('Chat Completions: reasoning_content beside the answer, in replies and stream deltas', async () => {
    const { post } = await world();
    const reply = await json<{ choices: { message: Record<string, unknown> }[] }>(await post('/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'Capital of France?' }] }));
    expect(reply.choices[0]!.message).toEqual({ role: 'assistant', content: 'Paris.', reasoning_content: REASONING });

    const chunks = await payloads(await post('/v1/chat/completions', { model: MODEL, stream: true, messages: [{ role: 'user', content: 'Capital of France?' }] }));
    const deltas = chunks.map((c) => (c.choices as { delta: Record<string, string> }[])[0]?.delta ?? {});
    expect(deltas.map((d) => d.reasoning_content ?? '').join('')).toBe('The capital is Paris.');
    expect(deltas.map((d) => d.content ?? '').join('')).toBe('Paris.');
    // Reasoning comes before the answer, as the provider sent it.
    expect(deltas.findIndex((d) => d.reasoning_content)).toBeLessThan(deltas.findIndex((d) => d.content));
  });

  test('a reply without reasoning has no reasoning_content field', async () => {
    const { post } = await world();
    const reply = await json<{ choices: { message: Record<string, unknown> }[] }>(await post('/v1/chat/completions', { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] }));
    expect(reply.choices[0]!.message).toEqual({ role: 'assistant', content: 'Hello from OpenAI' });
  });

  test('reasoning sent back in the conversation never reaches the provider (DeepSeek refuses it)', async () => {
    const { post } = await world();
    await post('/v1/chat/completions', {
      model: MODEL,
      messages: [{ role: 'user', content: 'Capital of France?' }, { role: 'assistant', content: 'Paris.', reasoning_content: REASONING }, { role: 'user', content: 'And Spain?' }],
    });
    const sent = mock.requests.at(-1)!.body as { messages: Record<string, unknown>[] };
    expect(sent.messages[1]).toEqual({ role: 'assistant', content: 'Paris.' });
  });

  test('Responses: a reasoning item with reasoning_text before the message; streamed as reasoning_text events', async () => {
    const { post } = await world();
    const reply = await json<{ output: Record<string, unknown>[] }>(await post('/v1/responses', { model: MODEL, input: 'Capital of France?' }));
    expect(reply.output.map((o) => o.type)).toEqual(['reasoning', 'message']);
    expect(reply.output[0]).toMatchObject({ type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: REASONING }] });
    expect(reply.output[1]!.id).not.toBe(reply.output[0]!.id);

    const events = await payloads(await post('/v1/responses', { model: MODEL, input: 'Capital of France?', stream: true }));
    const types = events.map((e) => e.type);
    expect(events.filter((e) => e.type === 'response.reasoning_text.delta').map((e) => e.delta).join('')).toBe('The capital is Paris.');
    expect(types.indexOf('response.reasoning_text.done')).toBeLessThan(types.indexOf('response.output_text.delta'));
    const done = events.find((e) => e.type === 'response.completed')!.response as { output: Record<string, unknown>[] };
    expect(done.output.map((o) => o.type)).toEqual(['reasoning', 'message']);
    expect(done.output[0]).toMatchObject({ status: 'completed', content: [{ type: 'reasoning_text', text: 'The capital is Paris.' }] });
    // A reasoning item sent back as input is skipped, as before.
    const again = await post('/v1/responses', { model: MODEL, input: [{ role: 'user', content: 'Capital of France?' }, done.output[0], done.output[1], { role: 'user', content: 'And Spain?' }] });
    expect(again.status).toBe(200);
  });

  test('Messages: a thinking block before the text, in replies and streams', async () => {
    const { post } = await world();
    const reply = await json<{ content: Record<string, unknown>[] }>(await post('/v1/messages', { model: MODEL, max_tokens: 1024, messages: [{ role: 'user', content: 'Capital of France?' }] }));
    expect(reply.content).toEqual([{ type: 'thinking', thinking: REASONING, signature: '' }, { type: 'text', text: 'Paris.' }]);

    const events = await payloads(await post('/v1/messages', { model: MODEL, max_tokens: 1024, stream: true, messages: [{ role: 'user', content: 'Capital of France?' }] }));
    const starts = events.filter((e) => e.type === 'content_block_start').map((e) => [e.index, (e.content_block as { type: string }).type]);
    expect(starts).toEqual([[0, 'thinking'], [1, 'text']]);
    const deltas = events.filter((e) => e.type === 'content_block_delta').map((e) => e.delta as Record<string, string>);
    expect(deltas.filter((d) => d.type === 'thinking_delta').map((d) => d.thinking).join('')).toBe('The capital is Paris.');
    expect(deltas.filter((d) => d.type === 'text_delta').map((d) => d.text).join('')).toBe('Paris.');
    // Each block is closed before the next starts.
    expect(events.filter((e) => e.type === 'content_block_stop').map((e) => e.index)).toEqual([0, 1]);
  });
});
