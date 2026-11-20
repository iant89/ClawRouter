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

// SEC-021: a hostile provider behind the whole gateway. Every chat front end (Chat Completions,
// Responses, Messages; streamed or not) and embeddings, routed to OpenAI-, Anthropic- and
// Google-style providers that answer with changed answers, garbage and cut streams. Clients get
// a well-formed answer or a handled error: never a 500, never a crash in an adapter or a
// formatter, never a broken event stream, never provider internals. Then model metadata: the
// discovery, import and connection test (which updates the registry from the list) with hostile
// model lists.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ApiSuccess, DiscoveredModelInfo, ProviderInfo } from '@clawrouter/shared';
import type { Harness } from '../../support/harness.ts';
import { startMockProviders, type MockProviders } from '../../support/mock-providers.ts';
import { actor, client, gatewayWorld } from '../support.ts';
import { expectHandledResponse, forAll, type Rng } from './fuzz.ts';
import { ANSWERS, EMBEDDINGS, exchange, fakeFetch, hostileBody, hostileStream, MODEL_LISTS, STREAMS, type Exchange, type Family } from './hostile-provider.ts';

let mock: MockProviders;
let h: Harness;
let admin: string;
let key: string;
let providers: ProviderInfo[];
/** What the next provider call answers. */
let next: { family: Family; seedRng: Rng } | null = null;

const familyOf = (url: string): Family => (url.includes('/anthropic') ? 'anthropic' : url.includes('/google') ? 'google' : 'openai');

/** Answers each provider call with a hostile version of what that API would send for it. */
function hostileFor(url: string, init: RequestInit | undefined, r: Rng): Exchange {
  const f = familyOf(url);
  const streamed = /stream/i.test(url) || /"stream":true/.test(String(init?.body ?? ''));
  if (/\/models(\?|$)/.test(url)) return exchange(r, hostileBody(r, MODEL_LISTS[f]));
  if (/embed/i.test(url)) return exchange(r, hostileBody(r, f === 'google' ? EMBEDDINGS.google : EMBEDDINGS.openai));
  if (streamed) return exchange(r, hostileStream(r, r.pick(STREAMS[f]), f === 'anthropic'), true);
  return exchange(r, hostileBody(r, r.pick(ANSWERS[f])));
}

beforeAll(async () => {
  mock = await startMockProviders();
  ({ h, admin, key } = await gatewayWorld(mock));
  const anthropic = await h.providers.create(actor, { name: 'Anthropic', identifier: 'anthropic', kind: 'anthropic', endpoint: `${mock.url}/anthropic`, apiKey: mock.key }, client);
  const google = await h.providers.create(actor, { name: 'Google', identifier: 'google', kind: 'google', endpoint: `${mock.url}/google/v1beta`, apiKey: mock.key }, client);
  const openai = h.providers.list().find((p) => p.identifier === 'openai')!;
  const chatCaps = ['CHAT', 'TOOL_USE', 'VISION'] as const;
  h.models.update(actor, h.models.listAll().find((m) => m.providerModelId === 'gpt-4o-mini')!.id, { capabilities: [...chatCaps] }, client);
  h.models.create(actor, { providerId: anthropic.id, providerModelId: 'claude-sonnet-4-5', capabilities: [...chatCaps] }, client);
  h.models.create(actor, { providerId: google.id, providerModelId: 'gemini-3.5-flash', capabilities: [...chatCaps] }, client);
  h.models.create(actor, { providerId: openai.id, providerModelId: 'text-embedding-3-small', capabilities: ['EMBEDDINGS'] }, client);
  h.models.create(actor, { providerId: google.id, providerModelId: 'gemini-embedding-001', capabilities: ['EMBEDDINGS'] }, client);
  providers = h.providers.list();
  h.setProviderFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!next) throw new Error('no answer prepared');
    return fakeFetch(hostileFor(url, init, next.seedRng))(input, init);
  }) as typeof fetch);
});
afterAll(() => mock.stop());

const CHAT_MODELS = ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4-5', 'google/gemini-3.5-flash'];
const TOOLS = [{ type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: {} } } }];

function request(r: Rng): { path: string; body: unknown; headers: Record<string, string>; stream: boolean } {
  const model = r.pick(CHAT_MODELS);
  const stream = r.bool();
  const tools = r.bool(0.3);
  switch (r.int(5)) {
    case 0: return { path: '/v1/responses', stream, headers: {}, body: { model, input: 'Hi', stream, ...(tools ? { tools: [{ type: 'function', name: 'weather', parameters: { type: 'object' } }] } : {}) } };
    case 1: return { path: '/v1/messages', stream, headers: { 'anthropic-version': '2023-06-01' }, body: { model, max_tokens: 50, stream, messages: [{ role: 'user', content: 'Hi' }], ...(tools ? { tools: [{ name: 'weather', input_schema: { type: 'object' } }] } : {}) } };
    case 2: return { path: '/v1/embeddings', stream: false, headers: {}, body: { model: r.pick(['openai/text-embedding-3-small', 'google/gemini-embedding-001']), input: ['a', 'b'] } };
    default: return { path: '/v1/chat/completions', stream, headers: {}, body: { model, stream, ...(stream && r.bool() ? { stream_options: { include_usage: true } } : {}), messages: [{ role: 'user', content: 'Hi' }], ...(tools ? { tools: TOOLS } : {}) } };
  }
}

/** A streamed answer: every event carries JSON (or the [DONE] marker). */
function checkStream(text: string) {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data !== '[DONE]') JSON.parse(data);
  }
}

const nonNegative = (v: unknown) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

describe('a hostile provider behind every front end', () => {
  test('clients get a well-formed answer or a handled error', async () => {
    let answered = 0;
    let streamed = 0;
    await forAll('gateway hostile provider', 900, (r) => ({ req: request(r), seed: r.int(2 ** 31) }), async ({ req, seed }, i) => {
      const { rng } = await import('./fuzz.ts');
      next = { family: 'openai', seedRng: rng(seed) };
      for (const p of providers) h.routing.failures.recordSuccess(p.id); // keep every provider in rotation
      h.clock.advance(600);
      h.logs.length = 0;
      const res = await h.request(req.path, { method: 'POST', headers: { authorization: `Bearer ${key}`, ...req.headers }, json: req.body });
      const text = await expectHandledResponse(res, h.logs, [502, 503, 504]);
      void i;
      if (res.status !== 200) return;
      answered += 1;
      if ((res.headers.get('content-type') ?? '').includes('event-stream')) {
        streamed += 1;
        checkStream(text);
        return;
      }
      const body = JSON.parse(text) as Record<string, unknown>;
      const usage = (body.usage ?? {}) as Record<string, unknown>;
      for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']) expect([k, nonNegative(usage[k])]).toEqual([k, true]);
      if (req.path === '/v1/chat/completions') {
        const message = (body.choices as { message: { content: unknown } }[])[0]!.message;
        expect(message.content === null || typeof message.content === 'string').toBe(true);
      }
    });
    // Hostile answers still often parse: the success paths were exercised too.
    expect([answered > 100, streamed > 30]).toEqual([true, true]);
  }, 120_000);
});

describe('model metadata from a hostile provider', () => {
  test('discovery, import and the connection test (which updates the registry) never fail with a 500', async () => {
    let imported = 0;
    await forAll('gateway model lists', 300, (r) => ({ provider: r.pick(providers).id, seed: r.int(2 ** 31), action: r.int(3) }), async ({ provider, seed, action }) => {
      const { rng } = await import('./fuzz.ts');
      next = { family: 'openai', seedRng: rng(seed) };
      h.logs.length = 0;
      if (action === 0) {
        const res = await h.request(`/api/providers/${provider}/test`, { method: 'POST', cookie: admin });
        await expectHandledResponse(res, h.logs, [502, 503, 504]);
        expect(h.logs.filter((l) => l.msg === 'could not apply model list')).toEqual([]);
        return;
      }
      const res = await h.request(`/api/providers/${provider}/models/discover`, { cookie: admin });
      const text = await expectHandledResponse(res, h.logs, [502, 503, 504]);
      if (res.status !== 200 || action === 1) return;
      const found = (JSON.parse(text) as ApiSuccess<DiscoveredModelInfo[]>).data;
      if (!found.length) return;
      next = { family: 'openai', seedRng: rng(seed) }; // the import lists the models again: the same answer
      h.logs.length = 0;
      const imp = await h.request(`/api/providers/${provider}/models/import`, { method: 'POST', cookie: admin, json: { providerModelIds: found.slice(0, 3).map((m) => m.providerModelId) } });
      await expectHandledResponse(imp, h.logs, [502, 503, 504]);
      if (imp.status === 200) imported += 1;
    });
    expect(imported).toBeGreaterThan(5);
    // Whatever was imported is a model the console can list.
    expect((await h.request('/api/models?limit=200', { cookie: admin })).status).toBe(200);
  }, 120_000);
});
