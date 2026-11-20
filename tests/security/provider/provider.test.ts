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

// SEC-012 provider: provider keys are write-only and never follow a provider to a new host, and
// what a provider says never reaches the client word for word.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ProviderInfo } from '@clawrouter/shared';
import { startMockProviders, type MockProviders } from '../../support/mock-providers.ts';
import { chat, data, gatewayWorld } from '../support.ts';

let mock: MockProviders;
beforeAll(() => { mock = startMockProviders(); });
afterAll(() => mock.stop());
beforeEach(() => { mock.mode = 'ok'; mock.badRequestFamilies.clear(); mock.failFamilies.clear(); });

describe('provider credentials (SEC-012)', () => {
  test('the key is write-only: no response, audit record, log or stored row shows it in clear', async () => {
    const { h, admin, provider } = await gatewayWorld(mock);
    const one = await data<ProviderInfo>(await h.request(`/api/providers/${provider.id}`, { cookie: admin }));
    expect(one.credential).toMatchObject({ configured: true, hint: expect.stringContaining(mock.key.slice(-4)) });
    for (const path of ['/api/providers', `/api/providers/${provider.id}`, '/api/audit', '/api/logs', '/api/configuration/export']) {
      expect([path, (await (await h.request(path, { cookie: admin })).text()).includes(mock.key)]).toEqual([path, false]);
    }
    const everything = JSON.stringify(h.db.all("SELECT * FROM provider_credentials")) + JSON.stringify(h.db.all('SELECT * FROM audit_log')) + JSON.stringify(h.logs);
    expect(everything).not.toContain(mock.key);
  });

  test('moving a provider to another host needs the key again, so it is never sent to the new host', async () => {
    const { h, admin, provider } = await gatewayWorld(mock);
    const moved = await h.request(`/api/providers/${provider.id}`, { method: 'PATCH', cookie: admin, json: { endpoint: 'https://attacker.example/v1' } });
    expect(moved.status).toBe(400);
    expect((await data<ProviderInfo>(await h.request(`/api/providers/${provider.id}`, { cookie: admin }))).endpoint).toBe(`${mock.url}/openai/v1`);
    // A path change on the same host keeps the key.
    expect((await h.request(`/api/providers/${provider.id}`, { method: 'PATCH', cookie: admin, json: { endpoint: `${mock.url}/openai/v1/` } })).status).toBe(200);
  });

  test('an Operator may manage providers but never read a key back', async () => {
    const { h, provider } = await gatewayWorld(mock);
    await h.addUser('olga', ['OPERATOR']);
    const olga = await h.login('olga');
    const text = await (await h.request(`/api/providers/${provider.id}`, { cookie: olga })).text();
    expect(text).not.toContain(mock.key);
  });
});

describe('provider answers are untrusted (SEC-012)', () => {
  test('a provider\'s error text and its authentication failure are not passed to the client', async () => {
    const { h, key } = await gatewayWorld(mock);
    mock.badRequestFamilies.add('openai');
    const rejected = await chat(h, key);
    expect(await rejected.text()).not.toContain('maximum context length is 10 tokens');
    mock.badRequestFamilies.clear();
    mock.mode = 'auth';
    const auth = await chat(h, key);
    expect(auth.status).toBeGreaterThanOrEqual(500);
    const text = await auth.text();
    expect(text).not.toContain(mock.key);
    expect(text).not.toContain(mock.url);
  });

  test('a provider that answers garbage gets a clean gateway error, not a crash or its bytes', async () => {
    const { h, key } = await gatewayWorld(mock);
    mock.mode = 'garbage';
    const res = await chat(h, key);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBeString();
  });
});
