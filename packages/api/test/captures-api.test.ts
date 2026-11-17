import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ApiSuccess, CaptureDetail, CaptureExportFile, CaptureState, CaptureSummary, CreatedApiKey, ProviderInfo } from '@clawrouter/shared';
import { maskBodyText } from '@clawrouter/captures';
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
  mock.badRequestFamilies.clear();
  mock.streamBreak = false;
  mock.streamDelayMs = 0;
});

const actor = { id: 'u', username: 'admin' };
const client = { ip: null };
const json = async <T>(res: Response) => (await res.json()) as T;
const data = async <T>(res: Response) => (await json<ApiSuccess<T>>(res)).data;

/** OpenAI (mock) first, a local OpenAI-compatible server (mock) second, both serving gpt-4o-mini. */
async function world(options: { enabled?: boolean } = {}) {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const p = (name: string, identifier: string, kind: ProviderInfo['kind'], path: string, apiKey?: string, priority = 100) =>
    h.providers.create(actor, { name, identifier, kind, endpoint: `${mock.url}${path}`, apiKey, priority }, client);
  const openai = await p('OpenAI', 'openai', 'openai', '/openai/v1', mock.key, 10);
  const local = await p('Local', 'local', 'openai_compatible', '/local/v1', undefined, 20);
  h.models.create(actor, { providerId: openai.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'] }, client);
  h.models.create(actor, { providerId: local.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'] }, client);
  const created = await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'ci' } });
  const key = (await data<CreatedApiKey>(created)).secret;
  if (options.enabled !== false) await setSettings(h, admin, { capturesEnabled: 1 });
  return { h, admin, key, openai, local };
}

async function setSettings(h: Harness, cookie: string, values: Record<string, number>) {
  const res = await h.request('/api/settings', { method: 'PUT', cookie, json: { values } });
  expect(res.status).toBe(200);
}

const v1 = (h: Harness, key: string, path: string, body: unknown) =>
  h.request(`/v1${path}`, { method: 'POST', json: body, headers: { authorization: `Bearer ${key}` } });
const chat = (model: string, extra: Record<string, unknown> = {}) => ({ model, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'My secret recipe is 42 lemons' }], ...extra });

async function captures(h: Harness, cookie: string, query = ''): Promise<CaptureSummary[]> {
  const res = await h.request(`/api/captures${query}`, { cookie });
  expect(res.status).toBe(200);
  return data<CaptureSummary[]>(res);
}
const detail = async (h: Harness, cookie: string, id: string) => data<CaptureDetail>(await h.request(`/api/captures/${id}`, { cookie }));

describe('provider captures', () => {
  test('off by default: nothing is recorded and a manual capture cannot start', async () => {
    const { h, admin, key } = await world({ enabled: false });
    mock.failFamilies.add('openai');
    expect((await v1(h, key, '/chat/completions', chat('gpt-4o-mini'))).status).toBe(200);
    expect(await captures(h, admin)).toEqual([]);
    const state = await data<CaptureState>(await h.request('/api/captures/state', { cookie: admin }));
    expect(state).toMatchObject({ enabled: false, manual: null, stored: 0, maxCount: 500 });
    const start = await h.request('/api/captures/manual', { method: 'POST', cookie: admin, json: { count: 1, minutes: 10 } });
    expect(start.status).toBe(409);
  });

  test('a provider error is captured with every attempt, raw replies and what the client got; no credential is recorded', async () => {
    const { h, admin, key, openai, local } = await world();
    mock.failFamilies.add('openai');
    const res = await v1(h, key, '/chat/completions', chat('gpt-4o-mini'));
    expect(res.status).toBe(200);
    const [summary, ...rest] = await captures(h, admin);
    expect(rest).toEqual([]);
    expect(summary).toMatchObject({ trigger: 'error', endpoint: 'chat.completions', stream: false, requestedModel: 'gpt-4o-mini', modelRef: 'local/gpt-4o-mini', providerId: local.id, exchangeCount: 3 });
    expect(summary!.outcome).toEqual({ status: 'COMPLETED', httpStatus: 200, errorCode: null, errorMessage: null });

    const c = await detail(h, admin, summary!.id);
    expect(c.exchanges.map((x) => [x.attempt, x.providerId, x.outcome, x.response?.status])).toEqual([
      [1, openai.id, 'server_error', 500], [2, openai.id, 'server_error', 500], [3, local.id, 'ok', 200],
    ]);
    const first = c.exchanges[0]!;
    expect(first.providerKind).toBe('openai');
    expect(first.request.method).toBe('POST');
    expect(first.request.url).toBe(`${mock.url}/openai/v1/chat/completions`);
    expect(first.request.headers.authorization).toBe('[REDACTED]');
    expect(JSON.parse(first.request.body!.text)).toMatchObject({ model: 'gpt-4o-mini', messages: [{ role: 'system' }, { role: 'user', content: 'My secret recipe is 42 lemons' }] });
    expect(first.response!.body.text).toContain('openai is down');
    expect(first.error).toContain('HTTP 500');
    expect(JSON.parse(c.client.request.body.text)).toMatchObject({ model: 'gpt-4o-mini' });
    expect(c.client.response!.status).toBe(200);
    expect(JSON.parse(c.client.response!.body.text)).toMatchObject({ object: 'chat.completion', model: 'local/gpt-4o-mini' });
    expect(c.attempts.map((a) => a.outcome)).toEqual(['server_error', 'server_error', 'ok']);
    // Neither the provider's key nor the client's ClawRouter key is anywhere in it.
    const all = JSON.stringify(c);
    expect(all).not.toContain(mock.key);
    expect(all).not.toContain(key);
  });

  test('a reply ClawRouter cannot read is captured as an unreadable reply, raw body included', async () => {
    const { h, admin, key } = await world();
    mock.mode = 'garbage';
    const res = await v1(h, key, '/chat/completions', chat('openai/gpt-4o-mini'));
    expect(res.status).toBe(502);
    const [summary] = await captures(h, admin);
    expect(summary).toMatchObject({ trigger: 'parse_error', modelRef: 'openai/gpt-4o-mini' });
    expect(summary!.outcome).toMatchObject({ status: 'FAILED', httpStatus: 502, errorCode: 'PROVIDER_ERROR' });
    const c = await detail(h, admin, summary!.id);
    expect(c.exchanges[0]!.outcome).toBe('invalid_response');
    expect(c.exchanges[0]!.response).toMatchObject({ status: 200, complete: true, body: { text: '<html>not json</html>', truncated: false } });
    expect(c.client.response).toBeNull();
  });

  test('successful requests are not kept, and requests that never reach a provider are not either', async () => {
    const { h, admin, key } = await world();
    expect((await v1(h, key, '/chat/completions', chat('openai/gpt-4o-mini'))).status).toBe(200);
    expect((await v1(h, key, '/chat/completions', { model: 'openai/gpt-4o-mini' })).status).toBe(400);
    expect(await captures(h, admin)).toEqual([]);
  });

  test('a stream that breaks is captured with the raw provider stream and the events the client received', async () => {
    const { h, admin, key } = await world();
    mock.streamBreak = true;
    const res = await v1(h, key, '/chat/completions', chat('openai/gpt-4o-mini', { stream: true }));
    const text = await res.text();
    expect(text).toContain('stream_interrupted');
    const [summary] = await captures(h, admin);
    expect(summary).toMatchObject({ trigger: 'error', stream: true, outcome: { errorCode: 'STREAM_INTERRUPTED' } });
    const c = await detail(h, admin, summary!.id);
    expect(c.exchanges).toHaveLength(1);
    expect(c.exchanges[0]!.response!.complete).toBe(false);
    expect(c.exchanges[0]!.response!.body.text).toContain('data: ');
    expect(c.client.response!.body.text).toContain('stream_interrupted');
  });

  test('a manual capture keeps the next matching requests, then stops by itself', async () => {
    const { h, admin, key, local } = await world();
    const start = await h.request('/api/captures/manual', { method: 'POST', cookie: admin, json: { providerId: local.id, count: 2, minutes: 30 } });
    expect(start.status).toBe(200);
    expect((await data<CaptureState['manual']>(start))).toMatchObject({ providerId: local.id, model: null, total: 2, remaining: 2, startedBy: 'admin' });
    // Another provider: not captured.
    expect((await v1(h, key, '/chat/completions', chat('openai/gpt-4o-mini'))).status).toBe(200);
    const first = await v1(h, key, '/chat/completions', chat('local/gpt-4o-mini', { stream: true }));
    expect(await first.text()).toContain('[DONE]');
    h.clock.advance(1_000); // captures in the same millisecond have no fixed order
    expect((await v1(h, key, '/chat/completions', chat('local/gpt-4o-mini'))).status).toBe(200);
    expect((await v1(h, key, '/chat/completions', chat('local/gpt-4o-mini'))).status).toBe(200);
    const list = await captures(h, admin);
    expect(list.map((c) => [c.trigger, c.stream])).toEqual([['manual', false], ['manual', true]]);
    const streamed = await detail(h, admin, list[1]!.id);
    expect(streamed.exchanges[0]!.response!.complete).toBe(true);
    expect(streamed.client.response!.body.text).toContain('data: [DONE]');
    expect((await data<CaptureState>(await h.request('/api/captures/state', { cookie: admin }))).manual).toBeNull();
    expect(h.audit.list({ limit: 50 }).some((a) => a.action === 'CAPTURE_STARTED')).toBe(true);
  });

  test('a manual capture expires, and can be stopped', async () => {
    const { h, admin, key } = await world();
    await h.request('/api/captures/manual', { method: 'POST', cookie: admin, json: { model: 'openai/gpt-4o-mini', count: 5, minutes: 1 } });
    h.clock.advance(61_000);
    expect((await v1(h, key, '/chat/completions', chat('openai/gpt-4o-mini'))).status).toBe(200);
    expect(await captures(h, admin)).toEqual([]);
    await h.request('/api/captures/manual', { method: 'POST', cookie: admin, json: { count: 5, minutes: 10 } });
    const stopped = await h.request('/api/captures/manual', { method: 'DELETE', cookie: admin });
    expect((await data<CaptureState>(stopped)).manual).toBeNull();
    expect((await v1(h, key, '/chat/completions', chat('openai/gpt-4o-mini'))).status).toBe(200);
    expect(await captures(h, admin)).toEqual([]);
  });

  test('manual capture input is validated', async () => {
    const { h, admin } = await world();
    for (const body of [{ count: 0, minutes: 5 }, { count: 101, minutes: 5 }, { count: 1, minutes: 1441 }, { count: 1 }, { count: 1, minutes: 5, extra: true }]) {
      expect((await h.request('/api/captures/manual', { method: 'POST', cookie: admin, json: body })).status).toBe(400);
    }
  });

  test('export: a file to hand to a developer, with message text masked on request; audited', async () => {
    const { h, admin, key } = await world();
    mock.failFamilies.add('openai');
    await v1(h, key, '/chat/completions', chat('gpt-4o-mini'));
    const [summary] = await captures(h, admin);

    const full = await h.request('/api/captures/export', { method: 'POST', cookie: admin, json: { ids: [summary!.id], maskText: false } });
    expect(full.status).toBe(200);
    expect(full.headers.get('content-disposition')).toMatch(/^attachment; filename="clawrouter-capture-[\d-T]+\.json"$/);
    const file = await json<CaptureExportFile>(full);
    expect(file).toMatchObject({ format: 'clawrouter-capture', version: 1, clawrouterVersion: 'test', masked: false });
    expect(JSON.stringify(file)).toContain('42 lemons');

    const masked = await h.request('/api/captures/export', { method: 'POST', cookie: admin, json: { ids: [summary!.id], maskText: true } });
    expect(masked.headers.get('content-disposition')).toContain('-masked.json');
    const m = await json<CaptureExportFile>(masked);
    const text = JSON.stringify(m);
    expect(text).not.toContain('42 lemons');
    expect(text).not.toContain('Be brief.');
    expect(text).toContain('[masked: 29 chars]');
    const sent = JSON.parse(m.captures[0]!.exchanges[0]!.request.body!.text);
    expect(sent).toMatchObject({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: '[masked: 9 chars]' }, { role: 'user' }] });
    // Errors stay readable.
    expect(m.captures[0]!.exchanges[0]!.response!.body.text).toContain('openai is down');

    const exports = h.audit.list({ limit: 50 }).filter((a) => a.action === 'CAPTURES_EXPORTED');
    expect(exports.map((a) => a.metadata?.masked).sort()).toEqual([false, true]);
    expect((await h.request('/api/captures/export', { method: 'POST', cookie: admin, json: { ids: ['cap_missing'], maskText: true } })).status).toBe(404);
    expect((await h.request('/api/captures/export', { method: 'POST', cookie: admin, json: { ids: [], maskText: true } })).status).toBe(400);
  });

  test('masking keeps structure: roles, models, finish reasons, error objects and stream framing', () => {
    const masked = JSON.parse(maskBodyText(JSON.stringify({
      model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hello there', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"city":"Paris"}' } }] } }],
      usage: { prompt_tokens: 3 }, error: { message: 'kept', type: 'invalid_request_error' },
    })));
    expect(masked).toEqual({
      model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '[masked: 11 chars]', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '[masked: 16 chars]' } }] } }],
      usage: { prompt_tokens: 3 }, error: { message: 'kept', type: 'invalid_request_error' },
    });
    expect(maskBodyText('event: x\ndata: {"type":"delta","text":"secret"}\n\ndata: [DONE]\n')).toBe('event: x\ndata: {"type":"delta","text":"[masked: 6 chars]"}\n\ndata: [DONE]\n');
    expect(maskBodyText('<html>secret</html>')).toBe('[masked: 19 chars]');
  });

  test('captures are kept until deleted, the oldest dropped beyond the limit', async () => {
    const { h, admin, key } = await world();
    await setSettings(h, admin, { capturesMaxCount: 10 });
    mock.mode = 'garbage';
    for (let i = 0; i < 12; i++) {
      h.clock.advance(1_000);
      await v1(h, key, '/chat/completions', chat('openai/gpt-4o-mini'));
    }
    const list = await captures(h, admin, '?pageSize=200');
    expect(list).toHaveLength(10);
    const one = await h.request('/api/captures/delete', { method: 'POST', cookie: admin, json: { ids: [list[0]!.id] } });
    expect(await data<{ deleted: number }>(one)).toEqual({ deleted: 1 });
    expect((await h.request(`/api/captures/${list[0]!.id}`, { cookie: admin })).status).toBe(404);
    const all = await h.request('/api/captures/delete', { method: 'POST', cookie: admin, json: { all: true } });
    expect(await data<{ deleted: number }>(all)).toEqual({ deleted: 9 });
    expect((await h.request('/api/captures/delete', { method: 'POST', cookie: admin, json: {} })).status).toBe(400);
    expect(h.audit.list({ limit: 100 }).filter((a) => a.action === 'CAPTURES_DELETED')).toHaveLength(2);
  });

  test('filters by trigger and provider; only holders of captures.manage see captures', async () => {
    const { h, admin, key, openai } = await world();
    mock.mode = 'garbage';
    await v1(h, key, '/chat/completions', chat('openai/gpt-4o-mini'));
    mock.mode = 'ok';
    mock.failFamilies.add('local');
    await v1(h, key, '/chat/completions', chat('local/gpt-4o-mini'));
    expect((await captures(h, admin, '?trigger=parse_error')).map((c) => c.providerId)).toEqual([openai.id]);
    expect(await captures(h, admin, `?providerId=${openai.id}`)).toHaveLength(1);
    expect(await captures(h, admin, '?trigger=error')).toHaveLength(1);
    expect((await h.request('/api/captures?trigger=nope', { cookie: admin })).status).toBe(400);
    for (const role of ['OPERATOR', 'VIEWER']) {
      await h.addUser(role.toLowerCase(), [role]);
      const cookie = await h.login(role.toLowerCase());
      expect((await h.request('/api/captures', { cookie })).status).toBe(403);
    }
  });
});
