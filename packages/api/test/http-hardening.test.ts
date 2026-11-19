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
import type { ApiErrorBody } from '@clawrouter/shared';
import { createHarness } from '../../../tests/support/harness.ts';

/** A body sent in chunks without Content-Length, so only the stream reveals its size. */
function chunkedBody(totalBytes: number, chunk = 16 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      const n = Math.min(chunk, totalBytes - sent);
      controller.enqueue(new Uint8Array(n).fill(0x20));
      sent += n;
    },
  });
}

describe('request bodies', () => {
  test('an oversized chunked body is refused without being read in full', async () => {
    const h = createHarness();
    const stream = chunkedBody(5 * 1024 * 1024);
    const res = await h.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErrorBody).error.message).toBe('Request body is too large (limit 64 KB).');
  });

  test('a declared oversized body is refused up front', async () => {
    const h = createHarness();
    const res = await h.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(10 * 1024 * 1024) }, body: '{}' });
    expect(res.status).toBe(400);
  });

  test('/v1 allows 25 MB (media inline), and refuses more even when chunked', async () => {
    const h = createHarness();
    await h.completeSetup();
    const { secret } = await h.apiKeys.create({ id: null, username: 'system' } as never, { name: 'k', expiry: { type: 'after', hours: 24 } }, { ip: null });
    const res = await h.request('/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: chunkedBody(26 * 1024 * 1024, 256 * 1024), duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('limit 25 MB');
  });

  test('malformed and absurdly nested JSON are 400s, never 500s', async () => {
    const h = createHarness();
    for (const body of ['{', 'null', '[]', '"x"', `${'['.repeat(50_000)}${']'.repeat(50_000)}`]) {
      const res = await h.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      expect(res.status).toBe(400);
    }
  });
});

describe('security headers', () => {
  test('API responses forbid framing, sniffing, caching and loading anything', async () => {
    const h = createHarness();
    const res = await h.request('/api/setup/status');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('permissions-policy')).toContain('camera=()');
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  test('HSTS is sent when the deployment uses HTTPS (secure cookies)', async () => {
    const h = createHarness({ secureCookie: true });
    const res = await h.request('/api/setup/status');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
  });

  test('error responses carry them too', async () => {
    const h = createHarness();
    const res = await h.request('/api/providers');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});
