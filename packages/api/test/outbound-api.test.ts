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

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ApiSuccess, ConnectionTestResult } from '@clawrouter/shared';
import { createHarness } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

// The outbound network policy (SEC-001, SEC-007) through the HTTP API. The harness allows loopback
// (the mock providers) and 10.0.0.0/8; every other name "resolves" to a public address.
let mock: MockProviders;
beforeAll(() => {
  mock = startMockProviders();
});
afterAll(() => mock.stop());

const create = (h: ReturnType<typeof createHarness>, cookie: string, endpoint: string, identifier = 'probe') =>
  h.request('/api/providers', { method: 'POST', cookie, json: { name: identifier, identifier, kind: 'openai_compatible', endpoint } });

describe('outbound network policy (API)', () => {
  test.each([
    ['https://192.168.1.5/v1', 'private network'],
    ['https://172.16.0.1/v1', 'private network'],
    ['http://169.254.169.254/latest', 'never reachable'],
    ['https://metadata.google.internal/v1', 'never reachable'],
    ['https://[fe80::1]/v1', 'link-local'],
    ['https://[::ffff:192.168.0.1]/v1', 'private network'],
    ['https://3232235777:8080/v1', 'private network'], // 192.168.1.1, spelled as a number
    ['https://0.0.0.0/v1', 'this network'],
    ['http://api.example.test/v1', 'plain http'],
  ])('refuses %s with a field error', async (endpoint, text) => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const res = await create(h, admin, endpoint);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { issues: { path: string; message: string }[] } } };
    expect(body.error.details.issues).toContainEqual({ path: 'endpoint', message: expect.stringContaining(text) });
    expect(body.error.details.issues[0]!.message).toContain('not allowed');
  });

  test('allows public https and allowlisted local endpoints, and calls them', async () => {
    const h = createHarness();
    h.setProviderFetch(fetch);
    const admin = await h.completeSetup();
    expect((await create(h, admin, 'https://api.example.test/v1', 'public')).status).toBe(201);
    expect((await create(h, admin, 'http://10.0.0.5:8000/v1', 'lan')).status).toBe(201);
    const local = (await (await h.request('/api/providers', {
      method: 'POST', cookie: admin, json: { name: 'Local', identifier: 'local', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key },
    })).json()) as ApiSuccess<{ id: string }>;
    const result = (await (await h.request(`/api/providers/${local.data.id}/test`, { method: 'POST', cookie: admin, json: {} })).json()) as ApiSuccess<ConnectionTestResult>;
    expect(result.data.ok).toBe(true);
  });

  test('an endpoint stored before the policy (or edited in the database) is refused at call time, before any connection', async () => {
    const h = createHarness();
    const calls: string[] = [];
    h.setProviderFetch((async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('{}');
    }) as typeof fetch);
    const admin = await h.completeSetup();
    const created = (await (await create(h, admin, 'https://api.example.test/v1', 'moved')).json()) as ApiSuccess<{ id: string }>;
    h.db.run("UPDATE providers SET endpoint = 'https://169.254.169.254/v1' WHERE id = ?", [created.data.id]);
    const result = (await (await h.request(`/api/providers/${created.data.id}/test`, { method: 'POST', cookie: admin, json: {} })).json()) as ApiSuccess<ConnectionTestResult>;
    expect(result.data.ok).toBe(false);
    expect(result.data.message).toContain('Blocked by the outbound network policy');
    expect(calls).toEqual([]);
  });
});
