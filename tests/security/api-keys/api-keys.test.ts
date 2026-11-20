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

// SEC-012 API keys: shown once, stored hashed, refused once revoked, expired or suspended,
// and never a way into the console.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { CreatedApiKey } from '@clawrouter/shared';
import { startMockProviders, type MockProviders } from '../../support/mock-providers.ts';
import { chat, data, gatewayWorld } from '../support.ts';

let mock: MockProviders;
beforeAll(() => { mock = startMockProviders(); });
afterAll(() => mock.stop());

describe('API keys (SEC-012)', () => {
  test('the secret is shown once: never listed, never stored, never logged or audited', async () => {
    const { h, admin, key } = await gatewayWorld(mock);
    expect((await chat(h, key)).status).toBe(200);
    for (const path of ['/api/api-keys', '/api/me/api-keys', '/api/audit', '/api/logs', '/api/requests']) {
      expect([path, (await (await h.request(path, { cookie: admin })).text()).includes(key)]).toEqual([path, false]);
    }
    const stored = JSON.stringify(h.db.all('SELECT * FROM api_keys')) + JSON.stringify(h.db.all('SELECT * FROM audit_log')) + JSON.stringify(h.logs);
    expect(stored).not.toContain(key);
    // The prefix alone (shown to tell keys apart) does not work as a key.
    const prefix = h.db.get<{ prefix: string }>('SELECT prefix FROM api_keys')!.prefix;
    expect(key.startsWith(prefix)).toBe(true);
    expect((await chat(h, prefix)).status).toBe(401);
  });

  test('a near miss, a revoked key, an expired key and a disabled owner\'s key are all 401', async () => {
    const { h, key, keyId } = await gatewayWorld(mock);
    let admin = await h.login();
    const flipped = `${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`;
    expect((await chat(h, flipped)).status).toBe(401);
    expect((await h.request(`/api/api-keys/${keyId}`, { method: 'DELETE', cookie: admin })).status).toBeLessThan(300);
    expect((await chat(h, key)).status).toBe(401);

    const short = await data<CreatedApiKey>(await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'short', expiry: { type: 'after', hours: 1 } } }));
    expect((await chat(h, short.secret)).status).toBe(200);
    h.clock.advance(61 * 60_000);
    expect((await chat(h, short.secret)).status).toBe(401);
    admin = await h.login(); // the console session idled out meanwhile

    const { id } = await h.addUser('owen', ['OPERATOR']);
    const owen = await h.login('owen');
    const own = await data<CreatedApiKey>(await h.request('/api/me/api-keys', { method: 'POST', cookie: owen, json: { name: 'mine', expiry: { type: 'after', hours: 24 } } }));
    expect((await chat(h, own.secret)).status).toBe(200);
    expect((await h.request(`/api/users/${id}`, { method: 'PATCH', cookie: admin, json: { status: 'DISABLED' } })).status).toBe(200);
    expect((await chat(h, own.secret)).status).toBe(401);
  });

  test('a key never opens the console API or the live channel, in any header', async () => {
    const { h, key } = await gatewayWorld(mock);
    const variants: Record<string, string>[] = [{ authorization: `Bearer ${key}` }, { 'x-api-key': key }, { cookie: `clawrouter_session=${key}` }];
    for (const headers of variants) {
      expect((await h.request('/api/auth/session', { headers })).status).toBe(401);
      expect((await h.request('/api/users', { headers })).status).toBe(401);
    }
  });

  test('a key is only accepted in a header, never in the URL', async () => {
    const { h, key } = await gatewayWorld(mock);
    for (const q of [`api_key=${key}`, `key=${key}`, `token=${key}`]) {
      const res = await h.request(`/v1/models?${q}`, {});
      expect([q.split('=')[0], res.status]).toEqual([q.split('=')[0], 401]);
    }
  });

  test('a user can only revoke their own keys through the self-service routes', async () => {
    const { h, keyId } = await gatewayWorld(mock);
    await h.addUser('owen', ['OPERATOR']);
    const owen = await h.login('owen');
    expect((await h.request(`/api/me/api-keys/${keyId}`, { method: 'DELETE', cookie: owen })).status).toBe(404);
    expect(h.db.get<{ revoked_at: string | null }>('SELECT revoked_at FROM api_keys WHERE id = ?', [keyId])!.revoked_at).toBeNull();
  });
});
