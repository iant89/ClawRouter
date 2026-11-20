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

// SEC-027 corpus: denial of service: requests that hang the server, hold its capacity or exhaust it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { RateLimitConfigView } from '@clawrouter/shared';
import { startMockProviders, type MockProviders } from '../../support/mock-providers.ts';
import { createHarness, data, gatewayWorld } from '../support.ts';

let mock: MockProviders;
beforeAll(() => { mock = startMockProviders(); });
afterAll(() => mock.stop());
const answer = (body: string, type: string) => (async () => new Response(body, { status: 200, headers: { 'content-type': type } })) as unknown as typeof fetch;

describe('denial of service', () => {
  test('CASE-026: a provider stream piece that gives the client nothing does not stall the stream or hold its slot', async () => {
    const t = await gatewayWorld(mock);
    const current = await data<RateLimitConfigView>(await t.h.request('/api/rate-limits', { cookie: t.admin }));
    const { unknownModels: _u, updatedAt: _a, updatedBy: _b, ...rest } = current;
    expect((await t.h.request('/api/rate-limits', { method: 'PUT', cookie: t.admin, json: { ...rest, global: { ...rest.global, maxConcurrent: 1 } } })).status).toBe(200);
    const piece = (f: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: f }] } }] })}\n\n`;
    t.h.setProviderFetch(answer(`${piece({ arguments: '{}' })}${piece({})}data: [DONE]\n\n`, 'text/event-stream'));
    const send = () => t.h.request('/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${t.key}` }, json: { model: 'gpt-4o-mini', input: 'Hi', stream: true } });
    const first = await send();
    expect(await Promise.race([first.text(), Bun.sleep(2000).then(() => 'STALLED')])).toContain('response.completed');
    const second = await send();
    expect(second.status).toBe(200);
    await second.text();
  });

  test('CASE-027: oversized and deeply nested bodies are refused quickly with 4xx, never a crash', async () => {
    const h = createHarness();
    const cookie = await h.completeSetup();
    const started = performance.now();
    const big = await h.request('/api/auth/theme', { method: 'PUT', cookie, headers: { 'content-type': 'application/json' }, body: `{"theme":"${'x'.repeat(200_000)}"}` });
    expect(big.status).toBe(400);
    expect(await big.text()).toContain('too large');
    const deep = await h.request('/api/auth/theme', { method: 'PUT', cookie, headers: { 'content-type': 'application/json' }, body: `${'['.repeat(20_000)}${']'.repeat(20_000)}` });
    expect(deep.status).toBe(400);
    const wide = await h.request('/api/auth/theme', { method: 'PUT', cookie, headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i]))) });
    expect(wide.status).toBe(400);
    expect(performance.now() - started).toBeLessThan(3000);
    expect((await h.request('/api/auth/session', { cookie })).status).toBe(200);
  });
});
