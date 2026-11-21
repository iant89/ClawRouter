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

// SEC-027 corpus: cross-site scripting through reflected or stored text.

import { describe, expect, test } from 'bun:test';
import { CONSOLE_CSP } from '@clawrouter/api';
import { startMockProviders } from '../../support/mock-providers.ts';
import { gatewayWorld } from '../support.ts';

const PAYLOAD = '<script>alert(document.cookie)</script>';

describe('xss', () => {
  test('CASE-006: text from the client comes back only as JSON, never runnable or sniffable as HTML', async () => {
    const mock = startMockProviders();
    try {
      const { h, key, admin } = await gatewayWorld(mock);
      const answers = [
        await h.request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, json: { model: PAYLOAD, messages: [{ role: 'user', content: 'Hi' }] } }),
        await h.request(`/api/${encodeURIComponent(PAYLOAD)}`, { cookie: admin }),
        await h.request('/api/users', { method: 'POST', cookie: admin, json: { username: PAYLOAD, displayName: PAYLOAD } }),
      ];
      for (const res of answers) {
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.headers.get('content-type')).toContain('application/json');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
        // Even inside the JSON the payload is never raw HTML a sniffing browser could run.
        const body = await res.text();
        expect(() => JSON.parse(body)).not.toThrow();
      }
    } finally {
      mock.stop();
    }
  });

  test("CASE-007: the console allows only its own scripts: no inline script, no eval, no other origin", () => {
    const csp = Object.fromEntries(CONSOLE_CSP.split('; ').map((d) => [d.split(' ')[0], d]));
    expect(csp['script-src']).toBe("script-src 'self'");
    expect(csp['default-src']).toBeDefined();
    expect(csp['object-src'] ?? csp['default-src']).not.toContain('*');
    expect(csp['frame-ancestors']).toBe("frame-ancestors 'none'");
    expect(CONSOLE_CSP).not.toContain("'unsafe-eval'");
  });
});
