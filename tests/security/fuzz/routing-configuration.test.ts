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

// SEC-021: routing configuration. A full routing document (aliases with weighted targets,
// capabilities and their own policies) with things changed is saved through the API. A bad
// document is refused with a 400 and changes nothing; a saved one can be read back, previewed
// and used: routing every alias, every target and odd model names never fails with a 500.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ApiSuccess, RoutingConfigView } from '@clawrouter/shared';
import type { Harness } from '../../support/harness.ts';
import { startMockProviders, type MockProviders } from '../../support/mock-providers.ts';
import { actor, client, gatewayWorld } from '../support.ts';
import { anyString, expectHandledResponse, forAll, mutate } from './fuzz.ts';

let mock: MockProviders;
let h: Harness;
let admin: string;
let key: string;

const SEED = {
  defaultPolicy: { failover: 'RETRY_AND_FAILOVER', maxAttempts: 3, retriesPerTarget: 1 },
  aliases: [
    { name: 'fast', description: 'Quick answers', enabled: true, capabilities: ['CHAT'], policy: null, targets: [{ modelRef: 'openai/gpt-4o-mini', priority: 0, weight: 3 }, { modelRef: 'anthropic/claude-sonnet-4-5', priority: 0, weight: 1 }, { modelRef: 'openai/gpt-4o', priority: 1, weight: 1 }] },
    { name: 'any-chat', description: '', enabled: true, capabilities: ['CHAT', 'TOOL_USE'], targets: [], policy: { failover: 'FAILOVER_PROVIDER', maxAttempts: 2, retriesPerTarget: 0 } },
    { name: 'off', description: 'line one\nline two', enabled: false, capabilities: [], targets: [{ modelRef: 'openai/gpt-4o-mini', priority: 5, weight: 1000 }], policy: { failover: 'RETRY_SAME_PROVIDER', maxAttempts: 2, retriesPerTarget: 1 } },
  ],
};

const view = async () => ((await (await h.request('/api/routing', { cookie: admin })).json()) as ApiSuccess<RoutingConfigView>).data;

beforeAll(async () => {
  mock = await startMockProviders();
  ({ h, admin, key } = await gatewayWorld(mock));
  const anthropic = await h.providers.create(actor, { name: 'Anthropic', identifier: 'anthropic', kind: 'anthropic', endpoint: `${mock.url}/anthropic`, apiKey: mock.key }, client);
  h.models.create(actor, { providerId: anthropic.id, providerModelId: 'claude-sonnet-4-5', capabilities: ['CHAT', 'TOOL_USE'] }, client);
  h.models.create(actor, { providerId: h.providers.list().find((p) => p.identifier === 'openai')!.id, providerModelId: 'gpt-4o', capabilities: ['CHAT'] }, client);
});
afterAll(() => mock.stop());

const names = (config: RoutingConfigView) => [
  ...config.aliases.map((a) => a.name), ...config.aliases.flatMap((a) => a.targets.map((t) => t.modelRef)),
  'gpt-4o-mini', 'openai/gpt-4o-mini', 'nope/none', '/', '',
];

describe('routing configuration', () => {
  test('saved or refused, and a saved one routes without a 500', async () => {
    let saved = 0;
    await forAll('routing config', 400, (r) => ({ doc: r.bool(0.1) ? SEED : mutate(r, SEED), staleVersion: r.bool(0.05), pick: r.int(1000), name: anyString(r) }), async ({ doc, staleVersion, pick, name }) => {
      const before = await view();
      h.logs.length = 0;
      const body = doc && typeof doc === 'object' && !Array.isArray(doc) ? { ...doc, version: staleVersion ? before.version - 1 : before.version } : doc;
      const res = await h.request('/api/routing', { method: 'PUT', cookie: admin, json: body });
      await expectHandledResponse(res, h.logs);
      const after = await view();
      if (res.status !== 200) {
        expect([400, 409]).toContain(res.status);
        expect(after.version).toBe(before.version);
        return;
      }
      saved += 1;
      expect(after.version).toBe(before.version + 1);
      // Preview and use what was saved: an alias, a target, or something odd.
      const all = [...names(after), name];
      for (const model of [all[pick % all.length]!, all[(pick * 7) % all.length]!]) {
        h.logs.length = 0;
        h.clock.advance(600);
        await expectHandledResponse(await h.request('/api/routing/preview', { method: 'POST', cookie: admin, json: { model } }), h.logs, [502]); // 502 ROUTING_ERROR: nothing can serve that name
        await expectHandledResponse(await h.request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, json: { model, messages: [{ role: 'user', content: 'Hi' }] } }), h.logs, [502, 503, 504]);
      }
    });
    expect(saved).toBeGreaterThan(20);
  }, 120_000);

  test('the seed is a valid document (or the fuzzing above proves little)', async () => {
    const res = await h.request('/api/routing', { method: 'PUT', cookie: admin, json: { ...SEED, version: (await view()).version } });
    expect(res.status).toBe(200);
  });
});
