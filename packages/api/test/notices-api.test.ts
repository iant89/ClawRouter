import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ANNOUNCEMENT_ICONS, type AnnouncementInfo, type ApiSuccess, type CreatedApiKey, type NoticeMessages, type ProviderInfo } from '@clawrouter/shared';
import { headerValue, healthProblemIn, replyPrefix, stripNotices } from '@clawrouter/notices';
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
const json = async <T>(res: Response) => (await res.json()) as T;
const data = async <T>(res: Response) => (await json<ApiSuccess<T>>(res)).data;
type Completion = { choices: { message: { content: string; tool_calls?: unknown[] } }[] };

async function world() {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const p = (name: string, identifier: string, kind: ProviderInfo['kind'], path: string, apiKey?: string, priority = 100) =>
    h.providers.create(actor, { name, identifier, kind, endpoint: `${mock.url}${path}`, apiKey, priority }, client);
  const openai = await p('OpenAI', 'openai', 'openai', '/openai/v1', mock.key, 10);
  const local = await p('Local', 'local', 'openai_compatible', '/local/v1', undefined, 20);
  for (const prov of [openai, local]) h.models.create(actor, { providerId: prov.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT', 'TOOL_USE'] }, client);
  h.models.create(actor, { providerId: openai.id, providerModelId: 'text-embedding-3-small', capabilities: ['EMBEDDINGS'] }, client);
  const key = await createKey(h, admin, { name: 'chat' });
  return { h, admin, key, openai, local };
}

async function createKey(h: Harness, cookie: string, body: Record<string, unknown>): Promise<string> {
  const res = await h.request('/api/api-keys', { method: 'POST', cookie, json: body });
  expect(res.status).toBe(201);
  return (await data<CreatedApiKey>(res)).secret;
}

const v1 = (h: Harness, key: string, body: unknown, path = '/chat/completions') =>
  h.request(`/v1${path}`, { method: 'POST', json: body, headers: { authorization: `Bearer ${key}` } });
const chat = (extra: Record<string, unknown> = {}, model = 'gpt-4o-mini') => ({ model, messages: [{ role: 'user', content: 'Hi' }], ...extra });
const notices = (res: Response) => {
  const raw = res.headers.get('x-clawrouter-notices');
  return raw ? (JSON.parse(raw) as { kind: string; icon: string; text: string }[]) : null;
};
const content = async (res: Response) => (await json<Completion>(res)).choices[0]!.message.content;

async function announce(h: Harness, cookie: string, body: Record<string, unknown>): Promise<AnnouncementInfo> {
  const res = await h.request('/api/announcements', { method: 'POST', cookie, json: { channel: 'both', timeZone: 'UTC', ...body } });
  expect(res.status).toBe(201);
  return data<AnnouncementInfo>(res);
}

describe('client notices', () => {
  test('nothing to say: no header, the reply is untouched', async () => {
    const { h, key } = await world();
    const res = await v1(h, key, chat());
    expect(res.status).toBe(200);
    expect(notices(res)).toBeNull();
    expect(await content(res)).not.toContain('ClawRouter:');
  });

  test('a failover adds the failover notice to the header and the start of the reply, at most once per interval', async () => {
    const { h, key } = await world();
    mock.failFamilies.add('openai');
    const res = await v1(h, key, chat());
    expect(res.headers.get('x-clawrouter-model')).toBe('local/gpt-4o-mini');
    expect(notices(res)).toEqual([{ kind: 'failover', icon: '⚠️', text: 'Your request was answered by a backup model because the first choice was unavailable.' }]);
    const text = await content(res);
    expect(text.startsWith('⚠️ ClawRouter: Your request was answered by a backup model because the first choice was unavailable.\n\n')).toBe(true);
    expect(text.length).toBeGreaterThan(100);
    // Within the interval (30 minutes by default): not again.
    const again = await v1(h, key, chat());
    expect(notices(again)).toBeNull();
    expect(await content(again)).not.toContain('ClawRouter:');
    h.clock.advance(31 * 60_000);
    await h.login(); // keep a console session for nothing; the key is what matters
    expect(notices(await v1(h, key, chat()))).toHaveLength(1);
  });

  test('degraded health adds the health notice; the default messages can be changed and turned off', async () => {
    const { h, admin, key } = await world();
    // A fresh platform with unchecked providers is "degraded" overall, but that is not a problem for users.
    await h.health.report();
    expect(notices(await v1(h, key, chat({}, 'openai/gpt-4o-mini')))).toBeNull();
    // The provider's own check finds it degraded (rate limited): requests it still answers carry the health notice.
    mock.mode = 'rate_limited';
    await h.providers.checkAll();
    mock.mode = 'ok';
    const res = await v1(h, key, chat({}, 'openai/gpt-4o-mini'));
    expect(notices(res)?.map((n) => n.kind)).toEqual(['health']);
    expect(await content(res)).toStartWith('⚠️ ClawRouter: ClawRouter health has degraded; you may experience temporary performance issues.\n\n');

    const put = await h.request('/api/settings/notices', { method: 'PUT', cookie: admin, json: { health: { text: 'Maintenance in progress.\nThanks!' }, failover: { enabled: false } } });
    expect(put.status).toBe(200);
    const m = await data<NoticeMessages>(put);
    expect(m.health).toEqual({ enabled: true, text: 'Maintenance in progress. Thanks!' }); // one line
    expect(m.failover.enabled).toBe(false);
    const key2 = await createKey(h, admin, { name: 'second' });
    expect(notices(await v1(h, key2, chat({}, 'openai/gpt-4o-mini')))).toEqual([{ kind: 'health', icon: '⚠️', text: 'Maintenance in progress. Thanks!' }]);
    expect((await h.request('/api/settings/notices', { method: 'PUT', cookie: admin, json: { health: { text: ' ' } } })).status).toBe(400);
    const reset = await data<NoticeMessages>(await h.request('/api/settings/notices', { method: 'DELETE', cookie: admin }));
    expect(reset.health.text).toBe('ClawRouter health has degraded; you may experience temporary performance issues.');
    expect(h.audit.list({ limit: 50 }).filter((a) => a.action === 'SETTINGS_CHANGED' && a.metadata?.noticeMessages)).toHaveLength(2);
  });

  test('settings switch the header and the reply text off separately; a key can refuse reply text', async () => {
    const { h, admin, key } = await world();
    const set = (values: Record<string, number>) => h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values } });
    await announce(h, admin, { message: 'Hello from the admins', frequency: 'every_request' });

    await set({ noticeReplyEnabled: 0 });
    let res = await v1(h, key, chat());
    expect(notices(res)).toEqual([{ kind: 'announcement', icon: '📢', text: 'Hello from the admins' }]);
    expect(await content(res)).not.toContain('ClawRouter:');

    await set({ noticeReplyEnabled: 1, noticeHeaderEnabled: 0 });
    res = await v1(h, key, chat());
    expect(notices(res)).toBeNull();
    expect(await content(res)).toStartWith('📢 ClawRouter: Hello from the admins\n\n');

    await set({ noticeHeaderEnabled: 1 });
    const script = await createKey(h, admin, { name: 'script', replyNotices: false });
    res = await v1(h, script, chat());
    expect(notices(res)).toHaveLength(1);
    expect(await content(res)).not.toContain('ClawRouter:');
  });

  test('never in replies to requests that offer tools, nor in embeddings (header only)', async () => {
    const { h, admin, key } = await world();
    await announce(h, admin, { message: 'Read me', frequency: 'every_request' });
    const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }];
    const res = await v1(h, key, chat({ tools }));
    expect(res.status).toBe(200);
    expect(notices(res)).toHaveLength(1);
    const body = await json<Completion>(res);
    expect(JSON.stringify(body)).not.toContain('ClawRouter:');
    const emb = await v1(h, key, { model: 'openai/text-embedding-3-small', input: 'x' }, '/embeddings');
    expect(emb.status).toBe(200);
    expect(notices(emb)).toEqual([{ kind: 'announcement', icon: '📢', text: 'Read me' }]);
  });

  test('streams: the notice is the first text the client receives; Responses API too', async () => {
    const { h, admin, key } = await world();
    await announce(h, admin, { message: 'Streaming notice', frequency: 'every_request' });
    const res = await v1(h, key, chat({ stream: true }));
    expect(notices(res)).toHaveLength(1);
    const deltas = (await res.text()).split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)) as { choices: { delta: { content?: string } }[] });
    const texts = deltas.map((d) => d.choices[0]?.delta.content).filter((t): t is string => !!t);
    expect(texts[0]).toBe('📢 ClawRouter: Streaming notice\n\n');
    expect(texts.length).toBeGreaterThan(1);

    const r = await v1(h, key, { model: 'gpt-4o-mini', input: 'Hi' }, '/responses');
    expect(r.status).toBe(200);
    const out = await json<{ output: { type: string; content?: { text: string }[] }[] }>(r);
    expect(out.output.find((o) => o.type === 'message')!.content![0]!.text).toStartWith('📢 ClawRouter: Streaming notice\n\n');
  });

  test('cleanup: notice lines sent back in the conversation never reach the provider; switchable', async () => {
    const { h, admin, key } = await world();
    const history = (assistant: string) => chat({ messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: assistant },
      { role: 'user', content: 'And then?' },
    ] }, 'openai/gpt-4o-mini');
    const sent = () => (mock.requests.at(-1)!.body as { messages: { role: string; content: string }[] }).messages.find((m) => m.role === 'assistant')!.content;

    await v1(h, key, history('⚠️ ClawRouter: Health is degraded.\n📢 ClawRouter: Maintenance at 22:00.\n\nHello! How can I help?'));
    expect(sent()).toBe('Hello! How can I help?');
    // Only ClawRouter's own block at the very start is removed.
    await v1(h, key, history('Hello! ⚠️ ClawRouter: this is quoted text, not a notice.'));
    expect(sent()).toBe('Hello! ⚠️ ClawRouter: this is quoted text, not a notice.');
    await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { noticeCleanupEnabled: 0 } } });
    await v1(h, key, history('⚠️ ClawRouter: Health is degraded.\n\nHello!'));
    expect(sent()).toBe('⚠️ ClawRouter: Health is degraded.\n\nHello!');
  });

  test('announcement frequencies: once per user, once a day in its time zone, every request', async () => {
    const { h, admin, key } = await world();
    const keyB = await createKey(h, admin, { name: 'same owner' });
    const bob = await h.addUser('bob', ['OPERATOR']);
    const bobCookie = await h.login('bob');
    const bobKey = (await data<CreatedApiKey>(await h.request('/api/me/api-keys', { method: 'POST', cookie: bobCookie, json: { name: 'bob', expiry: { type: 'after', hours: 24 } } }))).secret;
    expect(bob.id).toBeTruthy();

    const once = await announce(h, admin, { message: 'Welcome to ClawRouter', frequency: 'once' });
    const kinds = async (k: string) => (notices(await v1(h, k, chat())) ?? []).map((n) => n.text);
    expect(await kinds(key)).toEqual(['Welcome to ClawRouter']);
    expect(await kinds(key)).toEqual([]);
    expect(await kinds(keyB)).toEqual([]); // same user, another key: already seen
    expect(await kinds(bobKey)).toEqual(['Welcome to ClawRouter']);
    await h.request(`/api/announcements/${once.id}`, { method: 'DELETE', cookie: admin });

    // Daily, in Tokyo time: the day changes at 15:00 UTC.
    h.clock.time = Date.parse('2026-11-18T10:00:00Z');
    await announce(h, await h.login(), { message: 'Daily tip', frequency: 'daily', timeZone: 'Asia/Tokyo' });
    expect(await kinds(key)).toEqual(['Daily tip']);
    h.clock.time = Date.parse('2026-11-18T14:59:00Z');
    expect(await kinds(key)).toEqual([]);
    h.clock.time = Date.parse('2026-11-18T15:01:00Z');
    expect(await kinds(key)).toEqual(['Daily tip']);

    const list = await data<AnnouncementInfo[]>(await h.request('/api/announcements', { cookie: (await h.login()) }));
    const daily = list.find((a) => a.message === 'Daily tip')!;
    expect(daily).toMatchObject({ frequency: 'daily', reachedUsers: 1, deliveries: 2, createdBy: 'admin', timeZone: 'Asia/Tokyo' });
  });

  test('weekly announcements start again on Monday', async () => {
    const { h, key } = await world();
    h.clock.time = Date.parse('2026-11-18T12:00:00Z'); // Wednesday
    await announce(h, await h.login(), { message: 'Weekly digest', frequency: 'weekly' });
    const texts = async () => (notices(await v1(h, key, chat())) ?? []).map((n) => n.text);
    expect(await texts()).toEqual(['Weekly digest']);
    h.clock.time = Date.parse('2026-11-22T23:00:00Z'); // Sunday
    expect(await texts()).toEqual([]);
    h.clock.time = Date.parse('2026-11-23T00:30:00Z'); // Monday
    expect(await texts()).toEqual(['Weekly digest']);
  });

  test('channels, start time, expiry (self-deleting) and turning one off', async () => {
    const { h, admin, key } = await world();
    const start = new Date(h.clock.now().getTime() + 60 * 60_000).toISOString();
    const end = new Date(h.clock.now().getTime() + 2 * 60 * 60_000).toISOString();
    const timed = await announce(h, admin, { message: 'Window only', frequency: 'every_request', channel: 'header', startsAt: start, expiresAt: end });
    let res = await v1(h, key, chat());
    expect(notices(res)).toBeNull();
    h.clock.advance(61 * 60_000);
    let cookie = await h.login();
    res = await v1(h, key, chat());
    expect(notices(res)).toEqual([{ kind: 'announcement', icon: '📢', text: 'Window only' }]);
    expect(await content(res)).not.toContain('ClawRouter:'); // header channel only

    const off = await h.request(`/api/announcements/${timed.id}`, { method: 'PATCH', cookie, json: { enabled: false } });
    expect((await data<AnnouncementInfo>(off)).enabled).toBe(false);
    expect(notices(await v1(h, key, chat()))).toBeNull();
    await h.request(`/api/announcements/${timed.id}`, { method: 'PATCH', cookie, json: { enabled: true } });

    h.clock.advance(60 * 60_000);
    cookie = await h.login();
    expect(notices(await v1(h, key, chat()))).toBeNull();
    const list = await data<AnnouncementInfo[]>(await h.request('/api/announcements', { cookie }));
    expect(list.find((a) => a.id === timed.id)).toBeUndefined(); // deleted itself
    expect(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM announcement_deliveries')!.n).toBe(0);
  });

  test('announcement input is validated; changes are audited; only announcements.manage may manage them', async () => {
    const { h, admin } = await world();
    const bad = async (body: Record<string, unknown>) => (await h.request('/api/announcements', { method: 'POST', cookie: admin, json: { message: 'm', frequency: 'once', channel: 'both', timeZone: 'UTC', ...body } })).status;
    expect(await bad({ message: '' })).toBe(400);
    expect(await bad({ message: 'x'.repeat(301) })).toBe(400);
    expect(await bad({ frequency: 'hourly' })).toBe(400);
    expect(await bad({ channel: 'email' })).toBe(400);
    expect(await bad({ timeZone: 'Mars/Olympus' })).toBe(400);
    expect(await bad({ expiresAt: '2000-01-01T00:00:00Z' })).toBe(400);
    expect(await bad({ startsAt: '2030-01-02T00:00:00Z', expiresAt: '2030-01-01T00:00:00Z' })).toBe(400);
    const a = await announce(h, admin, { message: 'Audited', frequency: 'once' });
    await h.request(`/api/announcements/${a.id}`, { method: 'PATCH', cookie: admin, json: { message: 'Audited, changed' } });
    expect((await h.request(`/api/announcements/${a.id}`, { method: 'DELETE', cookie: admin })).status).toBe(204);
    expect((await h.request(`/api/announcements/${a.id}`, { method: 'DELETE', cookie: admin })).status).toBe(404);
    const actions = h.audit.list({ limit: 50 }).filter((x) => x.resourceId === a.id).map((x) => x.action).sort();
    expect(actions).toEqual(['ANNOUNCEMENT_CREATED', 'ANNOUNCEMENT_DELETED', 'ANNOUNCEMENT_UPDATED']);
    await h.addUser('op', ['OPERATOR']);
    const op = await h.login('op');
    expect((await h.request('/api/announcements', { cookie: op })).status).toBe(403);
    expect((await h.request('/api/settings/notices', { cookie: op })).status).toBe(403);
  });

  test('which health results count as a problem for users', () => {
    const c = (component: string, status: string) => ({ component, status });
    expect(healthProblemIn([c('platform', 'HEALTHY'), c('providers', 'UNKNOWN')])).toBe(false); // not checked yet
    expect(healthProblemIn([c('providers', 'DEGRADED')])).toBe(false); // one of several down: failover covers it
    expect(healthProblemIn([c('providers', 'OFFLINE')])).toBe(true); // all of them
    expect(healthProblemIn([c('database', 'DEGRADED')])).toBe(true);
    expect(healthProblemIn([c('gateway', 'OFFLINE')])).toBe(true);
    expect(healthProblemIn([])).toBe(false);
  });

  test('announcement icons: chosen per announcement, in the reply and the header; emoji in the message; cleanup knows every icon', async () => {
    const { h, admin, key } = await world();
    const a = await announce(h, admin, { message: 'New models are live 🎉 try them', frequency: 'every_request', icon: '🚀' });
    expect(a.icon).toBe('🚀');
    let res = await v1(h, key, chat());
    expect(notices(res)).toEqual([{ kind: 'announcement', icon: '🚀', text: 'New models are live 🎉 try them' }]);
    expect(/^[\x20-\x7e]*$/.test(res.headers.get('x-clawrouter-notices')!)).toBe(true);
    expect(await content(res)).toStartWith('🚀 ClawRouter: New models are live 🎉 try them\n\n');

    const changed = await h.request(`/api/announcements/${a.id}`, { method: 'PATCH', cookie: admin, json: { icon: 'ℹ️' } });
    expect((await data<AnnouncementInfo>(changed)).icon).toBe('ℹ️');
    res = await v1(h, key, chat());
    expect(await content(res)).toStartWith('ℹ️ ClawRouter: New models are live');
    const old = await announce(h, admin, { message: 'Default icon', frequency: 'once' });
    expect(old.icon).toBe('📢');

    // Not in the list: refused (the cleanup only knows listed icons).
    expect((await h.request('/api/announcements', { method: 'POST', cookie: admin, json: { message: 'm', frequency: 'once', channel: 'both', timeZone: 'UTC', icon: '🦄' } })).status).toBe(400);
    expect((await h.request(`/api/announcements/${a.id}`, { method: 'PATCH', cookie: admin, json: { icon: 'x' } })).status).toBe(400);

    // Every listed icon is removed by the cleanup, with or without the emoji variation selector.
    for (const { icon } of ANNOUNCEMENT_ICONS) {
      expect(stripNotices(`${icon} ClawRouter: hello\n\nAnswer`)).toBe('Answer');
      expect(stripNotices(`${icon.replace(/️/g, '')} ClawRouter: hello\n\nAnswer`)).toBe('Answer');
    }
    expect(stripNotices('🦄 ClawRouter: not ours\n\nAnswer')).toBe('🦄 ClawRouter: not ours\n\nAnswer');
  });

  test('format helpers: one line, ASCII header, strict cleanup', () => {
    const n = [{ kind: 'health' as const, icon: '⚠️', text: 'Ünïcode — fine\nnext', channel: 'both' as const }];
    const value = headerValue(n);
    expect(/^[\x20-\x7e]*$/.test(value)).toBe(true);
    expect(JSON.parse(value)).toEqual([{ kind: 'health', icon: '⚠️', text: 'Ünïcode — fine next' }]);
    expect(replyPrefix(n)).toBe('⚠️ ClawRouter: Ünïcode — fine next\n\n');
    expect(stripNotices(`${replyPrefix(n)}Answer`)).toBe('Answer');
    expect(stripNotices('⚠️ ClawRouter: only a notice')).toBe('');
    expect(stripNotices('Answer\n⚠️ ClawRouter: later line')).toBe('Answer\n⚠️ ClawRouter: later line');
    expect(stripNotices('⚠️ ClawRouter said hello')).toBe('⚠️ ClawRouter said hello');
  });
});
