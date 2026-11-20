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

// SEC-021: what the fuzzing found, each as the smallest input that showed it. These keep failing
// without the fix even if the fuzzers' random cases change. Add a case here for every new finding.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { openAiAdapter, anthropicAdapter, googleAdapter, ProviderCallError } from '@clawrouter/providers';
import type { ConfigurationDocument, RateLimitConfigView } from '@clawrouter/shared';
import type { Harness } from '../../support/harness.ts';
import { startMockProviders, type MockProviders } from '../../support/mock-providers.ts';
import { data, gatewayWorld } from '../support.ts';

const answer = (body: string, type = 'application/json') => (async () => new Response(body, { status: 200, headers: { 'content-type': type } })) as unknown as typeof fetch;
const ctx = (body: string, type?: string) => ({ endpoint: 'https://provider.test/v1', apiKey: 'k', timeoutMs: 1000, fetch: answer(body, type) });
const REQUEST = { model: 'm', messages: [{ role: 'user' as const, content: 'Hi' }] };

let mock: MockProviders;
let h: Harness;
let admin: string;
let key: string;
beforeAll(async () => {
  mock = await startMockProviders();
  ({ h, admin, key } = await gatewayWorld(mock));
});
afterAll(() => mock.stop());

describe('client requests', () => {
  // String() on an object calls its own toString: a JSON object can carry that key as data.
  test.each([
    ['/v1/chat/completions', { model: 'gpt-4o-mini', messages: [{ role: 'user', content: [{ type: { toString: 1 } }] }] }],
    ['/v1/chat/completions', { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }], response_format: { type: { valueOf: 1, toString: 1 } } }],
    ['/v1/responses', { model: 'gpt-4o-mini', input: [{ type: { toString: 1 } }] }],
    ['/v1/messages', { model: 'gpt-4o-mini', max_tokens: 5, messages: [{ role: 'user', content: [{ type: { toString: 1 } }] }] }],
    ['/v1/messages', { model: 'gpt-4o-mini', max_tokens: 5, messages: [{ role: 'user', content: 'Hi' }], tools: [{ type: { toString: [] } }] }],
  ])('a "type" object with its own toString is a 400, not a 500 (%s)', async (path, body) => {
    const res = await h.request(path, { method: 'POST', headers: { authorization: `Bearer ${key}` }, json: body });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('[object Object]');
  });
});

describe('provider answers', () => {
  test.each(['null', '[]', '"text"', '7'])('a body that is not an object (%s) is an invalid response, not a TypeError', async (body) => {
    for (const adapter of [openAiAdapter, anthropicAdapter, googleAdapter]) {
      const error = await adapter.sendRequest(ctx(body), REQUEST).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderCallError);
      expect((error as ProviderCallError).failure).toBe('invalid_response');
    }
  });

  test('negative or non-numeric token counts are "not reported" (usage drives quotas and spending)', async () => {
    const res = await openAiAdapter.sendRequest(ctx(JSON.stringify({ choices: [{ message: { content: 'Hi' } }], usage: { prompt_tokens: -1000000, completion_tokens: '5', total_tokens: 1e400 } })), REQUEST);
    expect(res.usage).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null });
    const claude = await anthropicAdapter.sendRequest(ctx(JSON.stringify({ content: [{ type: 'text', text: 'Hi' }], usage: { input_tokens: -5, output_tokens: '2' } })), REQUEST);
    expect(claude.usage).toMatchObject({ inputTokens: null, outputTokens: null });
  });

  test('text of the wrong type never becomes the answer', async () => {
    const res = await openAiAdapter.sendRequest(ctx(JSON.stringify({ model: { x: 1 }, choices: [{ message: { content: 42, tool_calls: [null, { function: { name: 7 } }] } }] })), REQUEST);
    expect([res.model, res.content, res.toolCalls]).toEqual(['m', '', undefined]);
    const gemini = await googleAdapter.sendRequest(ctx(JSON.stringify({ candidates: [{ content: { parts: { text: 'not a list' } } }] })), REQUEST);
    expect(gemini.content).toBe('');
  });

  test('a stream event that is not an object fails the stream cleanly', async () => {
    const it = openAiAdapter.sendStreamingRequest(ctx('data: null\n\n', 'text/event-stream'), REQUEST);
    const error = await (async () => { for await (const _ of it) { /* drain */ } })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderCallError);
  });

  test('model prices that overflow, or are empty text, are unknown (not infinite, not free)', async () => {
    const list = JSON.stringify({ data: [{ id: 'a', pricing: { prompt: 1.7976931348623157e308, completion: '' } }, { id: 'b', pricing: { prompt: ' ', completion: '0.000001' } }] });
    const models = await openAiAdapter.listModels(ctx(list));
    expect(models.map((m) => m.cost)).toEqual([undefined, { inputPerMTok: null, outputPerMTok: 1 }]);
  });

  test('embedding vectors must be numbers', async () => {
    const body = JSON.stringify({ data: [{ index: 0, embedding: ['0.1', { x: 1 }] }] });
    const error = await openAiAdapter.embed!(ctx(body), { model: 'e', input: ['a'] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderCallError);
  });
});

describe('streams', () => {
  // The Responses format answers an empty tool call piece with no event. A stream pull that enqueued
  // nothing was never called again: the client waited forever, past the stream time limit, and the
  // request held its concurrency slot (the next one got 429 with maxConcurrent 1).
  test('a provider piece that gives the client nothing does not stall the stream or hold its slot', async () => {
    const t = (await gatewayWorld(mock));
    const current = await data<RateLimitConfigView>(await t.h.request('/api/rate-limits', { cookie: t.admin }));
    const { unknownModels: _u, updatedAt: _a, updatedBy: _b, ...rest } = current;
    expect((await t.h.request('/api/rate-limits', { method: 'PUT', cookie: t.admin, json: { ...rest, global: { ...rest.global, maxConcurrent: 1 } } })).status).toBe(200);
    const piece = (f: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: f }] } }] })}\n\n`;
    t.h.setProviderFetch(answer(`${piece({ arguments: '{}' })}${piece({})}data: [DONE]\n\n`, 'text/event-stream'));
    const send = () => t.h.request('/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${t.key}` }, json: { model: 'gpt-4o-mini', input: 'Hi', stream: true } });
    const first = await send();
    const text = await Promise.race([first.text(), Bun.sleep(2000).then(() => 'STALLED')]);
    expect(text).toContain('response.completed');
    const second = await send();
    expect(second.status).toBe(200);
    await second.text();
  });
});

describe('configuration imports', () => {
  test('an alias without its optional fields is previewed and imported, not a 500', async () => {
    const t = h;
    const cookie = admin;
    const doc = await data<ConfigurationDocument>(await t.request('/api/configuration/export', { cookie }));
    const withAlias = { ...doc, routing: { ...doc.routing, aliases: [{ name: 'bare', targets: [{ modelRef: 'openai/gpt-4o-mini', priority: 0, weight: 1 }] }] } };
    expect((await t.request('/api/configuration/import/preview', { method: 'POST', cookie, json: withAlias })).status).toBe(200);
    expect((await t.request('/api/configuration/import', { method: 'POST', cookie, json: withAlias })).status).toBe(200);
    const alias = (await data<{ aliases: { name: string; description: string; enabled: boolean; capabilities: string[]; policy: unknown }[] }>(await t.request('/api/routing', { cookie }))).aliases[0];
    expect(alias).toMatchObject({ name: 'bare', description: '', enabled: true, capabilities: [], policy: null });
  });
});
