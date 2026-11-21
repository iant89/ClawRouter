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

// SEC-027 corpus: cross-site request forgery against the console.

import { describe, expect, test } from 'bun:test';
import { createHarness } from '../support.ts';

const themeOf = (h: ReturnType<typeof createHarness>) => h.db.get<{ theme: string }>("SELECT theme FROM users WHERE username = 'admin'")!.theme;

describe('csrf', () => {
  test.each([
    ['another site', { origin: 'https://evil.example' }],
    ['a sandboxed frame (Origin: null)', { origin: 'null' }],
    ['a look-alike host', { origin: 'http://clawrouter.test.evil.example' }],
    ['the browser saying cross-site', { 'sec-fetch-site': 'cross-site' }],
  ])('CASE-004: %s cannot change anything with the cookie', async (_name, headers) => {
    const h = createHarness();
    const cookie = await h.completeSetup();
    const before = themeOf(h);
    const res = await h.request('/api/auth/theme', { method: 'PUT', cookie, headers, json: { theme: before === 'light' ? 'dark' : 'light' } });
    expect(res.status).toBe(403);
    expect(themeOf(h)).toBe(before);
  });

  test.each(['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain'])('CASE-005: a %s body (what an HTML form sends) is refused', async (type) => {
    const h = createHarness();
    const cookie = await h.completeSetup();
    const before = themeOf(h);
    // A form cannot set the CSRF header, so this is the strongest form post: same origin, header missing.
    const res = await h.request('/api/auth/theme', { method: 'PUT', cookie, csrf: false, headers: { 'content-type': type }, body: 'theme=light' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(themeOf(h)).toBe(before);
  });
});
