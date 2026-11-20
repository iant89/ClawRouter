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

// SEC-009: request logging modes. NONE keeps no request rows (usage records only),
// METADATA (the default) the row, FULL the row plus the prompt, the reply, tool calls and
// attachment details, readable with requests.content only.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { loadConfig } from '@clawrouter/core';
import { settingDefaults } from '@clawrouter/settings';
import type { ApiSuccess, CreatedApiKey, RequestContent, RequestDetail, RequestRecord, SettingInfo, UsageReport } from '@clawrouter/shared';
import { createHarness, type Harness } from '../../../tests/support/harness.ts';
import { startMockProviders, type MockProviders } from '../../../tests/support/mock-providers.ts';

let mock: MockProviders;
beforeAll(() => {
  mock = startMockProviders();
});
afterAll(() => mock.stop());
beforeEach(() => {
  mock.mode = 'ok';
  mock.failFamilies.clear();
  mock.streamBreak = false;
});

const actor = { id: 'u', username: 'admin' };
const client = { ip: null };
const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MODES = { NONE: 0, METADATA: 1, FULL: 2 } as const;

async function world(mode?: keyof typeof MODES) {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const openai = await h.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key, priority: 10 }, client);
  const google = await h.providers.create(actor, { name: 'Google', identifier: 'google', kind: 'google', endpoint: `${mock.url}/google/v1beta`, apiKey: mock.key, priority: 30 }, client);
  h.models.create(actor, { providerId: openai.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT', 'VISION', 'TOOL_USE'], cost: { inputPerMTok: 2.5, outputPerMTok: 10 } }, client);
  h.models.create(actor, { providerId: google.id, providerModelId: 'text-embedding-004', capabilities: ['EMBEDDINGS'] }, client);
  const key = await data<CreatedApiKey>(await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'ci' } }));
  if (mode) await setMode(h, admin, mode);
  const v1 = (path: string, body: unknown) => h.request(`/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${key.secret}` }, json: body });
  return { h, admin, key, v1 };
}

async function setMode(h: Harness, cookie: string, mode: keyof typeof MODES) {
  expect((await h.request('/api/settings', { method: 'PUT', cookie, json: { values: { requestLogging: MODES[mode] } } })).status).toBe(200);
}
const content = (h: Harness, cookie: string, id: string) => h.request(`/api/requests/${id}/content`, { cookie });
const storedRows = (h: Harness) => h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM request_content')!.n;
const requestRows = (h: Harness) => h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM requests')!.n;

describe('the request logging setting (SEC-009)', () => {
  test('a choice of None, Metadata and Full; Metadata by default; other values refused', async () => {
    const { h, admin } = await world();
    const s = (await data<SettingInfo[]>(await h.request('/api/settings', { cookie: admin }))).find((x) => x.key === 'requestLogging')!;
    expect(s).toMatchObject({ kind: 'choice', value: 1, defaultValue: 1, env: 'CLAWROUTER_REQUEST_LOGGING' });
    expect(s.options!.map((o) => o.label)).toEqual(['None', 'Metadata', 'Full']);
    expect(s.options![2]!.description).toContain('Stored in the database');
    expect((await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { requestLogging: 3 } } })).status).toBe(400);
    await setMode(h, admin, 'FULL');
    const audit = h.audit.list({ action: 'SETTINGS_CHANGED' })[0]!;
    expect(audit.metadata).toEqual({ changes: { requestLogging: { before: 1, after: 2 } } });
  });

  test('CLAWROUTER_REQUEST_LOGGING sets the default', () => {
    const d = (v?: string) => settingDefaults(loadConfig({ CLAWROUTER_ENV: 'test', ...(v ? { CLAWROUTER_REQUEST_LOGGING: v } : {}) })).requestLogging;
    expect([d(), d('none'), d('metadata'), d('full')]).toEqual([1, 0, 1, 2]);
    expect(() => loadConfig({ CLAWROUTER_ENV: 'test', CLAWROUTER_REQUEST_LOGGING: 'everything' })).toThrow('CLAWROUTER_REQUEST_LOGGING');
  });
});

describe('METADATA (the default)', () => {
  test('keeps the request record, never what was said', async () => {
    const { h, admin, v1 } = await world();
    const res = await v1('/chat/completions', { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'metadata-only canary 71c' }] });
    const id = res.headers.get('x-request-id')!;
    const r = await data<RequestDetail>(await h.request(`/api/requests/${id}`, { cookie: admin }));
    // Everything SEC-009 lists for metadata.
    expect(r).toMatchObject({ id, status: 'COMPLETED', httpStatus: 200, apiKey: { name: 'ci' }, user: { username: 'admin' }, modelRef: 'openai/gpt-4o-mini', provider: { name: 'OpenAI' }, inputTokens: 7, outputTokens: 4, hasContent: false });
    expect(r.receivedAt).toBeString();
    expect(r.durationMs).toBeNumber();
    expect(r.costUsd).toBeGreaterThan(0);
    expect(storedRows(h)).toBe(0);
    expect((await content(h, admin, id)).status).toBe(404);
    expect(JSON.stringify(h.db.all('SELECT * FROM requests'))).not.toContain('canary 71c');
  });
});

describe('NONE', () => {
  test('keeps no request history; usage, quotas and cost limits still count', async () => {
    const { h, admin, v1 } = await world('NONE');
    const res = await v1('/chat/completions', { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] });
    expect(res.status).toBe(200);
    await v1('/chat/completions', { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }], stream: true }).then((r) => r.text());
    expect(requestRows(h)).toBe(0);
    expect(storedRows(h)).toBe(0);
    expect(await data<RequestRecord[]>(await h.request('/api/requests', { cookie: admin }))).toEqual([]);
    expect((await h.request(`/api/requests/${res.headers.get('x-request-id')}`, { cookie: admin })).status).toBe(404);
    const usage = await data<UsageReport>(await h.request('/api/usage', { cookie: admin }));
    expect(usage.totals.requests).toBe(2);
    expect(usage.totals.costUsd).toBeGreaterThan(0);
    // The quota reads the same usage records.
    expect(h.requests.userUsageSince((await h.users.findByUsername('admin'))!.id, new Date(0)).requests).toBe(2);
  });
});

describe('FULL', () => {
  test('stores the prompt, the reply, tool names and attachment details; never the attachment or a secret', async () => {
    const { h, admin, v1 } = await world('FULL');
    const res = await v1('/chat/completions', {
      model: 'openai/gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'text', text: 'What is this? My key is sk-proj-abcdefghijklmnopqrstuvwxyz0123' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }, { type: 'image_url', image_url: { url: 'https://images.example.com/cat.png?sig=abc' } }] },
      ],
    });
    expect(res.status).toBe(200);
    const id = res.headers.get('x-request-id')!;
    expect((await data<RequestDetail>(await h.request(`/api/requests/${id}`, { cookie: admin }))).hasContent).toBe(true);
    const c = await data<RequestContent>(await content(h, admin, id));
    expect(c).toMatchObject({ requestId: id, tools: [], truncated: false, response: { content: 'Hello from OpenAI', reasoning: null, toolCalls: [], finishReason: 'stop' } });
    expect(c.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(c.messages[1]!.content).toContain('What is this?');
    expect(c.messages[1]!.content).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    expect(c.messages[1]!.attachments).toEqual([
      { type: 'image', mediaType: 'image/png', bytes: Buffer.from(PNG, 'base64').length, name: null },
      { type: 'image', mediaType: null, bytes: null, name: 'images.example.com' },
    ]);
    const raw = h.db.get<{ content: string }>('SELECT content FROM request_content')!.content;
    expect(raw).not.toContain(PNG.slice(0, 40));
    expect(raw).not.toContain('sig=abc');
  });

  test('streams: the reply as sent; tool calls in requests and replies', async () => {
    const { h, admin, v1 } = await world('FULL');
    const streamed = await v1('/chat/completions', { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }], stream: true });
    await streamed.text();
    const s = await data<RequestContent>(await content(h, admin, streamed.headers.get('x-request-id')!));
    expect(s.response!.content).toBe('Hello');
    expect(s.response!.finishReason).toBe('stop');

    const tools = [{ type: 'function', function: { name: 'weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
    const called = await v1('/chat/completions', { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Weather in Paris?' }], tools, stream: true });
    await called.text();
    const t = await data<RequestContent>(await content(h, admin, called.headers.get('x-request-id')!));
    expect(t.tools).toEqual(['weather']);
    expect(t.response!.toolCalls).toEqual([{ id: 'call_abc', name: 'weather', arguments: '{"city":"Paris"}' }]);

    const answered = await v1('/chat/completions', {
      model: 'openai/gpt-4o-mini', tools,
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris","password":"hunter2-tool-secret"}' } }] },
        { role: 'tool', tool_call_id: 'call_abc', content: 'Sunny, 21 °C' },
      ],
    });
    const a = await data<RequestContent>(await content(h, admin, answered.headers.get('x-request-id')!));
    expect(a.messages[1]!.toolCalls![0]).toMatchObject({ id: 'call_abc', name: 'weather' });
    expect(a.messages[1]!.toolCalls![0]!.arguments).toContain('Paris');
    expect(a.messages[1]!.toolCalls![0]!.arguments).not.toContain('hunter2-tool-secret');
    expect(a.messages[2]).toMatchObject({ role: 'tool', toolCallId: 'call_abc', content: 'Sunny, 21 °C' });
  });

  test('a failed request keeps its prompt and no reply; embeddings keep their input', async () => {
    const { h, admin, v1 } = await world('FULL');
    mock.failFamilies.add('openai');
    const failed = await v1('/chat/completions', { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Will this fail?' }] });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    const f = await data<RequestContent>(await content(h, admin, failed.headers.get('x-request-id')!));
    expect(f.messages[0]!.content).toBe('Will this fail?');
    expect(f.response).toBeNull();
    mock.failFamilies.clear();
    const emb = await v1('/embeddings', { model: 'google/text-embedding-004', input: ['first text', 'second text'] });
    expect(emb.status).toBe(200);
    const e = await data<RequestContent>(await content(h, admin, emb.headers.get('x-request-id')!));
    expect(e.input).toEqual(['first text', 'second text']);
    expect(e.response).toMatchObject({ embeddings: 2 });
  });

  test('at most 1 MB per request: the oldest message texts go first', async () => {
    const { h, admin, v1 } = await world('FULL');
    const big = 'x'.repeat(150_000);
    const messages = [...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}:${big}` })), { role: 'user', content: 'the latest question' }];
    const res = await v1('/chat/completions', { model: 'openai/gpt-4o-mini', messages });
    expect(res.status).toBe(200);
    const c = await data<RequestContent>(await content(h, admin, res.headers.get('x-request-id')!));
    expect(c.truncated).toBe(true);
    expect(c.messages).toHaveLength(11);
    expect(c.messages[0]).toMatchObject({ content: '', truncated: true });
    expect(c.messages.at(-1)!.content).toBe('the latest question');
    expect(h.db.get<{ bytes: number }>('SELECT bytes FROM request_content')!.bytes).toBeLessThanOrEqual(1024 * 1024);
  });

  test('switching back stops storing; stored content goes with its request', async () => {
    const { h, admin, v1 } = await world('FULL');
    await v1('/chat/completions', { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] });
    await setMode(h, admin, 'METADATA');
    const after = await v1('/chat/completions', { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] });
    expect(storedRows(h)).toBe(1);
    expect((await content(h, admin, after.headers.get('x-request-id')!)).status).toBe(404);
    // Past the request history retention, the request and its content are deleted together.
    h.clock.advance(31 * 24 * 3_600_000);
    h.requests.prune();
    expect(requestRows(h)).toBe(0);
    expect(storedRows(h)).toBe(0);
  });

  test('only requests.content may read it: Administrators, not Operators or Viewers', async () => {
    const { h, admin, v1 } = await world('FULL');
    const id = (await v1('/chat/completions', { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'private words' }] })).headers.get('x-request-id')!;
    await h.addUser('olga', ['OPERATOR']);
    await h.addUser('vera', ['VIEWER']);
    for (const who of ['olga', 'vera']) {
      const cookie = await h.login(who);
      expect((await h.request(`/api/requests/${id}`, { cookie })).status).toBe(200); // the record: requests.read
      expect((await content(h, cookie, id)).status).toBe(403);
    }
    // A custom role can be given it explicitly.
    const role = await data<{ id: string }>(await h.request('/api/roles', { method: 'POST', cookie: admin, json: { name: 'Auditor', permissions: ['requests.read', 'requests.content'] } }));
    await h.addUser('ada', [role.id]);
    const ada = await h.login('ada');
    expect((await data<RequestContent>(await content(h, ada, id))).messages[0]!.content).toBe('private words');
  });
});
