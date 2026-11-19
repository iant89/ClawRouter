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
import type { ApiSuccess, CreatedApiKey, RateLimitConfigView, RequestLimits } from '@clawrouter/shared';
import { DEFAULT_REQUEST_LIMITS } from '@clawrouter/shared';
import { createHarness } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

/** Request resource limits (SEC-006): checked on every /v1 chat endpoint before any provider call. */
let mock: MockProviders;
beforeAll(() => {
  mock = startMockProviders();
});
afterAll(() => mock.stop());
beforeEach(() => {
  mock.mode = 'ok';
  mock.requests.length = 0;
  mock.streamDelayMs = 0;
});

const actor = { id: 'u', username: 'admin' };
const client = { ip: null };
type OpenAiError = { error: { message: string; type: string; code: string; param: string | null; limit?: string } };
const json = async <T>(res: Response) => (await res.json()) as T;
const data = async <T>(res: Response) => (await json<ApiSuccess<T>>(res)).data;

/** A PNG header claiming `width` × `height` pixels (the gateway reads only the header). */
function png(width: number, height: number, padding = 0): string {
  const b = Buffer.alloc(33 + padding);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b, 0);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = 6;
  return b.toString('base64');
}

async function world() {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const openai = await h.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key, priority: 10 }, client);
  h.models.create(actor, { providerId: openai.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT', 'VISION', 'TOOL_USE'] }, client);
  const res = await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'ci' } });
  const key = (await data<CreatedApiKey>(res)).secret;
  const post = (path: string, body: unknown, init: RequestInit = {}) => h.request(path, { method: 'POST', headers: { authorization: `Bearer ${key}` }, json: body, ...init });
  const chat = (extra: Record<string, unknown> = {}) => post('/v1/chat/completions', { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }], ...extra });
  const limit = async (patch: Partial<RequestLimits>) => {
    const current = await data<RateLimitConfigView>(await h.request('/api/rate-limits', { cookie: admin }));
    const { unknownModels: _u, updatedAt: _a, updatedBy: _b, ...rest } = current;
    const r = await h.request('/api/rate-limits', { method: 'PUT', cookie: admin, json: { ...rest, requestLimits: { ...current.requestLimits, ...patch } } });
    expect(r.status).toBe(200);
  };
  return { h, admin, key, post, chat, limit };
}

/** The 400 every request limit answers with, naming the limit. */
async function refusedBy(res: Response, limit: string): Promise<OpenAiError['error']> {
  expect(res.status).toBe(400);
  const err = (await json<OpenAiError>(res)).error;
  expect(err).toMatchObject({ type: 'invalid_request_error', code: 'request_limit', limit });
  return err;
}

const providerCalls = () => mock.requests.filter((r) => r.method === 'POST').length;
const sent = () => mock.requests.filter((r) => r.method === 'POST').at(-1)!.body as Record<string, unknown>;

describe('body size and JSON depth', () => {
  test('maxRequestBytes refuses a larger body before it is read in full', async () => {
    const { chat, limit } = await world();
    await limit({ maxRequestBytes: 4096 });
    const err = await refusedBy(await chat({ messages: [{ role: 'user', content: 'x'.repeat(5000) }] }), 'maxRequestBytes');
    expect(err.message).toBe('Request body is too large (limit 4 KB).');
    expect(providerCalls()).toBe(0);
    expect((await chat()).status).toBe(200);
  });

  test('maxJsonDepth refuses deep nesting before parsing; brackets inside strings do not count', async () => {
    const { h, key, chat, limit } = await world();
    await limit({ maxJsonDepth: 8 });
    let deep: unknown = 'x';
    for (let i = 0; i < 10; i++) deep = { a: deep };
    const err = await refusedBy(await chat({ metadata: deep }), 'maxJsonDepth');
    expect(err.message).toBe('Request body is nested too deeply (limit 8 levels).');
    expect((await chat({ messages: [{ role: 'user', content: '[[[[[[[[[[[[{{{{{{{{{{' }] })).status).toBe(200);
    // A body far deeper than any parser likes is refused cheaply too.
    const bomb = `{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hi"}],"x":${'['.repeat(100_000)}${']'.repeat(100_000)}}`;
    await refusedBy(await h.request('/v1/chat/completions', { method: 'POST', body: bomb, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } }), 'maxJsonDepth');
  });
});

describe('structure', () => {
  test('maxMessages, maxContentParts and maxImages', async () => {
    const { chat, limit } = await world();
    await limit({ maxMessages: 3, maxContentParts: 4, maxImages: 1 });
    const many = Array.from({ length: 4 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    const err = await refusedBy(await chat({ messages: many }), 'maxMessages');
    expect(err.message).toBe('The request has 4 messages; at most 3 are allowed.');
    expect(err.param).toBe('messages');
    const parts = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'text', text: 'c' }, { type: 'text', text: 'd' }];
    // Text-only part lists are joined into one part when parsed; images keep them apart.
    const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${png(10, 10)}` } };
    await refusedBy(await chat({ messages: [{ role: 'user', content: [...parts, image] }] }), 'maxContentParts');
    await refusedBy(await chat({ messages: [{ role: 'user', content: [{ type: 'text', text: 'two' }, image, image] }] }), 'maxImages');
    expect((await chat({ messages: [{ role: 'user', content: [{ type: 'text', text: 'one' }, image] }] })).status).toBe(200);
    expect(providerCalls()).toBe(1);
  });

  test('maxToolDefinitions and maxToolSchemaBytes', async () => {
    const { chat, limit } = await world();
    await limit({ maxToolDefinitions: 2, maxToolSchemaBytes: 2048 });
    const tool = (name: string, extra = '') => ({ type: 'function', function: { name, description: extra, parameters: { type: 'object', properties: {} } } });
    await refusedBy(await chat({ tools: [tool('a'), tool('b'), tool('c')] }), 'maxToolDefinitions');
    const err = await refusedBy(await chat({ tools: [tool('a', 'x'.repeat(1500)), tool('b', 'y'.repeat(1500))] }), 'maxToolSchemaBytes');
    expect(err.param).toBe('tools');
    expect((await chat({ tools: [tool('a'), tool('b')] })).status).toBe(200);
  });

  test('maxImageBytes and maxImageDimension read inline images; an unreadable image is refused', async () => {
    const { chat, limit } = await world();
    await limit({ maxImageBytes: 2048, maxImageDimension: 4096 });
    const ask = (b64: string) => chat({ messages: [{ role: 'user', content: [{ type: 'text', text: 'What?' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }] }] });
    await refusedBy(await ask(png(100, 100, 4000)), 'maxImageBytes');
    const err = await refusedBy(await ask(png(5000, 100)), 'maxImageDimension');
    expect(err.message).toBe('An image is 5,000 × 100 pixels; at most 4,096 pixels on a side are allowed.');
    await refusedBy(await ask(Buffer.from('not an image at all, just text').toString('base64')), 'maxImageDimension');
    expect((await ask(png(4096, 4096))).status).toBe(200);
  });
});

describe('tokens', () => {
  test('maxInputTokens refuses a long prompt (estimated, about four characters per token)', async () => {
    const { chat, limit } = await world();
    await limit({ maxInputTokens: 100 });
    const err = await refusedBy(await chat({ messages: [{ role: 'user', content: 'x'.repeat(404) }] }), 'maxInputTokens');
    expect(err.message).toBe('The request has about 101 input tokens; at most 100 are allowed.');
    expect((await chat({ messages: [{ role: 'user', content: 'x'.repeat(400) }] })).status).toBe(200);
  });

  test('maxOutputTokens lowers a larger max_tokens and sets a missing one', async () => {
    const { chat, limit } = await world();
    await limit({ maxOutputTokens: 256 });
    expect((await chat({ max_tokens: 10_000 })).status).toBe(200);
    expect(sent().max_tokens ?? sent().max_completion_tokens).toBe(256);
    await chat();
    expect(sent().max_tokens ?? sent().max_completion_tokens).toBe(256);
    await chat({ max_tokens: 20 });
    expect(sent().max_tokens ?? sent().max_completion_tokens).toBe(20);
  });

  test('maxTokensPerRequest leaves the answer what the input does not use, and refuses when nothing is left', async () => {
    const { chat, limit } = await world();
    await limit({ maxTokensPerRequest: 300 });
    await chat({ messages: [{ role: 'user', content: 'x'.repeat(400) }] }); // 100 input tokens
    expect(sent().max_tokens ?? sent().max_completion_tokens).toBe(200);
    await refusedBy(await chat({ messages: [{ role: 'user', content: 'x'.repeat(1200) }] }), 'maxTokensPerRequest');
  });

  test('embeddings follow maxInputTokens', async () => {
    const { h, post, limit } = await world();
    const openai = h.providers.list()[0]!;
    h.models.create(actor, { providerId: openai.id, providerModelId: 'text-embedding-3-small', capabilities: ['EMBEDDINGS'] }, client);
    await limit({ maxInputTokens: 10 });
    const res = await post('/v1/embeddings', { model: 'openai/text-embedding-3-small', input: ['y'.repeat(100)] });
    expect(res.status).toBe(400);
    expect((await json<OpenAiError>(res)).error).toMatchObject({ code: 'request_limit', limit: 'maxInputTokens', param: 'input' });
  });
});

describe('every chat endpoint', () => {
  test('the Responses and Messages APIs are limited the same way', async () => {
    const { h, key, post, limit } = await world();
    await limit({ maxMessages: 1 });
    const two = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
    const responses = await post('/v1/responses', { model: 'gpt-4o-mini', input: two });
    expect(responses.status).toBe(400);
    expect((await json<OpenAiError>(responses)).error).toMatchObject({ code: 'request_limit', limit: 'maxMessages' });
    const messages = await h.request('/v1/messages', {
      method: 'POST', json: { model: 'gpt-4o-mini', max_tokens: 50, messages: two }, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    expect(messages.status).toBe(400);
    expect(await messages.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error', message: 'The request has 3 messages; at most 1 are allowed.' } });
    expect(providerCalls()).toBe(0);
  });
});

describe('stream duration', () => {
  test('maxStreamSeconds ends a stream that runs too long and records why', async () => {
    const { h, chat, limit } = await world();
    await limit({ maxStreamSeconds: 1 });
    mock.streamDelayMs = 400; // five events, each split in two: about 2 s
    const res = await chat({ stream: true });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Hel');
    expect(text).not.toContain('[DONE]');
    const row = h.db.get<{ status: string; error_code: string; error_message: string }>('SELECT status, error_code, error_message FROM requests');
    expect(row).toEqual({ status: 'FAILED', error_code: 'STREAM_TIME_LIMIT', error_message: 'The stream was ended after the 1 s limit.' });
  });
});

describe('defaults', () => {
  test('structural limits apply out of the box; token, concurrency and cost limits are off', () => {
    expect(DEFAULT_REQUEST_LIMITS).toMatchObject({
      maxRequestBytes: 25 * 1024 * 1024, maxJsonDepth: 64, maxMessages: 2_000, maxToolDefinitions: 128, maxImages: 50,
      maxInputTokens: null, maxOutputTokens: null, maxTokensPerRequest: null, maxConcurrentPerKey: null, maxConcurrentPerUser: null, maxStreamSeconds: 3_600,
    });
  });

  test('a default install refuses a body nested 65 levels deep', async () => {
    const { chat } = await world();
    let deep: unknown = 1;
    for (let i = 0; i < 70; i++) deep = [deep];
    await refusedBy(await chat({ metadata: deep }), 'maxJsonDepth');
  });
});

