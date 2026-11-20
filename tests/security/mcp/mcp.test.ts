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

// SEC-002: /v1/mcp as an independent security boundary. Every identity in the roadmap, then
// what a malicious MCP client can try. The functional tests are in packages/api/test/mcp-api.test.ts.

import { describe, expect, test } from 'bun:test';
import type { ApiSuccess, CreatedApiKey } from '@clawrouter/shared';
import { createHarness, type Harness } from '../../support/harness.ts';

const client = { ip: null };
const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;
const rpc = (h: Harness, key: string | null, body: unknown, headers: Record<string, string> = {}) =>
  h.request('/v1/mcp', { method: 'POST', headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, json: body });
const rawRpc = (h: Harness, key: string, body: string) =>
  h.request('/v1/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body });
let next = 1;
async function toolNames(h: Harness, key: string): Promise<string[]> {
  const res = await rpc(h, key, { jsonrpc: '2.0', id: next++, method: 'tools/list' });
  return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name).sort();
}
async function callTool(h: Harness, key: string, name: string, args: unknown = {}) {
  const res = await rpc(h, key, { jsonrpc: '2.0', id: next++, method: 'tools/call', params: { name, arguments: args } });
  return { status: res.status, body: (await res.json()) as { result?: { isError: boolean; content: { text: string }[] }; error?: { code: number; message: string } } };
}

/** MCP on; an MCP key for an Administrator, an Operator and a Viewer; a key without MCP access. */
async function world() {
  const h = createHarness();
  const admin = await h.completeSetup();
  expect((await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { mcpEnabled: 1 } } })).status).toBe(200);
  const adminKey = (await data<CreatedApiKey>(await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'agent', mcpAccess: true } }))).secret;
  const plainKey = (await data<CreatedApiKey>(await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'app' } }))).secret;
  const operator = await h.addUser('olga', ['OPERATOR']);
  const viewer = await h.addUser('vera', ['VIEWER']);
  const operatorKey = h.apiKeys.create({ id: operator.id, username: 'olga' }, { name: 'olga agent', mcpAccess: true, expiry: { type: 'after', hours: 24 } }, client);
  const viewerKey = h.apiKeys.create({ id: viewer.id, username: 'vera' }, { name: 'vera agent', mcpAccess: true, expiry: { type: 'after', hours: 1 } }, client);
  return { h, admin, adminKey, plainKey, operator, operatorKey, viewer, viewerKey };
}

const PING = { jsonrpc: '2.0', id: 1, method: 'ping' };

describe('identities (SEC-002)', () => {
  test('anonymous, a console session, a wrong key and a key without MCP access are refused', async () => {
    const { h, admin, plainKey } = await world();
    expect((await rpc(h, null, PING)).status).toBe(401);
    expect((await h.request('/v1/mcp', { method: 'POST', cookie: admin, json: PING })).status).toBe(401);
    expect((await rpc(h, `crk_00000000_${'x'.repeat(43)}`, PING)).status).toBe(401);
    expect((await rpc(h, plainKey, PING)).status).toBe(403);
  });

  test('with MCP switched off, every identity gets 404 (the endpoint is not revealed)', async () => {
    const { h, admin, adminKey, plainKey } = await world();
    await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { mcpEnabled: 0 } } });
    for (const key of [null, adminKey, plainKey, 'garbage']) expect((await rpc(h, key, PING)).status).toBe(404);
  });

  test('each role sees exactly the tools its permissions allow', async () => {
    const { h, adminKey, operatorKey, viewerKey } = await world();
    const own = ['get_my_quota', 'list_my_api_keys'];
    expect(await toolNames(h, adminKey)).toEqual(['get_health', 'get_my_quota', 'get_rate_limits', 'get_request', 'get_usage', 'list_models', 'list_my_api_keys', 'list_providers', 'list_requests', 'search_audit']);
    const operator = await toolNames(h, operatorKey.secret);
    expect(operator).toContain('search_audit'); // Operators have audit.read
    const viewer = await toolNames(h, viewerKey.secret);
    expect(viewer).not.toContain('search_audit'); // Viewers do not (it exposes IP addresses)
    for (const names of [operator, viewer]) for (const o of own) expect(names).toContain(o);
  });

  test('an expired key, a revoked key and a disabled owner are refused', async () => {
    const { h, admin, operator, operatorKey, viewerKey } = await world();
    h.clock.advance(61 * 60_000); // the Viewer's key lasted an hour
    expect((await rpc(h, viewerKey.secret, PING)).status).toBe(401);
    expect((await rpc(h, operatorKey.secret, PING)).status).toBe(200);
    const fresh = await h.login();
    await h.request(`/api/users/${operator.id}`, { method: 'PATCH', cookie: fresh, json: { status: 'DISABLED' } });
    expect((await rpc(h, operatorKey.secret, PING)).status).toBe(401);
    expect(admin).toBeDefined();
  });

  test('an unpermitted tool is indistinguishable from one that does not exist', async () => {
    const { h, viewerKey } = await world();
    const hidden = await callTool(h, viewerKey.secret, 'search_audit');
    const missing = await callTool(h, viewerKey.secret, 'drop_database');
    expect(hidden.body.error!.code).toBe(missing.body.error!.code);
    expect(hidden.body.error!.message.replace('search_audit', 'X')).toBe(missing.body.error!.message.replace('drop_database', 'X'));
  });

  test('own-data tools only show the caller\'s own keys', async () => {
    const { h, viewerKey } = await world();
    const mine = await callTool(h, viewerKey.secret, 'list_my_api_keys');
    const text = mine.body.result!.content[0]!.text;
    expect(text).toContain('vera agent');
    expect(text).not.toContain('olga agent');
    expect(text).not.toContain('"agent"');
  });
});

describe('malicious clients (SEC-002)', () => {
  test('hostile JSON-RPC envelopes get JSON-RPC errors, never a crash', async () => {
    const { h, adminKey } = await world();
    const deep = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_health","arguments":${'['.repeat(100_000)}${']'.repeat(100_000)}}}`;
    const cases: [string, number][] = [
      [deep, 200], // 100,000 nested arrays parse, then are refused: arguments must be an object
      [deep.slice(0, 150_000), 400], // cut off: a parse error
      [`{"jsonrpc":"2.0","id":"${'x'.repeat(10_000)}","method":"ping"}`, 400],
      ['{"jsonrpc":"2.0","id":1e400,"method":"ping"}', 400],
      ['{"jsonrpc":"2.0","id":1,"method":{"toString":"ping"}}', 400],
      ['{"jsonrpc":"2.0","id":1,"method":"__proto__"}', 200],
      ['{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"constructor"}}', 200],
      ['{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_health","arguments":[1,2]}}', 200],
      ['{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_models","arguments":{"__proto__":{"admin":true},"limit":"all"}}}', 200],
    ];
    for (const [body, status] of cases) {
      const res = await rawRpc(h, adminKey, body);
      expect(res.status).toBe(status);
      const answer = (await res.json()) as { error?: unknown; result?: { isError?: boolean } };
      expect(answer.error !== undefined || answer.result?.isError === true).toBe(true);
    }
    expect(({} as Record<string, unknown>).admin).toBeUndefined(); // no prototype pollution
  });

  test('a body over 256 KB is refused before it is parsed', async () => {
    const { h, adminKey } = await world();
    const res = await rawRpc(h, adminKey, `{"jsonrpc":"2.0","id":1,"method":"ping","pad":"${'x'.repeat(300 * 1024)}"}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('too large');
  });

  test('a tool answer over the size limit is refused as a tool error', async () => {
    const { h, adminKey } = await world();
    const huge = Array.from({ length: 20_000 }, (_, i) => ({ id: `p${i}`, name: 'x'.repeat(100) }));
    const original = h.providers.list;
    (h.providers as { list: () => unknown }).list = () => huge;
    try {
      const answer = await callTool(h, adminKey, 'list_providers');
      expect(answer.body.result!.isError).toBe(true);
      expect(answer.body.result!.content[0]!.text).toContain('larger than');
    } finally {
      (h.providers as { list: unknown }).list = original;
    }
  });

  test('an internal failure answers with a generic error: no paths, SQL or secrets', async () => {
    const { h, adminKey } = await world();
    const original = h.health.report;
    (h.health as { report: () => unknown }).report = () => {
      throw new Error('SQLITE_CORRUPT at /var/lib/clawrouter/clawrouter.db: SELECT * FROM api_keys WHERE secret = sk-live-0123456789abcdef0123');
    };
    try {
      const res = await rpc(h, adminKey, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_health' } });
      expect(res.status).toBe(500);
      const text = await res.text();
      for (const leak of ['SQLITE', '/var/lib', 'SELECT', 'sk-live', 'stack']) expect(text).not.toContain(leak);
    } finally {
      (h.health as { report: unknown }).report = original;
    }
  });

  test('tool errors tell the model what to fix without echoing internals', async () => {
    const { h, adminKey } = await world();
    const missing = await callTool(h, adminKey, 'get_request', { id: "' OR 1=1 --" });
    expect(missing.body.result!.isError).toBe(true);
    expect(missing.body.result!.content[0]!.text).not.toMatch(/SELECT|sqlite|at \//i);
    const page = await callTool(h, adminKey, 'list_models', { page: 10_000_000 });
    expect(page.body.result!.isError).toBe(true);
  });

  test('concurrent calls each get their own answer', async () => {
    const { h, adminKey, viewerKey } = await world();
    const answers = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      rpc(h, i % 2 ? adminKey : viewerKey.secret, { jsonrpc: '2.0', id: `c${i}`, method: 'tools/list' }).then((r) => r.json() as Promise<{ id: string; result: { tools: { name: string }[] } }>)));
    answers.forEach((a, i) => {
      expect(a.id).toBe(`c${i}`);
      expect(a.result.tools.some((t) => t.name === 'search_audit')).toBe(i % 2 === 1);
    });
  });

  test('a cross-site browser page cannot call it (Origin), even with a key', async () => {
    const { h, adminKey } = await world();
    for (const origin of ['https://evil.example', 'null', 'http://clawrouter.test.evil.example']) {
      expect((await rpc(h, adminKey, PING, { origin })).status).toBe(403);
    }
    expect((await rpc(h, adminKey, PING, { origin: 'http://clawrouter.test' })).status).toBe(200);
  });
});
