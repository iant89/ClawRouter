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

// SEC-027 corpus: HTTP desynchronization on a kept-alive connection.

import { afterAll, describe, expect, test } from 'bun:test';
import { createHarness } from '../support.ts';
import { sendRaw, serveRaw } from './raw-http.ts';

const h = createHarness();
await h.completeSetup();
const srv = serveRaw(h);
afterAll(() => srv.stop());

const HIDDEN = 'GET /api/users HTTP/1.1\r\nHost: x\r\n\r\n';

describe('http desync', () => {
  test.each([
    // Refused for the key before the body is read (401): the body is still skipped by its length.
    ['/v1/chat/completions', 401],
    // Over the console's 64 KB body limit: refused (400 request_limit), the body is never parsed as requests.
    ['/api/auth/login', 400],
  ])('CASE-022: a body %s answers without reading is not taken for the next request', async (path, status) => {
    srv.reached.length = 0;
    const body = path.startsWith('/api') ? HIDDEN.repeat(Math.ceil(70_000 / HIDDEN.length)) : HIDDEN;
    const raw = `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}GET /api/health/live HTTP/1.1\r\nHost: x\r\n\r\n`;
    const r = await sendRaw(srv.port, raw, 800);
    expect(r.statuses[0]).toBe(status);
    expect(srv.reached).not.toContain('GET /api/users');
    // Only the request after the body may follow (or the server closes the connection).
    expect(r.statuses.length).toBeLessThanOrEqual(2);
    if (r.statuses.length === 2) expect(srv.reached.at(-1)).toBe('GET /api/health/live');
  });

  test.each([
    ['bare LF line endings', 'GET /api/health/live HTTP/1.1\nHost: x\n\nGET /api/users HTTP/1.1\nHost: x\n\n'],
    ['a bare CR', 'GET /api/health/live HTTP/1.1\rHost: x\r\n\r\n'],
    ['a folded header (obs-fold)', 'GET /api/health/live HTTP/1.1\r\nHost: x\r\nX-A: 1\r\n Transfer-Encoding: chunked\r\n\r\n'],
    ['a NUL in a header', 'GET /api/health/live HTTP/1.1\r\nHost: x\r\nX-A: a\0b\r\n\r\n'],
    ['no Host on HTTP/1.1', 'GET /api/health/live HTTP/1.1\r\n\r\n'],
  ])('CASE-023: %s is refused and the connection closed', async (_name, raw) => {
    srv.reached.length = 0;
    const r = await sendRaw(srv.port, raw);
    expect(r.statuses.length).toBe(1);
    expect(r.statuses[0]).toBeGreaterThanOrEqual(400);
    expect(r.closedByServer).toBe(true);
    expect(srv.reached).toEqual([]);
  });
});
