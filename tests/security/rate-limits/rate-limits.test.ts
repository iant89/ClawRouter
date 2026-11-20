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

// SEC-012 rate limits: key guessing, spoofed client addresses, and limits that cannot be bypassed
// by switching how the key is sent.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { clientAddress, parseTrustedProxies } from '@clawrouter/core';
import type { RateLimitConfigView } from '@clawrouter/shared';
import { startMockProviders, type MockProviders } from '../../support/mock-providers.ts';
import { chat, data, gatewayWorld } from '../support.ts';

let mock: MockProviders;
beforeAll(() => { mock = startMockProviders(); });
afterAll(() => mock.stop());

async function setLimits(h: Awaited<ReturnType<typeof gatewayWorld>>['h'], cookie: string, patch: Record<string, unknown>) {
  const { unknownModels: _u, updatedAt: _a, updatedBy: _b, ...rest } = await data<RateLimitConfigView>(await h.request('/api/rate-limits', { cookie }));
  expect((await h.request('/api/rate-limits', { method: 'PUT', cookie, json: { ...rest, ...patch } })).status).toBe(200);
}

describe('rate limits (SEC-012)', () => {
  test('guessing keys from one address blocks that address, even for a valid key, until the window passes', async () => {
    const { h, admin, key } = await gatewayWorld(mock);
    await setLimits(h, admin, { invalidKeysPerIp: 5 });
    for (let i = 0; i < 5; i++) expect((await chat(h, `crk_guess_${i}_0123456789abcdef`, { ip: '198.51.100.20' })).status).toBe(401);
    expect((await chat(h, key, { ip: '198.51.100.20' })).status).toBe(429);
    expect((await chat(h, key, { ip: '198.51.100.21' })).status).toBe(200);
  });

  test('a per-key limit holds whichever header carries the key', async () => {
    const { h, admin, key } = await gatewayWorld(mock);
    await setLimits(h, admin, { perKey: { window: 'minute', requests: 2, tokens: null, bucket: null } });
    expect((await chat(h, key)).status).toBe(200);
    expect((await chat(h, null, { headers: { 'x-api-key': key } })).status).toBe(200);
    expect((await chat(h, key)).status).toBe(429);
    expect((await chat(h, null, { headers: { 'x-api-key': key } })).status).toBe(429);
  });

  test('X-Forwarded-For is ignored unless the connecting address is a trusted proxy', () => {
    const none = parseTrustedProxies('').proxies;
    expect(clientAddress('203.0.113.9', '1.2.3.4', none)).toBe('203.0.113.9');
    const proxies = parseTrustedProxies('10.0.0.0/8').proxies;
    expect(clientAddress('203.0.113.9', '1.2.3.4', proxies)).toBe('203.0.113.9'); // not from the proxy
    expect(clientAddress('10.0.0.2', '1.2.3.4', proxies)).toBe('1.2.3.4');
    // A client prepending a fake hop does not choose its address: the right-most untrusted hop counts.
    expect(clientAddress('10.0.0.2', '9.9.9.9, 1.2.3.4', proxies)).toBe('1.2.3.4');
    expect(clientAddress('10.0.0.2', '1.2.3.4, 10.0.0.7', proxies)).toBe('1.2.3.4');
  });

  test('sign-in attempts are throttled per account across addresses', async () => {
    const { h } = await gatewayWorld(mock);
    for (let i = 0; i < 10; i++) await h.request('/api/auth/login', { method: 'POST', ip: `192.0.2.${i}`, json: { username: 'admin', password: `nope ${i}` } });
    expect((await h.request('/api/auth/login', { method: 'POST', ip: '192.0.2.99', json: { username: 'admin', password: 'nope again' } })).status).toBe(429);
  });
});
