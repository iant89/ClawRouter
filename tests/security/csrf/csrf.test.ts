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

// SEC-012 CSRF: a page on another site cannot make a signed-in browser change anything.

import { describe, expect, test } from 'bun:test';
import { createHarness } from '../support.ts';

const change = (h: ReturnType<typeof createHarness>, cookie: string, init: { csrf?: boolean; headers?: Record<string, string>; body?: string; type?: string } = {}) =>
  h.request('/api/auth/theme', {
    method: 'PUT', cookie, csrf: init.csrf ?? true,
    headers: { 'content-type': init.type ?? 'application/json', ...init.headers },
    body: init.body ?? JSON.stringify({ theme: 'light' }),
  });

describe('cross-site requests (SEC-012)', () => {
  test('a same-origin request with the CSRF header works (the baseline)', async () => {
    const h = createHarness();
    const cookie = await h.completeSetup();
    expect((await change(h, cookie, { headers: { origin: 'http://clawrouter.test' } })).status).toBe(200);
  });

  test.each([
    ['another origin', { origin: 'https://evil.example' }],
    ['a "null" origin (sandboxed iframe, file:)', { origin: 'null' }],
    ['a look-alike origin', { origin: 'http://clawrouter.test.evil.example' }],
    ['the same host on another port', { origin: 'http://clawrouter.test:8443' }],
    ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['Sec-Fetch-Site: same-site (a sibling subdomain)', { 'sec-fetch-site': 'same-site' }],
  ])('%s is rejected', async (_name, headers) => {
    const h = createHarness();
    const cookie = await h.completeSetup();
    const res = await change(h, cookie, { headers });
    expect(res.status).toBe(403);
  });

  test('without the CSRF header a cookie-authenticated change is rejected', async () => {
    const h = createHarness();
    const cookie = await h.completeSetup();
    expect((await change(h, cookie, { csrf: false })).status).toBe(403);
    for (const method of ['POST', 'DELETE', 'PATCH']) {
      expect([method, (await h.request('/api/announcements', { method, cookie, csrf: false, json: {} })).status]).toEqual([method, 403]);
    }
  });

  test('form encodings a cross-site form could send are refused', async () => {
    const h = createHarness();
    const cookie = await h.completeSetup();
    for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain']) {
      expect([type, (await change(h, cookie, { type, body: 'theme=light' })).status]).toEqual([type, 400]);
    }
  });

  test('ClawRouter never answers CORS preflights for /api or /v1', async () => {
    const h = createHarness();
    for (const path of ['/api/auth/login', '/v1/chat/completions']) {
      const res = await h.request(path, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });
});
