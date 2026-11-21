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

// SEC-027 corpus: an agent gaining more through /v1/mcp than its key's owner holds.

import { describe, expect, test } from 'bun:test';
import type { ApiSuccess, CreatedApiKey } from '@clawrouter/shared';
import { createHarness, type Harness } from '../../support/harness.ts';

let id = 1;
const rpc = async (h: Harness, key: string, method: string, params?: unknown) =>
  (await (await h.request('/v1/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}` }, json: { jsonrpc: '2.0', id: id++, method, ...(params ? { params } : {}) } })).json()) as {
    result?: { tools?: { name: string; annotations: Record<string, boolean>; inputSchema: unknown }[]; isError?: boolean; content?: { text: string }[] }; error?: { message: string };
  };

async function world() {
  const h = createHarness();
  const admin = await h.completeSetup();
  expect((await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { mcpEnabled: 1 } } })).status).toBe(200);
  const olga = await h.addUser('olga', ['OPERATOR']);
  const key = h.apiKeys.create({ id: olga.id, username: 'olga' }, { name: 'agent', mcpAccess: true, expiry: { type: 'after', hours: 24 } }, { ip: null }).secret;
  return { h, admin, olga, key };
}

describe('mcp privilege escalation', () => {
  test('CASE-019: a tool stops working as soon as the owner loses the permission (no cached rights)', async () => {
    const { h, admin, olga, key } = await world();
    const before = await rpc(h, key, 'tools/call', { name: 'list_providers', arguments: {} });
    expect(before.result).toBeDefined();
    expect(before.result!.isError).toBeFalsy();
    expect((await rpc(h, key, 'tools/list')).result!.tools!.map((t) => t.name)).toContain('search_audit');
    expect((await h.request(`/api/users/${olga.id}/roles`, { method: 'PUT', cookie: admin, json: { roles: ['VIEWER'] } })).status).toBe(200);
    const tools = (await rpc(h, key, 'tools/list')).result!.tools!.map((t) => t.name);
    expect(tools).not.toContain('search_audit');
    const audit = await rpc(h, key, 'tools/call', { name: 'search_audit', arguments: {} });
    expect(audit.error ?? audit.result?.isError).toBeTruthy();
    expect((await h.request(`/api/users/${olga.id}/roles`, { method: 'PUT', cookie: admin, json: { roles: [] } })).status).toBe(200);
    const none = await rpc(h, key, 'tools/call', { name: 'list_providers', arguments: {} });
    expect(none.error ?? none.result?.isError).toBeTruthy();
  });

  test('CASE-020: every tool only reads; none creates a key or returns a secret, even for an administrator', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { mcpEnabled: 1 } } });
    const key = ((await (await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'agent', mcpAccess: true } })).json()) as ApiSuccess<CreatedApiKey>).data.secret;
    const tools = (await rpc(h, key, 'tools/list')).result!.tools!;
    expect(tools.length).toBeGreaterThan(5);
    for (const t of tools) {
      expect([t.name, t.annotations.readOnlyHint, t.annotations.destructiveHint]).toEqual([t.name, true, false]);
      expect(t.name).not.toMatch(/^(create|update|delete|set|revoke|approve|import|rotate)_/);
    }
    for (const t of tools) {
      const r = await rpc(h, key, 'tools/call', { name: t.name, arguments: {} });
      expect([t.name, JSON.stringify(r).includes(key)]).toEqual([t.name, false]);
    }
    const before = h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM api_keys')!.n;
    expect((await rpc(h, key, 'tools/call', { name: 'create_api_key', arguments: { name: 'x' } })).error ?? true).toBeTruthy();
    expect(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM api_keys')!.n).toBe(before);
  });
});
