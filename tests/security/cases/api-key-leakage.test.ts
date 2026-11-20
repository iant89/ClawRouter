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

// SEC-027 corpus: API key secrets leaking after creation.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startMockProviders, type MockProviders } from '../../support/mock-providers.ts';
import { chat, gatewayWorld } from '../support.ts';

let mock: MockProviders;
beforeAll(() => { mock = startMockProviders(); });
afterAll(() => mock.stop());

describe('api-key leakage', () => {
  test('CASE-015: after creation the secret is in no answer, log, audit record, request record or stored row', async () => {
    const { h, admin, key, keyId } = await gatewayWorld(mock);
    expect((await chat(h, key)).status).toBe(200);
    expect((await chat(h, `${key}x`)).status).toBe(401);
    for (const path of ['/api/api-keys', `/api/api-keys/${keyId}`, '/api/me/api-keys', '/api/audit', '/api/logs', '/api/requests', '/api/configuration/export']) {
      const text = await (await h.request(path, { cookie: admin })).text();
      expect([path, text.includes(key)]).toEqual([path, false]);
    }
    const stored = JSON.stringify([h.db.all('SELECT * FROM api_keys'), h.db.all('SELECT * FROM audit_log'), h.db.all('SELECT * FROM requests'), h.logs]);
    expect(stored).not.toContain(key);
    expect(stored).not.toContain(key.slice(-20));
  });

  test('CASE-016: a key in the query string is not accepted (URLs end up in proxy logs and browser history)', async () => {
    const { h, key } = await gatewayWorld(mock);
    for (const q of ['api_key', 'key', 'token', 'access_token', 'authorization']) {
      const res = await h.request(`/v1/models?${q}=${encodeURIComponent(key)}`, {});
      expect([q, res.status]).toEqual([q, 401]);
    }
  });
});
