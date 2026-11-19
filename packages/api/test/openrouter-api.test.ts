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

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ApiSuccess, CreatedApiKey, DiscoveredModelInfo, RequestRecord, UsageReport } from '@clawrouter/shared';
import { createHarness } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

let mock: MockProviders;
beforeAll(() => {
  mock = startMockProviders();
});
afterAll(() => mock.stop());
beforeEach(() => {
  mock.mode = 'ok';
});

const json = async <T>(res: Response) => (await res.json()) as T;
const data = async <T>(res: Response) => (await json<ApiSuccess<T>>(res)).data;

async function world() {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const provider = await data<{ id: string }>(await h.request('/api/providers', {
    method: 'POST', cookie: admin, json: { name: 'OpenRouter', identifier: 'openrouter', kind: 'openrouter', endpoint: `${mock.url}/openrouter/api/v1`, apiKey: mock.key },
  }));
  const key = (await data<CreatedApiKey>(await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'apps' } }))).secret;
  const chat = (body: unknown) => h.request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, json: body });
  return { h, admin, provider, chat };
}

describe('OpenRouter provider', () => {
  test('discovery offers chat models with their limits, vision, tools and prices; batch, image and expired models are not', async () => {
    const { h, admin, provider } = await world();
    const found = await data<DiscoveredModelInfo[]>(await h.request(`/api/providers/${provider.id}/models/discover`, { cookie: admin }));
    expect(found.map((m) => [m.providerModelId, m.capabilities, m.contextLength, m.cost])).toEqual([
      ['acme/plain-chat', ['CHAT'], 32768, { inputPerMTok: 1, outputPerMTok: 2 }],
      ['anthropic/claude-haiku-5.5', ['CHAT', 'VISION', 'TOOL_USE'], 1000000, { inputPerMTok: 0.1, outputPerMTok: 0.5 }],
      ['anthropic/claude-haiku-5.5:batch', [], 1000000, { inputPerMTok: 0.05, outputPerMTok: 0.25 }],
      ['google/gemini-3.1-flash-image', [], 65536, { inputPerMTok: 0.5, outputPerMTok: 3 }],
      ['nvidia/nemotron-3.5-lightning:free', ['CHAT', 'TOOL_USE'], 1000000, { inputPerMTok: 0, outputPerMTok: 0 }],
    ]);
  });

  test("the request's cost is what OpenRouter charged, not the estimate, in history and usage, for replies and streams", async () => {
    const { h, admin, provider, chat } = await world();
    await h.request(`/api/providers/${provider.id}/models/import`, { method: 'POST', cookie: admin, json: { providerModelIds: ['anthropic/claude-haiku-5.5'] } });
    const plain = await chat({ model: 'openrouter/anthropic/claude-haiku-5.5', messages: [{ role: 'user', content: 'Hi' }] });
    expect(plain.status).toBe(200);
    // Reasoning arrives in its own field and never becomes the answer.
    expect((await json<{ choices: { message: { content: string } }[] }>(plain)).choices[0]!.message.content).toBe('Hello from OpenRouter');
    const streamed = await chat({ model: 'openrouter/anthropic/claude-haiku-5.5', stream: true, messages: [{ role: 'user', content: 'Hi' }] });
    expect(await streamed.text()).toContain('"content":"Hi "');

    // The model's list prices (0.1 / 0.5 per million) would estimate 0.0000037 and 0.0000022; OpenRouter charged 0.0000041 and 0.0000029.
    const history = await data<RequestRecord[]>(await h.request('/api/requests', { cookie: admin }));
    expect(history.map((r) => [r.stream, r.costUsd]).sort()).toEqual([[false, 0.0000041], [true, 0.0000029]]);
    const usage = await data<UsageReport>(await h.request('/api/usage', { cookie: admin }));
    expect(usage.totals.costUsd).toBeCloseTo(0.000007, 10);
    expect(usage.totals.unpricedRequests).toBe(0);
  });

  test('a free model costs 0 and is not counted as unpriced', async () => {
    const { h, admin, provider, chat } = await world();
    await h.request(`/api/providers/${provider.id}/models/import`, { method: 'POST', cookie: admin, json: { providerModelIds: ['nvidia/nemotron-3.5-lightning:free'] } });
    expect((await chat({ model: 'openrouter/nvidia/nemotron-3.5-lightning:free', messages: [{ role: 'user', content: 'Hi' }] })).status).toBe(200);
    const [record] = await data<RequestRecord[]>(await h.request('/api/requests', { cookie: admin }));
    expect(record!.costUsd).toBe(0);
    expect((await data<UsageReport>(await h.request('/api/usage', { cookie: admin }))).totals.unpricedRequests).toBe(0);
  });
});
