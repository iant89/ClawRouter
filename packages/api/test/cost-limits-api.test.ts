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
import type { ApiSuccess, CostLimits, CreatedApiKey, PutRateLimitsRequest, RateLimitConfigView, RateLimitUsage, RequestLimits } from '@clawrouter/shared';
import { DEFAULT_COST_LIMITS } from '@clawrouter/shared';
import { createHarness, type Harness } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

/**
 * Cost limits (SEC-005): spending per key, user, model, provider and gateway per
 * UTC hour, day and month, the estimated cost per request, and requests in
 * progress per key and user.
 */
let mock: MockProviders;
beforeAll(() => {
  mock = startMockProviders();
});
afterAll(() => mock.stop());
beforeEach(() => {
  mock.mode = 'ok';
  mock.failFamilies.clear();
  mock.streamDelayMs = 0;
  mock.streamBreak = false;
});

const actor = { id: 'u', username: 'admin' };
const client = { ip: null };
type OpenAiError = { error: { message: string; type: string; code: string; param: string | null; limit?: string } };
const json = async <T>(res: Response) => (await res.json()) as T;
const data = async <T>(res: Response) => (await json<ApiSuccess<T>>(res)).data;

/**
 * OpenAI (priced: $0.10 a token, so one answer of 7 + 4 tokens costs $1.10) and
 * a local server (unpriced), both offering gpt-4o-mini. The clock starts at the
 * top of an hour so a test's requests stay in one hour.
 */
async function world() {
  const h = createHarness();
  h.clock.time = Date.parse('2026-11-19T10:00:00.000Z');
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const openai = await h.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key, priority: 10 }, client);
  const local = await h.providers.create(actor, { name: 'Local', identifier: 'local', kind: 'openai_compatible', endpoint: `${mock.url}/local/v1`, priority: 20 }, client);
  h.models.create(actor, { providerId: openai.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'], cost: { inputPerMTok: 100_000, outputPerMTok: 100_000 }, maxOutputTokens: 1000 }, client);
  h.models.create(actor, { providerId: local.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'] }, client);
  const key = await createKey(h, admin, 'ci');
  return { h, admin, key, openai, local };
}

async function createKey(h: Harness, cookie: string, name: string): Promise<CreatedApiKey> {
  const res = await h.request('/api/api-keys', { method: 'POST', cookie, json: { name } });
  expect(res.status).toBe(201);
  return data<CreatedApiKey>(res);
}

async function setLimits(h: Harness, cookie: string, patch: Partial<PutRateLimitsRequest>): Promise<Response> {
  const current = await data<RateLimitConfigView>(await h.request('/api/rate-limits', { cookie }));
  const { unknownModels: _u, updatedAt: _a, updatedBy: _b, ...rest } = current;
  return h.request('/api/rate-limits', { method: 'PUT', cookie, json: { ...rest, ...patch } });
}

const costs = (patch: Partial<CostLimits>): Partial<PutRateLimitsRequest> => ({ costLimits: { ...structuredClone(DEFAULT_COST_LIMITS), ...patch } });

async function setRequestLimits(h: Harness, cookie: string, patch: Partial<RequestLimits>) {
  const current = await data<RateLimitConfigView>(await h.request('/api/rate-limits', { cookie }));
  const res = await setLimits(h, cookie, { requestLimits: { ...current.requestLimits, ...patch } });
  expect(res.status).toBe(200);
}

const chat = (h: Harness, key: string, extra: Record<string, unknown> = {}) =>
  h.request('/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${key}` },
    json: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }], ...extra },
  });

/** Only the priced OpenAI model, so spending is predictable. */
const priced = { model: 'openai/gpt-4o-mini' };

describe('spending limits per key, user and gateway', () => {
  test('an hourly limit per key refuses with 429 cost_limit_exceeded until the next hour', async () => {
    const { h, admin, key } = await world();
    expect((await setLimits(h, admin, costs({ perKey: { hour: 2, day: null, month: null } }))).status).toBe(200);
    expect((await chat(h, key.secret, priced)).status).toBe(200); // $1.10
    expect((await chat(h, key.secret, priced)).status).toBe(200); // $2.20: reached, but checked before each request
    const refused = await chat(h, key.secret, priced);
    expect(refused.status).toBe(429);
    const err = (await json<OpenAiError>(refused)).error;
    expect(err).toMatchObject({ type: 'rate_limit_error', code: 'cost_limit_exceeded' });
    expect(err.message).toContain('Spending limit reached for this API key: $2.20 of $2.00 this hour (UTC).');
    expect(err.message).toContain('It resets at 2026-11-19T11:00:00.000Z.');
    expect(Number(refused.headers.get('retry-after'))).toBe(3600);
    // The refused request is recorded, never sent to a provider.
    const sent = mock.requests.length;
    expect((await chat(h, key.secret, priced)).status).toBe(429);
    expect(mock.requests.length).toBe(sent);
    // Another key of the same user is not affected by a per-key limit.
    const other = await createKey(h, admin, 'other');
    expect((await chat(h, other.secret, priced)).status).toBe(200);
    // The next hour starts at zero.
    h.clock.advance(3_600_000);
    expect((await chat(h, key.secret, priced)).status).toBe(200);
  });

  test('a daily limit per user adds up all of their keys', async () => {
    const { h, admin, key } = await world();
    await setLimits(h, admin, costs({ perUser: { hour: null, day: 2, month: null } }));
    const second = await createKey(h, admin, 'second');
    expect((await chat(h, key.secret, priced)).status).toBe(200);
    expect((await chat(h, second.secret, priced)).status).toBe(200);
    const refused = await chat(h, key.secret, priced);
    expect(refused.status).toBe(429);
    expect((await json<OpenAiError>(refused)).error.message).toContain('your account (all of your API keys together)');
    expect((await json<OpenAiError>(await chat(h, second.secret, priced))).error.code).toBe('cost_limit_exceeded');
    // Midnight UTC resets a daily limit.
    h.clock.time = Date.parse('2026-11-20T00:00:01.000Z');
    expect((await chat(h, key.secret, priced)).status).toBe(200);
  });

  test('a monthly gateway limit counts everyone, and spending recorded elsewhere counts after the cache expires', async () => {
    const { h, admin, key } = await world();
    await setLimits(h, admin, costs({ global: { hour: null, day: null, month: 50 } }));
    expect((await chat(h, key.secret, priced)).status).toBe(200);
    // Another node (same database) recorded $60 earlier this month.
    h.db.run(
      `INSERT INTO usage_records (hour, api_key_id, user_id, model_ref, provider_id, requests, cost_usd) VALUES (?, 'k_elsewhere', NULL, 'openai/gpt-4o-mini', 'p', 1, 60)`,
      ['2026-11-02T08:00:00.000Z'],
    );
    expect((await chat(h, key.secret, priced)).status).toBe(200); // cached for 5 s
    h.clock.advance(6_000);
    const refused = await chat(h, key.secret, priced);
    expect(refused.status).toBe(429);
    expect((await json<OpenAiError>(refused)).error.message).toContain('the whole gateway');
    // Spending from last month does not count.
    h.clock.time = Date.parse('2026-12-01T00:00:00.000Z');
    expect((await chat(h, key.secret, priced)).status).toBe(200);
  });

  test('a refusal is an event and an audit-free 429 that the request history records', async () => {
    const { h, admin, key } = await world();
    await setLimits(h, admin, costs({ perKey: { hour: 1, day: null, month: null } }));
    const seen: string[] = [];
    h.events.on('ratelimit.exceeded', (e) => { seen.push(`${e.scope}:${e.kind}`); });
    await chat(h, key.secret, priced);
    const refused = await chat(h, key.secret, priced);
    expect(refused.status).toBe(429);
    expect(seen).toEqual(['key:cost']);
    const row = h.db.get<{ http_status: number; error_code: string }>('SELECT http_status, error_code FROM requests ORDER BY received_at DESC, rowid DESC LIMIT 1');
    expect(row).toEqual({ http_status: 429, error_code: 'RATE_LIMITED' });
  });
});

describe('spending limits per model and provider', () => {
  test('a model over its budget is skipped and the next model answers; with no other model the client gets 429', async () => {
    const { h, admin, key } = await world();
    await setLimits(h, admin, costs({ perModel: [{ model: 'openai/gpt-4o-mini', hour: 1, day: null, month: null }] }));
    const first = await chat(h, key.secret);
    expect(first.headers.get('x-clawrouter-model')).toBe('openai/gpt-4o-mini');
    const second = await chat(h, key.secret);
    expect(second.status).toBe(200);
    expect(second.headers.get('x-clawrouter-model')).toBe('local/gpt-4o-mini');
    const only = await chat(h, key.secret, priced);
    expect(only.status).toBe(429);
    const err = (await json<OpenAiError>(only)).error;
    expect(err.code).toBe('cost_limit_exceeded');
    expect(err.message).toContain('this model: $1.10 of $1.00 this hour');
  });

  test('a provider over its budget is skipped for all of its models', async () => {
    const { h, admin, key } = await world();
    await setLimits(h, admin, costs({ perProvider: [{ provider: 'openai', hour: null, day: 1, month: null }] }));
    expect((await chat(h, key.secret)).headers.get('x-clawrouter-model')).toBe('openai/gpt-4o-mini');
    expect((await chat(h, key.secret)).headers.get('x-clawrouter-model')).toBe('local/gpt-4o-mini');
    const refused = await chat(h, key.secret, priced);
    expect(refused.status).toBe(429);
    expect((await json<OpenAiError>(refused)).error.message).toContain('this provider: $1.10 of $1.00 today');
    // The usage view shows what was spent against each cost limit.
    const usage = await data<RateLimitUsage>(await h.request('/api/rate-limits/usage', { cookie: admin }));
    expect(usage.spending).toEqual([
      { scope: 'global', label: 'All requests', spent: { hour: 1.1, day: 1.1, month: 1.1 }, limit: { hour: null, day: null, month: null } },
      { scope: 'provider', label: 'openai', spent: { hour: 1.1, day: 1.1, month: 1.1 }, limit: { hour: null, day: 1, month: null } },
    ]);
  });
});

describe('estimated cost per request', () => {
  test('a model on which the request could cost too much is left out; when every model is, 400 request_limit', async () => {
    const { h, admin, key } = await world();
    // Input "Hi" is one token ($0.10); 20 output tokens would add $2.00.
    await setLimits(h, admin, costs({ maxEstimatedCostPerRequest: 1 }));
    const small = await chat(h, key.secret, { ...priced, max_tokens: 5 });
    expect(small.status).toBe(200);
    // Without max_tokens the model's maximum output (1,000 tokens, $100) is assumed: the unpriced model answers.
    const fallback = await chat(h, key.secret);
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get('x-clawrouter-model')).toBe('local/gpt-4o-mini');
    const refused = await chat(h, key.secret, { ...priced, max_tokens: 20 });
    expect(refused.status).toBe(400);
    const err = (await json<OpenAiError>(refused)).error;
    expect(err).toMatchObject({ code: 'request_limit', limit: 'maxEstimatedCostPerRequest' });
    expect(err.message).toContain('The estimated cost of this request on openai/gpt-4o-mini ($2.1000) is above the $1 limit per request.');
  });
});

describe('requests in progress per key and per user', () => {
  test('a long stream holds its key\'s slot; the slot is free again when it ends', async () => {
    const { h, admin, key } = await world();
    await setRequestLimits(h, admin, { maxConcurrentPerKey: 1 });
    mock.streamDelayMs = 60;
    const stream = await chat(h, key.secret, { stream: true });
    expect(stream.status).toBe(200);
    const busy = await chat(h, key.secret);
    expect(busy.status).toBe(429);
    expect((await json<OpenAiError>(busy)).error.message).toContain('This API key already has 1 request in progress');
    // Another key of the same user is not limited per key.
    const other = await createKey(h, admin, 'other');
    expect((await chat(h, other.secret)).status).toBe(200);
    await stream.text();
    mock.streamDelayMs = 0;
    expect((await chat(h, key.secret)).status).toBe(200);
  });

  test('per user, all keys share the slots', async () => {
    const { h, admin, key } = await world();
    await setRequestLimits(h, admin, { maxConcurrentPerUser: 1 });
    const other = await createKey(h, admin, 'other');
    mock.streamDelayMs = 60;
    const stream = await chat(h, key.secret, { stream: true });
    const busy = await chat(h, other.secret);
    expect(busy.status).toBe(429);
    expect((await json<OpenAiError>(busy)).error.message).toContain('Your account already has 1 request in progress');
    await stream.text();
    mock.streamDelayMs = 0;
    expect((await chat(h, other.secret)).status).toBe(200);
  });
});

describe('streams that end early still count', () => {
  test('a stream that breaks after the first words records estimated usage and its cost', async () => {
    const { h, key } = await world();
    mock.streamBreak = true;
    const res = await chat(h, key.secret, { ...priced, stream: true });
    await res.text();
    const usage = h.db.get<{ tokens: number; cost: number }>('SELECT SUM(input_tokens + output_tokens) AS tokens, SUM(cost_usd) AS cost FROM usage_records');
    expect(usage!.tokens).toBeGreaterThan(0);
    expect(usage!.cost).toBeGreaterThan(0);
    const row = h.db.get<{ error_code: string; usage_source: string }>('SELECT error_code, usage_source FROM requests');
    expect(row).toEqual({ error_code: 'STREAM_INTERRUPTED', usage_source: 'estimated' });
  });
});

describe('administration', () => {
  test('cost and request limits are validated, audited, exported, and kept when a client leaves them out', async () => {
    const { h, admin } = await world();
    const bad = await setLimits(h, admin, {
      costLimits: {
        ...structuredClone(DEFAULT_COST_LIMITS),
        perKey: { hour: -1, day: null, month: null },
        perModel: [{ model: 'no-slash', hour: 1, day: null, month: null }, { model: 'openai/x', hour: null, day: null, month: null }],
        perProvider: [{ provider: 'openai', hour: 1, day: null, month: null }, { provider: 'OpenAI', hour: 2, day: null, month: null }],
      },
      requestLimits: { ...(await data<RateLimitConfigView>(await h.request('/api/rate-limits', { cookie: admin }))).requestLimits, maxMessages: 0, maxJsonDepth: 1_000 },
    });
    expect(bad.status).toBe(400);
    const issues = ((await json<{ error: { details: { issues: { path: string }[] } } }>(bad)).error.details.issues).map((i) => i.path);
    expect(issues).toEqual(expect.arrayContaining([
      'costLimits.perKey.hour', 'costLimits.perModel[0].model', 'costLimits.perModel[1]', 'costLimits.perProvider[1].provider',
      'requestLimits.maxMessages', 'requestLimits.maxJsonDepth',
    ]));
    const unknown = await setLimits(h, admin, { requestLimits: { maxFun: 1 } as unknown as RequestLimits });
    expect(unknown.status).toBe(400);

    const ok = await setLimits(h, admin, costs({ perKey: { hour: 5, day: 25, month: 100 } }));
    expect(ok.status).toBe(200);
    const audit = h.db.get<{ metadata: string }>("SELECT metadata FROM audit_log WHERE action = 'RATE_LIMITS_UPDATED' ORDER BY rowid DESC LIMIT 1");
    expect(JSON.parse(audit!.metadata).costLimits.to.perKey).toEqual({ hour: 5, day: 25, month: 100 });

    // An older client (or export file) without the new sections keeps them.
    const current = await data<RateLimitConfigView>(await h.request('/api/rate-limits', { cookie: admin }));
    const { unknownModels: _u, updatedAt: _a, updatedBy: _b, costLimits: _c, requestLimits: _r, ...old } = current;
    expect((await h.request('/api/rate-limits', { method: 'PUT', cookie: admin, json: { ...old, invalidKeysPerIp: 7 } })).status).toBe(200);
    const after = await data<RateLimitConfigView>(await h.request('/api/rate-limits', { cookie: admin }));
    expect(after.costLimits.perKey).toEqual({ hour: 5, day: 25, month: 100 });
    expect(after.invalidKeysPerIp).toBe(7);

    // The configuration export carries them.
    const exported = await h.request('/api/configuration/export', { cookie: admin });
    expect(exported.status).toBe(200);
    const doc = await data<{ rateLimits: { costLimits: CostLimits; requestLimits: RequestLimits } }>(exported);
    expect(doc.rateLimits.costLimits.perKey.month).toBe(100);
    expect(doc.rateLimits.requestLimits.maxJsonDepth).toBe(64);
  });

  test('operators may change cost limits, viewers may not', async () => {
    const { h } = await world();
    await h.addUser('op', ['OPERATOR']);
    await h.addUser('viewer', ['VIEWER']);
    expect((await setLimits(h, await h.login('op'), costs({ global: { hour: 10, day: null, month: null } }))).status).toBe(200);
    expect((await setLimits(h, await h.login('viewer'), costs({ global: { hour: 1, day: null, month: null } }))).status).toBe(403);
  });
});
