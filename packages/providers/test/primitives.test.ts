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

import { describe, expect, test } from 'bun:test';
import { createOutboundPolicy } from '@clawrouter/security';
import { checkEndpoint, parseSse, providerFetch, ProviderCallError, scrub } from '../src/index.ts';

describe('endpoint policy', () => {
  // As configured for an installation with a local model server and the default (empty) allowlist.
  const local = createOutboundPolicy(['localhost', '127.0.0.0/8', '192.168.0.0/16', 'ollama']);
  const closed = createOutboundPolicy();

  test.each([
    ['https://api.openai.com/v1/', 'https://api.openai.com/v1'],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1'],
    ['http://127.0.0.1:8000', 'http://127.0.0.1:8000'],
    ['http://192.168.1.20:1234/v1', 'http://192.168.1.20:1234/v1'],
    ['http://ollama:11434/v1', 'http://ollama:11434/v1'],
  ])('accepts %s when allowlisted', (input, normalized) => {
    expect(checkEndpoint(input, 'endpoint', local)).toEqual({ url: normalized, issues: [] });
  });

  test.each([
    ['http://localhost:11434/v1', 'CLAWROUTER_OUTBOUND_ALLOWLIST'],
    ['http://127.0.0.1:8000', 'loopback'],
    ['https://192.168.1.20/v1', 'private network'],
    ['http://ollama:11434/v1', 'plain http'],
    ['http://api.example.com/v1', 'use https'],
  ])('refuses %s without an allowlist', (input, message) => {
    const { url, issues } = checkEndpoint(input, 'endpoint', closed);
    expect(url).toBeNull();
    expect(issues[0]!.message).toContain(message);
  });

  test.each([
    ['ftp://example.com', 'http or https'],
    ['https://user:pw@example.com', 'credentials'],
    ['https://example.com/v1?key=abc', 'query string'],
    ['http://169.254.169.254/latest', 'metadata'],
    ['https://metadata.google.internal', 'metadata'],
    ['not a url', 'valid URL'],
  ])('rejects %s', (input, message) => {
    const { url, issues } = checkEndpoint(input, 'endpoint', local);
    expect(url).toBeNull();
    expect(issues[0]!.message).toContain(message);
  });
});

describe('SSE parser', () => {
  const stream = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    });

  test('handles events split across chunks, CRLF, comments and multi-line data', async () => {
    const events = [];
    for await (const e of parseSse(stream(['event: a\r\nda', 'ta: 1\r\n\r\n: keep-alive\n\ndata: x\ndata: y\n\n', 'data: tail']))) events.push(e);
    expect(events).toEqual([{ event: 'a', data: '1' }, { event: null, data: 'x\ny' }, { event: null, data: 'tail' }]);
  });
});

describe('providerFetch', () => {
  const ctx = (fetchImpl: typeof fetch, extra = {}) => ({ endpoint: 'https://x', apiKey: 'sk-secret-key-123', timeoutMs: 200, fetch: fetchImpl, ...extra });
  const fake = (res: Response | (() => Promise<Response>)) => (async () => (typeof res === 'function' ? res() : res)) as unknown as typeof fetch;

  test('maps HTTP errors and scrubs the key from provider messages', async () => {
    const error = await providerFetch(ctx(fake(Response.json({ error: { message: 'bad key sk-secret-key-123' } }, { status: 401 }))), 'https://x', {}).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderCallError);
    expect(error.failure).toBe('auth');
    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain('sk-secret-key-123');
  });

  test("403 is a refusal of this key (forbidden), not a wrong key; Google's 400 for a bad key is auth", async () => {
    const failure = async (status: number, message: string) => (await providerFetch(ctx(fake(Response.json({ error: { message } }, { status }))), 'https://x', {}).catch((e) => e)).failure;
    expect(await failure(403, 'thinkingmachines/inkling-2-small:free is only available on agentic harnesses')).toBe('forbidden');
    expect(await failure(403, 'Key limit exceeded')).toBe('forbidden');
    expect(await failure(400, 'API key not valid. Please pass a valid API key.')).toBe('auth');
    expect(await failure(400, "Unsupported value: 'temperature'")).toBe('bad_request');
  });

  test('refuses redirects', async () => {
    const error = await providerFetch(ctx(fake(new Response(null, { status: 307, headers: { location: 'https://evil' } }))), 'https://x', {}).catch((e) => e);
    expect(error.failure).toBe('invalid_response');
    expect(error.message).toContain('redirect');
  });

  test('times out', async () => {
    const hang = ((_: unknown, init?: RequestInit) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const error = await providerFetch(ctx(hang, { timeoutMs: 30 }), 'https://x', {}).catch((e) => e);
    expect(error.failure).toBe('timeout');
    expect(error.code).toBe('PROVIDER_TIMEOUT');
  });

  test('caller cancellation is reported as cancelled', async () => {
    const controller = new AbortController();
    const hang = ((_: unknown, init?: RequestInit) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const pending = providerFetch(ctx(hang, { signal: controller.signal, timeoutMs: 5000 }), 'https://x', {}).catch((e) => e);
    controller.abort();
    expect((await pending).failure).toBe('cancelled');
  });

  test('scrub ignores trivially short secrets', () => {
    expect(scrub('abc', 'ab')).toBe('abc');
  });
});
