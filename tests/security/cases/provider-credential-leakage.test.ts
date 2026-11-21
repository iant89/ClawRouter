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

// SEC-027 corpus: provider credentials and provider account details leaking.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ProviderInfo } from '@clawrouter/shared';
import { startMockProviders, type MockProviders } from '../../support/mock-providers.ts';
import { chat, data, gatewayWorld } from '../support.ts';

let mock: MockProviders;
beforeAll(() => { mock = startMockProviders(); });
afterAll(() => mock.stop());
beforeEach(() => { mock.mode = 'ok'; mock.badRequestFamilies.clear(); });

describe('provider credential leakage', () => {
  test("CASE-034: a provider's refusal text (account ids, upgrade links) reaches the log, never the client", async () => {
    const { h, key } = await gatewayWorld(mock);
    // What Groq answered live: the account's organization id and an upgrade link in the error text.
    h.setProviderFetch((async () => Response.json({ error: { message: 'Request too large on tokens per minute (TPM): Limit 6000, organization org_01case034 service tier on_demand. Upgrade at https://console.example/settings/billing', type: 'tokens', code: 'rate_limit_exceeded' } }, { status: 413 })) as unknown as typeof fetch);
    const res = await chat(h, key);
    const text = await res.text();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(text).not.toContain('org_01case034');
    expect(text).not.toContain('console.example');
    expect(JSON.stringify(h.logs)).toContain('org_01case034');
  });

  test('CASE-035: moving a provider to another host needs its key again: the stored key is never sent there', async () => {
    const { h, admin, provider } = await gatewayWorld(mock);
    const moved = await h.request(`/api/providers/${provider.id}`, { method: 'PATCH', cookie: admin, json: { endpoint: 'https://attacker.example/v1' } });
    expect(moved.status).toBe(400);
    expect((await data<ProviderInfo>(await h.request(`/api/providers/${provider.id}`, { cookie: admin }))).endpoint).toBe(`${mock.url}/openai/v1`);
  });

  test('CASE-036: the provider key is in no answer, export, audit record, log or clear-text row; failures do not repeat it', async () => {
    const { h, admin, provider, key } = await gatewayWorld(mock);
    mock.mode = 'auth';
    expect(await (await chat(h, key)).text()).not.toContain(mock.key);
    await h.request(`/api/providers/${provider.id}/test`, { method: 'POST', cookie: admin, json: {} });
    for (const path of ['/api/providers', `/api/providers/${provider.id}`, '/api/audit', '/api/logs', '/api/configuration/export', '/api/requests']) {
      expect([path, (await (await h.request(path, { cookie: admin })).text()).includes(mock.key)]).toEqual([path, false]);
    }
    expect(JSON.stringify([h.db.all('SELECT * FROM provider_credentials'), h.db.all('SELECT * FROM audit_log'), h.logs])).not.toContain(mock.key);
  });
});
