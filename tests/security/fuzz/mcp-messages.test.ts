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

// SEC-021 (with SEC-002): MCP messages. JSON-RPC envelopes with things changed (ids, methods,
// params, versions, batches, notifications) and every tool called with arguments built from its
// own input schema, then changed. The server answers each one with a JSON-RPC result or error
// (or 202 for a notification), never a 500, and a tool failure is a tool error the model can read.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ApiSuccess, CreatedApiKey } from '@clawrouter/shared';
import type { Harness } from '../../support/harness.ts';
import { startMockProviders, type MockProviders } from '../../support/mock-providers.ts';
import { chat, gatewayWorld } from '../support.ts';
import { anyJson, expectHandledResponse, forAll, mutate, type Rng } from './fuzz.ts';

interface Tool { name: string; inputSchema: { properties: Record<string, { type?: string; enum?: unknown[]; minimum?: number; maximum?: number }>; required?: string[] } }

let mock: MockProviders;
let h: Harness;
let key: string;
let tools: Tool[];
let requestId: string;

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  h.request('/v1/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, ...headers }, json: body });

beforeAll(async () => {
  mock = await startMockProviders();
  const world = await gatewayWorld(mock);
  h = world.h;
  await h.request('/api/settings', { method: 'PUT', cookie: world.admin, json: { values: { mcpEnabled: 1 } } });
  key = ((await (await h.request('/api/api-keys', { method: 'POST', cookie: world.admin, json: { name: 'agent', mcpAccess: true } })).json()) as ApiSuccess<CreatedApiKey>).data.secret;
  // Something for the request tools to find.
  requestId = (await chat(h, world.key)).headers.get('x-request-id') ?? 'none';
  tools = ((await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as { result: { tools: Tool[] } }).result.tools;
});
afterAll(() => mock.stop());

/** Arguments that fit a tool's schema: what a well-behaved model sends. */
function argumentsFor(r: Rng, tool: Tool): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(tool.inputSchema.properties)) {
    if (!tool.inputSchema.required?.includes(name) && r.bool(0.4)) continue;
    if (p.enum) out[name] = r.pick(p.enum);
    else if (p.type === 'integer' || p.type === 'number') out[name] = (p.minimum ?? 0) + r.int(Math.max(1, Math.min(100, (p.maximum ?? 100) - (p.minimum ?? 0))));
    else if (p.type === 'boolean') out[name] = r.bool();
    else if (name === 'id') out[name] = r.bool(0.5) ? requestId : crypto.randomUUID();
    else if (/from|to|since|until/i.test(name)) out[name] = new Date(Date.UTC(2026, 10, 1 + r.int(30))).toISOString();
    else out[name] = r.pick(['openai', 'gpt-4o-mini', 'admin', 'LOGIN', 'SUCCESS', '', 'x']);
  }
  return out;
}

function message(r: Rng): unknown {
  const tool = r.pick(tools);
  const seeds: unknown[] = [
    { jsonrpc: '2.0', id: r.int(1000), method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fuzz', version: '1' } } },
    { jsonrpc: '2.0', id: `s-${r.int(1000)}`, method: 'ping' },
    { jsonrpc: '2.0', id: r.int(1000), method: 'tools/list', params: {} },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: r.int(1000), method: 'tools/call', params: { name: tool.name, arguments: argumentsFor(r, tool) } },
    { jsonrpc: '2.0', id: r.int(1000), method: 'tools/call', params: { name: tool.name, arguments: argumentsFor(r, tool) } },
    { jsonrpc: '2.0', id: r.int(1000), method: 'tools/call', params: { name: tool.name, arguments: argumentsFor(r, tool) } },
  ];
  const seed = r.pick(seeds);
  const roll = r.int(10);
  if (roll < 3) return seed;
  if (roll < 9) return mutate(r, seed);
  return r.bool() ? [seed, mutate(r, seed)] : anyJson(r, 3);
}

const RPC_ERRORS = new Set([-32700, -32600, -32601, -32602, -32603]);

describe('MCP messages', () => {
  test('every message gets a JSON-RPC answer, never a 500', async () => {
    let toolResults = 0;
    await forAll('mcp messages', 2500, (r) => ({
      body: message(r),
      headers: (r.bool(0.1) ? { 'mcp-protocol-version': r.pick(['2025-06-18', '2025-03-26', '1999-01-01', '', 'x'.repeat(500)]) } : {}) as Record<string, string>,
    }), async ({ body, headers }) => {
      h.logs.length = 0;
      h.clock.advance(600); // stay under the key's rate limit, so every call reaches the server
      const res = await rpc(body, headers);
      const text = await expectHandledResponse(res, h.logs);
      if (res.status === 202) return expect(text).toBe('');
      expect([200, 400]).toContain(res.status);
      const answer = JSON.parse(text) as { jsonrpc: string; id: unknown; result?: { content?: { type: string; text: unknown }[]; isError?: boolean }; error?: { code: number; message: unknown } };
      expect(answer.jsonrpc).toBe('2.0');
      expect('result' in answer !== 'error' in answer).toBe(true);
      if (answer.error) expect([RPC_ERRORS.has(answer.error.code), typeof answer.error.message]).toEqual([true, 'string']);
      if (answer.result?.content) {
        toolResults += 1;
        expect(answer.result.content.every((c) => c.type === 'text' && typeof c.text === 'string')).toBe(true);
      }
    });
    // Enough calls reached the tools themselves.
    expect(toolResults).toBeGreaterThan(100);
  }, 120_000);

  test('every tool was offered (or the fuzzing above missed some)', () => {
    expect(tools.length).toBeGreaterThanOrEqual(10);
  });
});
