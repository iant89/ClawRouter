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

// SEC-021: request validation. The three chat front ends (Chat Completions, Responses,
// Messages) and embeddings parse untrusted bodies. Valid requests with a few things changed
// must be refused with a 400 naming the problem, or accepted as a request whose every field
// has the type the rest of the gateway relies on. Then the same bodies go through the whole
// HTTP pipeline to the mock provider: never a 500, never a crash in a provider adapter.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parseChatRequest, parseEmbeddingRequest, type ParsedChatRequest } from '@clawrouter/gateway';
import { parseMessagesRequest } from '../../../packages/gateway/src/messages.ts';
import { parseResponsesRequest } from '../../../packages/gateway/src/responses.ts';
import type { Harness } from '../../support/harness.ts';
import { startMockProviders, type MockProviders } from '../../support/mock-providers.ts';
import { createHarness, gatewayWorld } from '../support.ts';
import { anyString, expectClientError, expectHandledResponse, forAll, mutate } from './fuzz.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const WAV = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const PDF = 'JVBERi0xLjQKJcOkw7zDtsOfCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nPj4KZW5kb2JqCnRyYWlsZXIKPDwvUm9vdCAxIDAgUj4+CiUlRU9G';
const TOOL = { type: 'function', function: { name: 'weather', description: 'The weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } };

/** Valid requests using most of each API, the starting points for mutation. */
export const CHAT_SEEDS: unknown[] = [
  { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] },
  {
    model: 'gpt-4o-mini', max_tokens: 50, temperature: 0.7, top_p: 0.9, stop: ['END', '\n\n'], stream: false, n: 1,
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'developer', content: [{ type: 'text', text: 'Really brief.' }] },
      { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}`, detail: 'low' } }, { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Oslo"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'Sunny' },
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data: WAV, format: 'wav' } }, { type: 'file', file: { filename: 'a.pdf', file_data: `data:application/pdf;base64,${PDF}` } }] },
    ],
    tools: [TOOL], tool_choice: { type: 'function', function: { name: 'weather' } }, parallel_tool_calls: true,
  },
  { model: 'gpt-4o-mini', stream: true, stream_options: { include_usage: true }, max_completion_tokens: 10, response_format: { type: 'text' }, messages: [{ role: 'user', content: 'Stream' }], tools: [TOOL], tool_choice: 'auto' },
];

export const RESPONSES_SEEDS: unknown[] = [
  { model: 'gpt-4o-mini', input: 'Hi' },
  {
    model: 'gpt-4o-mini', instructions: 'Be brief.', max_output_tokens: 40, temperature: 1, top_p: 1, stream: false, store: false,
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'What is this?' }, { type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'high' }, { type: 'input_file', file_data: `data:application/pdf;base64,${PDF}`, filename: 'a.pdf' }] },
      { type: 'function_call', call_id: 'c1', name: 'weather', arguments: '{"city":"Oslo"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'Sunny' },
      { role: 'assistant', content: [{ type: 'output_text', text: 'It is sunny.' }] },
      { role: 'user', content: 'Thanks' },
    ],
    tools: [{ type: 'function', name: 'weather', description: 'The weather', parameters: { type: 'object', properties: {} } }], tool_choice: 'required',
  },
  { model: 'gpt-4o-mini', input: [{ role: 'user', content: 'Stream' }], stream: true },
];

export const MESSAGES_SEEDS: unknown[] = [
  { model: 'gpt-4o-mini', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }] },
  {
    model: 'gpt-4o-mini', max_tokens: 100, system: [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }], temperature: 0.5, top_p: 0.9, top_k: 5, stop_sequences: ['END'],
    metadata: { user_id: 'u' }, thinking: { type: 'enabled', budget_tokens: 1024 },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF } }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: 'sig' }, { type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: 'Oslo' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'Sunny' }] }, { type: 'text', text: 'And tomorrow?' }] },
    ],
    tools: [{ name: 'weather', description: 'The weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }], tool_choice: { type: 'tool', name: 'weather' },
  },
  { model: 'gpt-4o-mini', max_tokens: 10, stream: true, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }, { type: 'text', text: 'Hi' }] }] },
];

export const EMBEDDING_SEEDS: unknown[] = [
  { model: 'text-embedding-3-small', input: 'Hi' },
  { model: 'text-embedding-3-small', input: ['a', 'b', 'c'], encoding_format: 'float' },
];

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const finite = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v));

/** What the rest of the gateway assumes about an accepted request. */
function checkParsed(req: ParsedChatRequest) {
  const problems: string[] = [];
  if (typeof req.model !== 'string' || !req.model) problems.push('model');
  if (!Array.isArray(req.messages) || req.messages.length === 0) problems.push('messages');
  for (const [i, m] of req.messages.entries()) {
    if (!ROLES.has(m.role)) problems.push(`messages[${i}].role ${String(m.role)}`);
    if (typeof m.content !== 'string') problems.push(`messages[${i}].content is ${typeof m.content}`);
    if (m.role === 'tool' && typeof m.toolCallId !== 'string') problems.push(`messages[${i}].toolCallId`);
    for (const c of m.toolCalls ?? []) if (typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.arguments !== 'string') problems.push(`messages[${i}].toolCalls`);
    for (const p of m.parts ?? []) {
      if (p.type === 'text' && typeof p.text !== 'string') problems.push(`messages[${i}] text part`);
      if (p.type === 'image' && !(p.source.kind === 'url' ? typeof p.source.url === 'string' : typeof p.source.data === 'string' && typeof p.source.mediaType === 'string')) problems.push(`messages[${i}] image part`);
      if ((p.type === 'audio' || p.type === 'pdf') && typeof p.data !== 'string') problems.push(`messages[${i}] ${p.type} part`);
      if (!['text', 'image', 'audio', 'pdf'].includes(p.type)) problems.push(`messages[${i}] part ${String(p.type)}`);
    }
  }
  if (!finite(req.maxTokens) || (req.maxTokens !== undefined && (req.maxTokens < 1 || !Number.isInteger(req.maxTokens)))) problems.push(`maxTokens ${req.maxTokens}`);
  if (!finite(req.temperature) || !finite(req.topP)) problems.push('temperature/topP');
  if (req.stop !== undefined && (!Array.isArray(req.stop) || !req.stop.every((s) => typeof s === 'string'))) problems.push('stop');
  for (const t of req.tools ?? []) if (typeof t.name !== 'string' || (t.parameters !== undefined && (typeof t.parameters !== 'object' || t.parameters === null || Array.isArray(t.parameters)))) problems.push('tools');
  if (req.toolChoice !== undefined && typeof req.toolChoice !== 'string' && typeof req.toolChoice?.name !== 'string') problems.push('toolChoice');
  if (typeof req.stream !== 'boolean' || typeof req.includeUsage !== 'boolean' || typeof req.usesTools !== 'boolean') problems.push('flags');
  expect(problems).toEqual([]);
}

const pickSeed = (seeds: unknown[]) => (r: { pick<T>(a: readonly T[]): T; bool(p?: number): boolean }) => r.pick(seeds);

describe('the parsers refuse or accept, nothing else', () => {
  test('Chat Completions', async () => {
    await forAll('parse chat', 4000, (r) => mutate(r, pickSeed(CHAT_SEEDS)(r)), (body) => {
      const out = expectClientError(() => parseChatRequest(body));
      if (!(out instanceof Error)) checkParsed(out as ParsedChatRequest);
    });
  });

  test('Responses', async () => {
    await forAll('parse responses', 4000, (r) => mutate(r, pickSeed(RESPONSES_SEEDS)(r)), (body) => {
      const out = expectClientError(() => parseResponsesRequest(body));
      if (!(out instanceof Error)) checkParsed((out as ReturnType<typeof parseResponsesRequest>).req);
    });
  });

  test('Messages and count_tokens', async () => {
    await forAll('parse messages', 4000, (r) => ({ body: mutate(r, pickSeed(MESSAGES_SEEDS)(r)), countOnly: r.bool(0.3) }), ({ body, countOnly }) => {
      const out = expectClientError(() => parseMessagesRequest(body, { countOnly }));
      if (!(out instanceof Error)) {
        const parsed = out as ReturnType<typeof parseMessagesRequest>;
        checkParsed(parsed.req);
        expect(Number.isFinite(parsed.estimatedInputTokens) && parsed.estimatedInputTokens >= 0).toBe(true);
      }
    });
  });

  test('embeddings', async () => {
    await forAll('parse embeddings', 2000, (r) => mutate(r, r.pick(EMBEDDING_SEEDS)), (body) => {
      const out = expectClientError(() => parseEmbeddingRequest(body));
      if (!(out instanceof Error)) {
        const { model, input } = out as ReturnType<typeof parseEmbeddingRequest>;
        expect([typeof model, Array.isArray(input) && input.every((s) => typeof s === 'string')]).toEqual(['string', true]);
      }
    });
  });

  test('the seeds themselves are valid (or the fuzzing above proves little)', () => {
    for (const s of CHAT_SEEDS) checkParsed(parseChatRequest(s));
    for (const s of RESPONSES_SEEDS) checkParsed(parseResponsesRequest(s).req);
    for (const s of MESSAGES_SEEDS) checkParsed(parseMessagesRequest(s).req);
    for (const s of EMBEDDING_SEEDS) parseEmbeddingRequest(s);
  });
});

describe('through the whole pipeline to a provider', () => {
  let mock: MockProviders;
  let h: Harness;
  let key: string;
  beforeAll(async () => {
    mock = await startMockProviders();
    ({ h, key } = await gatewayWorld(mock));
    const p = h.providers.list()[0]!;
    h.models.create({ id: 'u', username: 'admin' }, { providerId: p.id, providerModelId: 'text-embedding-3-small', capabilities: ['EMBEDDINGS'] }, { ip: null });
    // Media and tools are routed only to models that declare them.
    const chatModel = h.models.listAll().find((m) => m.providerModelId === 'gpt-4o-mini')!;
    h.models.update({ id: 'u', username: 'admin' }, chatModel.id, { capabilities: ['CHAT', 'VISION', 'TOOL_USE'] }, { ip: null });
  });
  afterAll(() => mock.stop());

  const ENDPOINTS: [string, unknown[], Record<string, string>][] = [
    ['/v1/chat/completions', CHAT_SEEDS, {}],
    ['/v1/responses', RESPONSES_SEEDS, {}],
    ['/v1/messages', MESSAGES_SEEDS, { 'anthropic-version': '2023-06-01' }],
    ['/v1/messages/count_tokens', MESSAGES_SEEDS, { 'anthropic-version': '2023-06-01' }],
    ['/v1/embeddings', EMBEDDING_SEEDS, {}],
  ];

  test.each(ENDPOINTS)('%s', async (path, seeds, extra) => {
    let ok = 0;
    await forAll(`pipeline ${path}`, 150, (r) => (r.bool(0.1) ? r.pick(seeds) : mutate(r, r.pick(seeds))), async (body) => {
      h.logs.length = 0;
      h.clock.advance(600); // stay under the per-key rate limit, so every case reaches the parser
      const res = await h.request(path, { method: 'POST', headers: { authorization: `Bearer ${key}`, ...extra }, json: body });
      await expectHandledResponse(res, h.logs, [502, 503, 504]);
      if (res.status === 200) ok += 1;
    });
    // Some mutated requests must get through, or the provider side was never reached.
    expect(ok).toBeGreaterThan(0);
  }, 60_000);
});

/** Every query parameter a console or gateway route reads (from the controllers). */
const QUERY_NAMES = ['action', 'actor', 'after', 'apiKeyId', 'before', 'bucket', 'capability', 'component', 'from', 'groupBy', 'hours', 'keyId', 'level', 'limit', 'model', 'offset', 'page', 'pageSize', 'problems', 'providerId', 'q', 'requestId', 'resource', 'resourceId', 'result', 'status', 'to', 'trigger', 'type', 'unread', 'usable', 'userId', 'sort', 'order'];
/** Values that have broken query code: NUL, LIKE and FTS syntax. */
const QUERY_NASTY = ['a\u0000bc', '\u0000\u0000\u0000', '%_%', '"""', 'a" OR "b', 'NEAR(abc def)'];
const QUERY_VALUES = ['', '0', '-1', '1', '50', '201', '1e309', 'NaN', 'true', 'x', 'a\u0000bc', '\u0000\u0000\u0000', '%', '_', '\\', '"', "'", '*', 'NEAR(a b)', 'a OR b', '2026-11-20T00:00:00.000Z', '2026-13-45', 'hour', 'day', 'SUCCESS', 'FAILURE', 'CHAT', 'error', 'openai/gpt-4o-mini', '😀😀😀', 'a'.repeat(5000)];

describe('query strings on every GET route', () => {
  const routes = createHarness().api.router.list().filter((r) => r.method === 'GET' && r.access !== 'public');
  let mock: MockProviders;
  let h: Harness;
  let admin: string;
  let key: string;
  beforeAll(async () => {
    mock = await startMockProviders();
    ({ h, admin, key } = await gatewayWorld(mock));
  });
  afterAll(() => mock.stop());

  test.each(routes.map((r) => [`${r.method} ${r.pattern}`, r] as const))('%s', async (_name, route) => {
    await forAll(`query ${route.pattern}`, 80, (r) => {
      const params = new URLSearchParams();
      for (let n = 1 + r.int(4); n > 0; n--) {
        params.append(r.pick(QUERY_NAMES), r.bool(0.3) ? r.pick(QUERY_NASTY) : r.bool(0.8) ? r.pick(QUERY_VALUES) : anyString(r));
      }
      return `${route.pattern.replace(/:[a-zA-Z]+/g, () => r.pick(['x', crypto.randomUUID(), '%00']))}?${params}`;
    }, async (path) => {
      h.logs.length = 0;
      h.clock.advance(600);
      const gateway = route.access === 'api_key' || route.access === 'mcp';
      const res = await h.request(path, gateway ? { headers: { authorization: `Bearer ${key}` } } : { cookie: admin });
      await expectHandledResponse(res, h.logs, [502, 503, 504]);
      if (res.status === 401 && !gateway) admin = await h.login();
    });
  }, 60_000);
});
