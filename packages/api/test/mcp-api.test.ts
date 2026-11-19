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
import type { ApiKeyInfo, ApiSuccess, CreatedApiKey } from '@clawrouter/shared';
import { createHarness, type Harness } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

let mock: MockProviders;
beforeAll(() => {
  mock = startMockProviders();
});
afterAll(() => mock.stop());

const actor = { id: 'u', username: 'admin' };
const client = { ip: null };
const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;

interface RpcAnswer {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}
interface ToolResult { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError: boolean }

let nextId = 1;
const post = (h: Harness, key: string | null, body: unknown, headers: Record<string, string> = {}) =>
  h.request('/v1/mcp', { method: 'POST', headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), accept: 'application/json, text/event-stream', ...headers }, json: body });
const call = async (h: Harness, key: string, method: string, params: unknown = {}) => {
  const res = await post(h, key, { jsonrpc: '2.0', id: nextId++, method, params });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/json');
  return (await res.json()) as RpcAnswer;
};
const tool = async (h: Harness, key: string, name: string, args: Record<string, unknown> = {}) => {
  const answer = await call(h, key, 'tools/call', { name, arguments: args });
  return answer.result as unknown as ToolResult;
};

/** An administrator with an MCP key, a Viewer with one, and a gateway-only key; one priced model. */
async function world() {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  // The MCP server is off by default (owner, 2026-11-16): these tests turn it on.
  expect((await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { mcpEnabled: 1 } } })).status).toBe(200);
  const openai = await h.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key, priority: 10 }, client);
  h.models.create(actor, { providerId: openai.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'], cost: { inputPerMTok: 2.5, outputPerMTok: 10 } }, client);
  const mcpKey = await data<CreatedApiKey>(await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'agent', mcpAccess: true } }));
  const gatewayKey = await data<CreatedApiKey>(await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'app' } }));
  const viewer = await h.addUser('vera', ['VIEWER']);
  const viewerKey = h.apiKeys.create({ id: viewer.id, username: 'vera' }, { name: 'vera agent', mcpAccess: true, expiry: { type: 'after', hours: 24 } }, client);
  return { h, admin, mcpKey, gatewayKey, viewer, viewerKey };
}

describe('MCP server: off by default, turned on and off in Settings (owner, 2026-11-16)', () => {
  test('a fresh installation: /v1/mcp does not exist, whatever the key; the session says it is off', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const key = await data<CreatedApiKey>(await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'agent', mcpAccess: true } }));
    for (const k of [key.secret, null, 'crk_00000000_' + 'x'.repeat(43)]) {
      expect((await post(h, k, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(404);
    }
    expect((await data<{ mcpServer: boolean }>(await h.request('/api/auth/session', { cookie: admin }))).mcpServer).toBe(false);
    // Probing it does not count as presenting invalid keys.
    expect(h.logs.some((l) => l.msg === 'mcp tool call')).toBe(false);
  });

  test('turning it on and off takes effect at once, is audited, and keys keep their MCP access', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const key = await data<CreatedApiKey>(await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'agent', mcpAccess: true } }));
    const set = (on: number) => h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { mcpEnabled: on } } });
    expect((await set(1)).status).toBe(200);
    expect((await call(h, key.secret, 'ping')).result).toEqual({});
    expect((await data<{ mcpServer: boolean }>(await h.request('/api/auth/session', { cookie: admin }))).mcpServer).toBe(true);
    expect((await set(0)).status).toBe(200);
    expect((await post(h, key.secret, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(404);
    expect((await set(1)).status).toBe(200);
    expect((await call(h, key.secret, 'ping')).result).toEqual({});
    expect(h.audit.search({ page: 1, pageSize: 10, action: 'SETTINGS_CHANGED' }).total).toBeGreaterThanOrEqual(3);
  });

  test('only someone who can change settings can turn it on', async () => {
    const h = createHarness();
    await h.completeSetup();
    await h.addUser('vera', ['VIEWER'], 'quiet meadow lantern 42');
    const viewer = await h.login('vera', 'quiet meadow lantern 42');
    expect((await h.request('/api/settings', { method: 'PUT', cookie: viewer, json: { values: { mcpEnabled: 1 } } })).status).toBe(403);
  });
});

describe('MCP server: who may connect', () => {
  test('no key 401; a console session is not enough; a key without MCP access 403', async () => {
    const { h, admin, gatewayKey } = await world();
    expect((await post(h, null, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    expect((await h.request('/v1/mcp', { method: 'POST', cookie: admin, json: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status).toBe(401);
    const res = await post(h, gatewayKey.secret, { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain('Turn on MCP access for it in API Access');
    expect((await post(h, 'crk_00000000_' + 'x'.repeat(43), { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
  });

  test('a disabled owner\'s key stops working; a revoked key too', async () => {
    const { h, admin, mcpKey, viewer, viewerKey } = await world();
    expect((await call(h, viewerKey.secret, 'ping')).result).toEqual({});
    await h.request(`/api/users/${viewer.id}`, { method: 'PATCH', cookie: admin, json: { status: 'DISABLED' } });
    expect((await post(h, viewerKey.secret, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    await h.request(`/api/api-keys/${mcpKey.key.id}`, { method: 'DELETE', cookie: admin });
    expect((await post(h, mcpKey.secret, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
  });

  test('turning MCP access on and off is audited; the key list shows it', async () => {
    const { h, admin, gatewayKey } = await world();
    const updated = await data<ApiKeyInfo>(await h.request(`/api/api-keys/${gatewayKey.key.id}`, { method: 'PATCH', cookie: admin, json: { mcpAccess: true } }));
    expect(updated.mcpAccess).toBe(true);
    expect((await call(h, gatewayKey.secret, 'ping')).result).toEqual({});
    await h.request(`/api/api-keys/${gatewayKey.key.id}`, { method: 'PATCH', cookie: admin, json: { mcpAccess: false } });
    expect((await post(h, gatewayKey.secret, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(403);
    const audit = h.audit.search({ page: 1, pageSize: 10, action: 'API_KEY_UPDATED', resourceId: gatewayKey.key.id }).items;
    expect(audit.map((a) => a.metadata?.mcpAccess)).toContainEqual({ from: false, to: true });
    expect(audit.map((a) => a.metadata?.mcpAccess)).toContainEqual({ from: true, to: false });
    const keys = await data<ApiKeyInfo[]>(await h.request('/api/api-keys', { cookie: admin }));
    expect(keys.find((k) => k.name === 'agent')?.mcpAccess).toBe(true);
    expect(keys.find((k) => k.name === 'app')?.mcpAccess).toBe(false);
    expect((await data<ApiKeyInfo>(await h.request(`/api/api-keys/${gatewayKey.key.id}`, { method: 'PATCH', cookie: admin, json: { mcpAccess: 'yes' } }))) as unknown).toBeUndefined();
  });

  test('own keys can have MCP access', async () => {
    const { h, admin } = await world();
    const own = await data<CreatedApiKey>(await h.request('/api/me/api-keys', { method: 'POST', cookie: admin, json: { name: 'mine', mcpAccess: true, expiry: { type: 'after', hours: 24 } } }));
    expect(own.key.mcpAccess).toBe(true);
    expect((await call(h, own.secret, 'ping')).result).toEqual({});
  });
});

describe('MCP server: protocol', () => {
  test('initialize: the asked version when supported, otherwise the newest; tools capability; instructions', async () => {
    const { h, mcpKey } = await world();
    const a = await call(h, mcpKey.secret, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(a.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'clawrouter', title: 'ClawRouter' } });
    expect(String(a.result!.instructions)).toContain('Nothing here changes ClawRouter');
    const b = await call(h, mcpKey.secret, 'initialize', { protocolVersion: '2024-01-01', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(b.result!.protocolVersion).toBe('2025-11-25');
  });

  test('notifications get 202 with no body; unknown methods -32601; ids are echoed', async () => {
    const { h, mcpKey } = await world();
    const n = await post(h, mcpKey.secret, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(n.status).toBe(202);
    expect(await n.text()).toBe('');
    const a = await post(h, mcpKey.secret, { jsonrpc: '2.0', id: 'abc', method: 'resources/list' });
    expect(await a.json()).toMatchObject({ jsonrpc: '2.0', id: 'abc', error: { code: -32601 } });
  });

  test('bad bodies: invalid JSON, batches, not JSON-RPC, unsupported protocol header', async () => {
    const { h, mcpKey } = await world();
    const auth = { authorization: `Bearer ${mcpKey.secret}`, 'content-type': 'application/json' };
    const bad = await h.request('/v1/mcp', { method: 'POST', headers: auth, body: '{"jsonrpc":' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: -32700 } });
    expect((await post(h, mcpKey.secret, [{ jsonrpc: '2.0', id: 1, method: 'ping' }])).status).toBe(400);
    expect((await post(h, mcpKey.secret, { id: 1, method: 'ping' })).status).toBe(400);
    const old = await post(h, mcpKey.secret, { jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': '2023-01-01' });
    expect(old.status).toBe(400);
    expect((await post(h, mcpKey.secret, { jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-protocol-version': '2025-06-18' })).status).toBe(200);
  });

  test('a cross-site Origin is refused (DNS rebinding); the same origin is fine', async () => {
    const { h, mcpKey } = await world();
    expect((await post(h, mcpKey.secret, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(h, mcpKey.secret, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'http://clawrouter.test' })).status).toBe(200);
  });

  test('GET (no event stream offered) is 405', async () => {
    const { h, mcpKey } = await world();
    const res = await h.request('/v1/mcp', { headers: { authorization: `Bearer ${mcpKey.secret}`, accept: 'text/event-stream' } });
    expect(res.status).toBe(405);
  });
});

describe('MCP server: tools follow the owner\'s permissions', () => {
  test('an administrator sees every tool, all read-only', async () => {
    const { h, mcpKey } = await world();
    const tools = (await call(h, mcpKey.secret, 'tools/list')).result!.tools as { name: string; annotations: { readOnlyHint: boolean }; inputSchema: { type: string } }[];
    expect(tools.map((t) => t.name).sort()).toEqual(['get_health', 'get_my_quota', 'get_rate_limits', 'get_request', 'get_usage', 'list_models', 'list_my_api_keys', 'list_providers', 'list_requests', 'search_audit']);
    expect(tools.every((t) => t.annotations.readOnlyHint && t.inputSchema.type === 'object')).toBe(true);
  });

  test('a Viewer does not see the audit log, and calling it anyway is an unknown tool', async () => {
    const { h, viewerKey } = await world();
    const names = ((await call(h, viewerKey.secret, 'tools/list')).result!.tools as { name: string }[]).map((t) => t.name);
    expect(names).not.toContain('search_audit');
    expect(names).toContain('get_usage');
    const a = await call(h, viewerKey.secret, 'tools/call', { name: 'search_audit', arguments: {} });
    expect(a.error).toMatchObject({ code: -32602 });
    expect(a.error!.message).toContain('Unknown tool "search_audit"');
  });

  test('permissions are read on every call: removing a role removes its tools at once', async () => {
    const { h, admin, viewer, viewerKey } = await world();
    expect((await tool(h, viewerKey.secret, 'get_usage')).isError).toBe(false);
    await h.request(`/api/users/${viewer.id}/roles`, { method: 'PUT', cookie: admin, json: { roles: [] } });
    const names = ((await call(h, viewerKey.secret, 'tools/list')).result!.tools as { name: string }[]).map((t) => t.name);
    expect(names.sort()).toEqual(['get_my_quota', 'list_my_api_keys']);
    expect((await call(h, viewerKey.secret, 'tools/call', { name: 'get_usage' })).error?.code).toBe(-32602);
  });
});

describe('MCP server: what the tools answer', () => {
  test('usage, requests and one request after a gateway call', async () => {
    const { h, mcpKey, gatewayKey } = await world();
    const res = await h.request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${gatewayKey.secret}` }, json: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hello' }] } });
    expect(res.status).toBe(200);
    const requestId = res.headers.get('x-request-id')!;

    const usage = await tool(h, mcpKey.secret, 'get_usage', { from: '24h', groupBy: 'apiKey' });
    expect(usage.isError).toBe(false);
    expect(usage.structuredContent).toMatchObject({ groupBy: 'apiKey', totals: { requests: 1 } });
    expect(usage.structuredContent).not.toHaveProperty('series');
    expect(JSON.parse(usage.content[0]!.text)).toEqual(usage.structuredContent!);
    expect((await tool(h, mcpKey.secret, 'get_usage', { includeSeries: true })).structuredContent).toHaveProperty('series');

    const list = await tool(h, mcpKey.secret, 'list_requests', { limit: 5 });
    expect(list.structuredContent).toMatchObject({ total: 1, page: 1, pageSize: 5, more: false, items: [{ id: requestId, status: 'COMPLETED', modelRef: 'openai/gpt-4o-mini' }] });
    const one = await tool(h, mcpKey.secret, 'get_request', { id: requestId });
    expect(one.structuredContent).toMatchObject({ id: requestId, attempts: 1 });
    expect(JSON.stringify(one)).not.toContain('Hello'); // metadata only
  });

  test('providers, models, health, rate limits, audit, quota, own keys: no secret anywhere', async () => {
    const { h, mcpKey } = await world();
    const answers: ToolResult[] = [];
    for (const [name, args] of [['list_providers', {}], ['list_models', { q: 'gpt' }], ['get_health', {}], ['get_rate_limits', {}], ['search_audit', { action: 'API_KEY_CREATED' }], ['get_my_quota', {}], ['list_my_api_keys', {}]] as const) {
      const r = await tool(h, mcpKey.secret, name, args);
      expect(r.isError).toBe(false);
      answers.push(r);
    }
    expect(answers[0]!.structuredContent!.items).toMatchObject([{ name: 'OpenAI', identifier: 'openai' }]);
    expect(answers[1]!.structuredContent).toMatchObject({ total: 1, items: [{ ref: 'openai/gpt-4o-mini' }] });
    expect(answers[2]!.structuredContent).toHaveProperty('checks');
    expect(answers[4]!.structuredContent!.total).toBe(3); // agent, app, and the Viewer's key
    expect(answers[6]!.structuredContent!.items).toMatchObject([{ name: 'agent', mcpAccess: true }, { name: 'app', mcpAccess: false }]);
    const everything = JSON.stringify(answers);
    expect(everything).not.toContain(mock.key);
    expect(everything).not.toContain(mcpKey.secret);
    expect(everything).not.toMatch(/crk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}/);
  });

  test('wrong arguments come back as tool errors the model can act on', async () => {
    const { h, mcpKey } = await world();
    const a = await tool(h, mcpKey.secret, 'list_requests', { status: 'BROKEN' });
    expect(a.isError).toBe(true);
    expect(a.content[0]!.text).toContain('"status" must be one of');
    expect((await tool(h, mcpKey.secret, 'list_requests', { limit: 500 })).content[0]!.text).toContain('from 1 to 50');
    expect((await tool(h, mcpKey.secret, 'get_usage', { from: 'last tuesday' })).content[0]!.text).toContain('look-back');
    expect((await tool(h, mcpKey.secret, 'get_request', {})).content[0]!.text).toContain('"id" is required');
    const missing = await tool(h, mcpKey.secret, 'get_request', { id: 'nope' });
    expect(missing.isError).toBe(true);
    expect((await call(h, mcpKey.secret, 'tools/call', { name: 'get_usage', arguments: [1] })).error?.code).toBe(-32602);
  });

  test('tool calls count against the key\'s rate limit', async () => {
    const { h, admin, mcpKey } = await world();
    await h.request(`/api/api-keys/${mcpKey.key.id}`, { method: 'PATCH', cookie: admin, json: { rateLimit: { window: 'minute', requests: 2, tokens: null, bucket: null } } });
    expect((await tool(h, mcpKey.secret, 'get_health')).isError).toBe(false);
    expect((await tool(h, mcpKey.secret, 'get_health')).isError).toBe(false);
    const third = await post(h, mcpKey.secret, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_health' } });
    expect(third.status).toBe(429);
    // Listing tools is free.
    expect((await call(h, mcpKey.secret, 'tools/list')).result).toHaveProperty('tools');
  });

  test('each tool call is logged with the tool, key and outcome', async () => {
    const { h, mcpKey } = await world();
    await tool(h, mcpKey.secret, 'get_health');
    await tool(h, mcpKey.secret, 'list_requests', { status: 'BROKEN' });
    const calls = h.logs.filter((l) => l.msg === 'mcp tool call');
    expect(calls.map((l) => [l.tool, l.prefix, l.outcome])).toEqual([['get_health', mcpKey.key.prefix, 'ok'], ['list_requests', mcpKey.key.prefix, 'tool_error']]);
  });
});
