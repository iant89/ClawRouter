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

// SEC-021: JSON parsing. Every route that reads a body gets hostile JSON (deep, wide, broken,
// duplicate keys, prototype keys, lone surrogates, odd content types and bytes that are not
// UTF-8) from a caller allowed to use it. The answer is always a handled error or a success,
// never a 500, and nothing internal shows. The depth counter that runs before parsing must
// agree with the real depth of every valid document.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { jsonDepthExceeds } from '@clawrouter/gateway';
import type { ApiSuccess, CreatedApiKey } from '@clawrouter/shared';
import type { Harness } from '../../support/harness.ts';
import { startMockProviders, type MockProviders } from '../../support/mock-providers.ts';
import { createHarness, gatewayWorld } from '../support.ts';
import { anyJson, expectHandledResponse, forAll, hostileJsonText, mutateText, type Rng } from './fuzz.ts';

const depthOf = (v: unknown): number =>
  Array.isArray(v) ? 1 + Math.max(0, ...v.map(depthOf)) : v && typeof v === 'object' ? 1 + Math.max(0, ...Object.values(v).map(depthOf)) : 0;

describe('the depth counter (SEC-006) agrees with the parser', () => {
  test('for valid documents, and never throws on anything', async () => {
    await forAll('json depth', 3000, (r) => {
      const valid = r.bool(0.6);
      return valid ? JSON.stringify(anyJson(r, 6)) : mutateText(r, JSON.stringify(anyJson(r, 5)));
    }, (text) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        jsonDepthExceeds(text, 4);
        return;
      }
      const depth = depthOf(parsed);
      for (const max of [0, 1, 2, 3, 5, 8]) expect([max, jsonDepthExceeds(text, max)]).toEqual([max, depth > max]);
    });
  });

  test('strings holding brackets and escaped quotes are not counted', () => {
    expect(jsonDepthExceeds(JSON.stringify({ a: '[[[[{{{{"\\"[[[[' }), 1)).toBe(false);
    expect(jsonDepthExceeds(JSON.stringify(['\\', [['x']]]), 2)).toBe(true);
  });
});

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
/** Routes that end the caller's own session whatever the body says: they are fuzzed too, but the session is renewed after. */
const SIGNS_OUT = /^\/api\/auth\/logout$/;

const contentType = (r: Rng) => r.pick([
  'application/json', 'application/json', 'application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON',
  'application/json; charset=latin1', 'application/jsonx', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '',
]);

/** A body: hostile JSON text, raw bytes that are not UTF-8, or nothing. */
function body(r: Rng): string | Uint8Array {
  if (r.bool(0.08)) return Uint8Array.from({ length: r.int(200) }, () => r.int(256));
  if (r.bool(0.04)) return '';
  return hostileJsonText(r);
}

describe('every route that reads JSON survives hostile bodies', () => {
  const routes = createHarness().api.router.list().filter((r) => BODY_METHODS.has(r.method));
  let mock: MockProviders;
  let h: Harness;
  let admin: string;
  let key: string;
  let mcpKey: string;
  beforeAll(async () => {
    mock = await startMockProviders();
    const world = await gatewayWorld(mock);
    ({ h, admin, key } = world);
    await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { mcpEnabled: 1 } } });
    mcpKey = ((await (await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'agent', mcpAccess: true } })).json()) as ApiSuccess<CreatedApiKey>).data.secret;
  });
  afterAll(() => mock.stop());

  test.each(routes.map((r) => [`${r.method} ${r.pattern}`, r] as const))('%s', async (_name, route) => {
    await forAll(`json ${route.method} ${route.pattern}`, 25, (g) => ({
      path: route.pattern.replace(/:[a-zA-Z]+/g, () => g.pick(['x', '0', crypto.randomUUID(), '%00', '..%2F..', 'a'.repeat(300)])),
      type: contentType(g),
      body: body(g),
    }), async (input) => {
      h.logs.length = 0;
      h.clock.advance(600); // stay under the per-key rate limit, so every case reaches the parser
      const headers: Record<string, string> = input.type ? { 'content-type': input.type } : {};
      if (route.access === 'api_key') headers.authorization = `Bearer ${key}`;
      if (route.access === 'mcp') headers.authorization = `Bearer ${mcpKey}`;
      const consoleRoute = route.access !== 'api_key' && route.access !== 'mcp';
      const res = await h.request(input.path, { method: route.method, cookie: consoleRoute ? admin : undefined, headers, body: input.body as BodyInit });
      await expectHandledResponse(res, h.logs, [502, 503, 504]);
      if (consoleRoute && (res.status === 401 || SIGNS_OUT.test(route.pattern))) admin = await h.login();
    });
  }, 60_000);

  test('no prototype was polluted along the way', () => {
    const probe = {} as Record<string, unknown>;
    expect([probe.admin, probe.polluted, (Object.prototype as Record<string, unknown>).admin]).toEqual([undefined, undefined, undefined]);
  });

  test('the server still answers normally', async () => {
    const res = await h.request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, json: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] } });
    expect(res.status).toBe(200);
  });
});
