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

// SEC-027 corpus: DNS rebinding, against provider connections and against the console.

import { describe, expect, test } from 'bun:test';
import { createOutboundGuard, createOutboundPolicy, OutboundBlockedError } from '@clawrouter/security';
import { createHarness } from '../support.ts';

const PUBLIC = '93.184.215.14';

describe('dns rebinding', () => {
  test('CASE-024: the connection goes to the address that was checked; a later private answer is refused', async () => {
    const lookups: string[] = [];
    const connected: string[] = [];
    let n = 0;
    const g = createOutboundGuard({
      policy: createOutboundPolicy([]), env: {},
      // First lookup public, every later one private: what an attacker's DNS server answers.
      resolver: async (name) => { lookups.push(name); return n++ === 0 ? [PUBLIC] : ['10.0.0.7']; },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { connected.push(`${String(input)} host=${new Headers(init?.headers).get('host')}`); return new Response('{}'); }) as typeof fetch,
    });
    await g.fetch('https://rebind.example/v1/models');
    expect(connected).toEqual([`https://${PUBLIC}/v1/models host=rebind.example`]);
    expect(lookups).toEqual(['rebind.example']);
    await expect(g.fetch('https://rebind.example/v1/models')).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(connected).toHaveLength(1);
  });

  test('CASE-025: a page whose name was rebound to ClawRouter has no session: it can neither set up the server nor use it', async () => {
    const h = createHarness();
    // The attacker's page is same-origin with itself: Host and Origin agree, but no cookie and no setup token.
    const rebound = { host: 'evil.example:8080', origin: 'http://evil.example:8080' };
    const setup = await h.request('/api/setup', { method: 'POST', headers: rebound, json: { username: 'mallory', displayName: 'M', password: 'a long enough passphrase 42' } });
    expect(setup.status).toBeGreaterThanOrEqual(400);
    expect(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n).toBe(0);
    await h.completeSetup();
    for (const [method, path] of [['GET', '/api/users'], ['GET', '/api/providers'], ['GET', '/v1/models'], ['POST', '/api/api-keys']] as const) {
      const res = await h.request(path, { method, headers: rebound, ...(method === 'POST' ? { json: { name: 'x' } } : {}) });
      // 401 (no session or key), or 403 when the cross-site check refuses it first.
      expect([path, [401, 403].includes(res.status)]).toEqual([path, true]);
    }
  });
});
