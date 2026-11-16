import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type {
  ApiSuccess, CreatedApiKey, PutRateLimitsRequest, RateLimitConfigView, RateLimitUsage, UserQuota, UserQuotaView, UserWithRoles,
} from '@clawrouter/shared';
import { createSqliteRateLimitConfigStore, MemoryCounterStore, quotaPeriod } from '@clawrouter/rate-limits';
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
});

const actor = { id: 'u', username: 'admin' };
const client = { ip: null };
type OpenAiError = { error: { message: string; type: string; code: string } };
const json = async <T>(res: Response) => (await res.json()) as T;
const data = async <T>(res: Response) => (await json<ApiSuccess<T>>(res)).data;
const none = { window: 'minute', requests: null, tokens: null, bucket: null } as const;

/** OpenAI and a local server, both offering gpt-4o-mini (11 tokens per answer); one admin key. */
async function world() {
  const h = createHarness();
  h.setProviderFetch(fetch);
  const admin = await h.completeSetup();
  const openai = await h.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: mock.key, priority: 10 }, client);
  const local = await h.providers.create(actor, { name: 'Local', identifier: 'local', kind: 'openai_compatible', endpoint: `${mock.url}/local/v1`, priority: 20 }, client);
  h.models.create(actor, { providerId: openai.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'] }, client);
  h.models.create(actor, { providerId: local.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'] }, client);
  const res = await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'ci' } });
  expect(res.status).toBe(201);
  const key = await data<CreatedApiKey>(res);
  const adminId = (await data<{ user: { id: string } }>(await h.request('/api/auth/session', { cookie: admin }))).user.id;
  return { h, admin, key, adminId };
}

async function setLimits(h: Harness, cookie: string, patch: Partial<PutRateLimitsRequest> | Record<string, unknown>): Promise<Response> {
  const current = await data<RateLimitConfigView>(await h.request('/api/rate-limits', { cookie }));
  const { unknownModels: _u, updatedAt: _a, updatedBy: _b, ...rest } = current;
  return h.request('/api/rate-limits', { method: 'PUT', cookie, json: { ...rest, ...patch } });
}

const chat = (h: Harness, key: string) =>
  h.request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, json: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] } });

const quota = (q: Partial<UserQuota> = {}): UserQuota => ({ enabled: true, unit: 'tokens', amount: 20, period: 'day', resetHour: 0, resetWeekday: 1, resetDayOfMonth: 1, timeZone: 'UTC', ...q });

describe('rate-limit windows', () => {
  test('a per-second limit refuses the third request in a second and allows it a second later', async () => {
    const { h, admin, key } = await world();
    expect((await setLimits(h, admin, { perKey: { window: 'second', requests: 2, tokens: null, bucket: null } })).status).toBe(200);
    expect((await chat(h, key.secret)).status).toBe(200);
    expect((await chat(h, key.secret)).status).toBe(200);
    const limited = await chat(h, key.secret);
    expect(limited.status).toBe(429);
    expect((await json<OpenAiError>(limited)).error.message).toContain('2 requests per second');
    expect(Number(limited.headers.get('retry-after'))).toBeLessThanOrEqual(2);
    h.clock.advance(2_000);
    expect((await chat(h, key.secret)).status).toBe(200);
  });

  test('an hourly token limit counts tokens over the hour', async () => {
    const { h, admin, key } = await world();
    expect((await setLimits(h, admin, { perKey: { window: 'hour', requests: null, tokens: 20, bucket: null } })).status).toBe(200);
    expect((await chat(h, key.secret)).status).toBe(200);
    expect((await chat(h, key.secret)).status).toBe(200); // 11 used, still under 20
    await Bun.sleep(5); // tokens are charged just after the response
    const limited = await chat(h, key.secret);
    expect(limited.status).toBe(429);
    expect((await json<OpenAiError>(limited)).error.message).toContain('20 tokens per hour');
    h.clock.advance(30 * 60_000);
    expect((await chat(h, key.secret)).status).toBe(429); // half an hour later the sliding hour still holds them
  });

  test('older per-minute limits are accepted and upgraded: in the API, the stored document and key columns', async () => {
    const { h, admin, key } = await world();
    const res = await setLimits(h, admin, { perKey: { requestsPerMinute: 5, tokensPerMinute: null } });
    expect(res.status).toBe(200);
    expect((await data<RateLimitConfigView>(res)).perKey).toEqual({ window: 'minute', requests: 5, tokens: null, bucket: null });

    h.db.run('UPDATE rate_limit_config SET document = ? WHERE id = 1', [JSON.stringify({
      perKey: { requestsPerMinute: 7, tokensPerMinute: 100 }, perUser: { requestsPerMinute: null, tokensPerMinute: null },
      perModel: [{ model: 'openai/gpt-4o-mini', requestsPerMinute: 3, tokensPerMinute: null }],
      global: { requestsPerMinute: null, tokensPerMinute: null, maxConcurrent: 50 }, invalidKeysPerIp: 20,
    })]);
    const loaded = createSqliteRateLimitConfigStore(h.db).load();
    expect(loaded.perKey).toEqual({ window: 'minute', requests: 7, tokens: 100, bucket: null });
    expect(loaded.perModel[0]).toEqual({ model: 'openai/gpt-4o-mini', window: 'minute', requests: 3, tokens: null, bucket: null });
    expect(loaded.global).toEqual({ window: 'minute', requests: null, tokens: null, bucket: null, maxConcurrent: 50 });

    h.db.run('UPDATE api_keys SET rate_limit = ? WHERE id = ?', ['{"requestsPerMinute":1,"tokensPerMinute":null}', key.key.id]);
    const keys = await data<{ id: string; rateLimit: unknown }[]>(await h.request("/api/api-keys", { cookie: admin }));
    expect(keys.find((k) => k.id === key.key.id)?.rateLimit).toEqual({ window: 'minute', requests: 1, tokens: null, bucket: null });
    const patched = await h.request(`/api/api-keys/${key.key.id}`, { method: 'PATCH', cookie: admin, json: { rateLimit: { requestsPerMinute: 4, tokensPerMinute: null } } });
    expect(patched.status).toBe(200);
    expect((await data<{ rateLimit: unknown }>(patched)).rateLimit).toEqual({ window: 'minute', requests: 4, tokens: null, bucket: null });
  });

  test('windows are validated', async () => {
    const { h, admin } = await world();
    const res = await setLimits(h, admin, { perKey: { window: 'day', requests: 0, tokens: null, bucket: null } });
    expect(res.status).toBe(400);
    const paths = (await json<{ error: { details: { issues: { path: string }[] } } }>(res)).error.details.issues.map((i) => i.path);
    expect(paths).toEqual(['perKey.window', 'perKey.requests']);
  });
});

describe('token buckets', () => {
  test('a bucket allows a burst up to its capacity, then refills its amount at each interval', async () => {
    const { h, admin, key } = await world();
    const bucket = { capacity: 3, refillAmount: 1, refillEverySeconds: 2 };
    expect((await setLimits(h, admin, { perKey: { ...none, bucket } })).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await chat(h, key.secret)).status).toBe(200);
    const limited = await chat(h, key.secret);
    expect(limited.status).toBe(429);
    expect((await json<OpenAiError>(limited)).error.message).toBe('Too many requests in a short time for this API key (bursts of up to 3 requests, then 1 every 2 s). Try again in 2 s.');
    expect(limited.headers.get('retry-after')).toBe('2');

    h.clock.advance(2_000); // one refill
    expect((await chat(h, key.secret)).status).toBe(200);
    expect((await chat(h, key.secret)).status).toBe(429);

    h.clock.advance(60_000); // many refills, but never more than the capacity
    for (let i = 0; i < 3; i++) expect((await chat(h, key.secret)).status).toBe(200);
    expect((await chat(h, key.secret)).status).toBe(429);
  });

  test('a refused request does not take from the bucket, and the usage view shows what is left', async () => {
    const { h, admin, key } = await world();
    expect((await setLimits(h, admin, { perKey: { window: 'minute', requests: 1, tokens: null, bucket: { capacity: 5, refillAmount: 5, refillEverySeconds: 60 } } })).status).toBe(200);
    expect((await chat(h, key.secret)).status).toBe(200);
    expect((await chat(h, key.secret)).status).toBe(429); // the window refuses it, the bucket keeps 4
    const usage = await data<RateLimitUsage>(await h.request('/api/rate-limits/usage', { cookie: admin }));
    expect(usage.entries.find((e) => e.scope === 'key')).toMatchObject({ requests: 1, bucketAvailable: 4, limit: { window: 'minute', requests: 1 } });
  });

  test('a model with an empty bucket is skipped and the next model answers', async () => {
    const { h, admin, key } = await world();
    const perModel = [{ model: 'openai/gpt-4o-mini', ...none, bucket: { capacity: 1, refillAmount: 1, refillEverySeconds: 60 } }];
    expect((await setLimits(h, admin, { perModel })).status).toBe(200);
    expect((await chat(h, key.secret)).headers.get('x-clawrouter-model')).toBe('openai/gpt-4o-mini');
    expect((await chat(h, key.secret)).headers.get('x-clawrouter-model')).toBe('local/gpt-4o-mini');
  });

  test('buckets are validated', async () => {
    const { h, admin } = await world();
    const res = await setLimits(h, admin, { perUser: { ...none, bucket: { capacity: 2, refillAmount: 5, refillEverySeconds: 0 } } });
    expect(res.status).toBe(400);
    const paths = (await json<{ error: { details: { issues: { path: string }[] } } }>(res)).error.details.issues.map((i) => i.path);
    expect(paths).toEqual(['perUser.bucket.refillEverySeconds', 'perUser.bucket.refillAmount']);
  });

  test('the memory store refills in whole steps and reports when the next request fits', async () => {
    let t = 0;
    const store = new MemoryCounterStore(() => t);
    const spec = { capacity: 2, refillAmount: 1, refillEveryMs: 1_000 };
    expect((await store.takeBucket('b', spec, 1)).available).toBe(1);
    expect((await store.takeBucket('b', spec, 1)).available).toBe(0);
    t = 400;
    expect(await store.takeBucket('b', spec, 1)).toEqual({ allowed: false, available: 0, retryAfterMs: 600 });
    t = 1_000;
    expect(await store.takeBucket('b', spec, 1, true)).toEqual({ allowed: true, available: 1, retryAfterMs: 0 });
    expect((await store.takeBucket('never-used', spec, 1, true)).available).toBe(2);
  });
});

describe('quota periods', () => {
  const at = (iso: string) => new Date(iso);
  const period = (q: Partial<UserQuota>, now: string) => {
    const p = quotaPeriod(quota(q), at(now));
    return [p.start.toISOString(), p.end.toISOString()];
  };

  test('days start at the reset hour in the time zone', () => {
    expect(period({ period: 'day', resetHour: 6, timeZone: 'Europe/London' }, '2026-11-15T05:00:00Z')).toEqual(['2026-11-14T06:00:00.000Z', '2026-11-15T06:00:00.000Z']);
    expect(period({ period: 'day', resetHour: 6, timeZone: 'Europe/London' }, '2026-07-15T05:30:00Z')).toEqual(['2026-07-15T05:00:00.000Z', '2026-07-16T05:00:00.000Z']);
    expect(period({ period: 'day', resetHour: 0, timeZone: 'America/New_York' }, '2026-11-15T03:00:00Z')).toEqual(['2026-11-14T05:00:00.000Z', '2026-11-15T05:00:00.000Z']);
  });

  test('weeks start on the chosen weekday', () => {
    // 2026-11-15 is a Sunday.
    expect(period({ period: 'week', resetWeekday: 1 }, '2026-11-15T12:00:00Z')).toEqual(['2026-11-09T00:00:00.000Z', '2026-11-16T00:00:00.000Z']);
    expect(period({ period: 'week', resetWeekday: 7, resetHour: 18 }, '2026-11-15T12:00:00Z')).toEqual(['2026-11-08T18:00:00.000Z', '2026-11-15T18:00:00.000Z']);
  });

  test('months start on the chosen day, across years and daylight-saving changes', () => {
    expect(period({ period: 'month', resetDayOfMonth: 15 }, '2026-11-15T12:00:00Z')).toEqual(['2026-11-15T00:00:00.000Z', '2026-12-15T00:00:00.000Z']);
    expect(period({ period: 'month', resetDayOfMonth: 1 }, '2026-01-10T00:00:00Z')).toEqual(['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z']);
    expect(period({ period: 'month', resetDayOfMonth: 20 }, '2026-01-10T00:00:00Z')).toEqual(['2025-12-20T00:00:00.000Z', '2026-01-20T00:00:00.000Z']);
    expect(period({ period: 'month', resetDayOfMonth: 1, timeZone: 'Europe/Berlin' }, '2026-04-10T00:00:00Z')).toEqual(['2026-03-31T22:00:00.000Z', '2026-04-30T22:00:00.000Z']);
    expect(period({ period: 'month', resetDayOfMonth: 1, timeZone: 'Europe/Berlin' }, '2026-03-10T00:00:00Z')).toEqual(['2026-02-28T23:00:00.000Z', '2026-03-31T22:00:00.000Z']);
  });
});

describe('user quotas', () => {
  test('a token quota refuses the owner\'s keys once used up, with the reset time, and allows them after the reset', async () => {
    const { h, key, adminId } = await world();
    h.clock.time = Date.parse('2026-11-15T10:00:00Z');
    const admin = await h.login(); // the clock jump ended the setup session
    const put = await h.request(`/api/users/${adminId}/quota`, { method: 'PUT', cookie: admin, json: { quota: quota({ amount: 20 }) } });
    expect(put.status).toBe(200);
    expect(await data<UserQuotaView>(put)).toMatchObject({ quota: { unit: 'tokens', amount: 20 }, usage: { used: 0, limit: 20, periodStart: '2026-11-15T00:00:00.000Z', resetsAt: '2026-11-16T00:00:00.000Z' } });

    expect((await chat(h, key.secret)).status).toBe(200);
    expect((await chat(h, key.secret)).status).toBe(200);
    const limited = await chat(h, key.secret);
    expect(limited.status).toBe(429);
    const body = await json<OpenAiError>(limited);
    expect(body.error).toMatchObject({ code: 'quota_exceeded', type: 'rate_limit_error' });
    expect(body.error.message).toBe('Your usage quota is used up: 22 of 20 tokens today. It resets on Mon, 16 Nov 2026, 00:00 (UTC). An administrator can raise it.');
    expect(limited.headers.get('retry-after')).toBe(String(14 * 3600));

    const own = await data<UserQuotaView>(await h.request('/api/auth/quota', { cookie: admin }));
    expect(own.usage).toMatchObject({ used: 22, limit: 20 });

    h.clock.time = Date.parse('2026-11-16T00:00:01Z');
    const next = await h.login(); // the console session expired with the clock jump
    expect((await chat(h, key.secret)).status).toBe(200);
    expect((await data<UserQuotaView>(await h.request('/api/auth/quota', { cookie: next }))).usage?.used).toBe(11);
  });

  test('a request quota counts completed requests only', async () => {
    const { h, admin, key, adminId } = await world();
    await h.request(`/api/users/${adminId}/quota`, { method: 'PUT', cookie: admin, json: { quota: quota({ unit: 'requests', amount: 2, period: 'month' }) } });
    mock.mode = 'server_error';
    expect((await chat(h, key.secret)).status).toBeGreaterThanOrEqual(500);
    mock.mode = 'ok';
    expect((await chat(h, key.secret)).status).toBe(200);
    expect((await chat(h, key.secret)).status).toBe(200);
    const limited = await chat(h, key.secret);
    expect(limited.status).toBe(429);
    expect((await json<OpenAiError>(limited)).error.message).toContain('used up: 2 of 2 requests this month');
  });

  test('a quota can be set when the user is created, edited, and removed; every change is audited', async () => {
    const { h, admin } = await world();
    const created = await h.request('/api/users', { method: 'POST', cookie: admin, json: {
      username: 'sam', displayName: 'Sam', password: 'violet-harbour-lantern-42', roles: ['OPERATOR'],
      quota: { unit: 'cost', amount: 12.345, period: 'week', resetWeekday: 3, resetHour: 9, timeZone: 'Europe/London' },
    } });
    expect(created.status).toBe(201);
    const sam = await data<UserWithRoles>(created);
    const view = await data<UserQuotaView>(await h.request(`/api/users/${sam.id}/quota`, { cookie: admin }));
    expect(view.quota).toEqual({ enabled: true, unit: 'cost', amount: 12.35, period: 'week', resetHour: 9, resetWeekday: 3, resetDayOfMonth: 1, timeZone: 'Europe/London' });
    expect(view.usage?.used).toBe(0);

    const edited = await h.request(`/api/users/${sam.id}/quota`, { method: 'PUT', cookie: admin, json: { quota: quota({ unit: 'tokens', amount: 5000, period: 'month', resetDayOfMonth: 10 }) } });
    expect((await data<UserQuotaView>(edited)).quota).toMatchObject({ amount: 5000, period: 'month', resetDayOfMonth: 10 });
    const removed = await h.request(`/api/users/${sam.id}/quota`, { method: 'PUT', cookie: admin, json: { quota: null } });
    expect(await data<UserQuotaView>(removed)).toEqual({ userId: sam.id, quota: null, usage: null, quotasEnabled: true, enforced: false });

    const records = h.audit.search({ action: 'USER_QUOTA_UPDATED' }).items.filter((r) => r.resourceId === sam.id);
    expect(records.length).toBe(3);
    expect(records.map((r) => (r.metadata as { to: unknown }).to === null).sort()).toEqual([false, false, true]);
  });

  test('a wrong quota is refused before the user is created', async () => {
    const { h, admin } = await world();
    const res = await h.request('/api/users', { method: 'POST', cookie: admin, json: {
      username: 'kim', displayName: 'Kim', password: 'violet-harbour-lantern-42', roles: [],
      quota: { unit: 'minutes', amount: -1, period: 'year', resetHour: 24, timeZone: 'Mars/Olympus' },
    } });
    expect(res.status).toBe(400);
    const paths = (await json<{ error: { details: { issues: { path: string }[] } } }>(res)).error.details.issues.map((i) => i.path);
    expect(paths).toEqual(['quota.unit', 'quota.amount', 'quota.period', 'quota.resetHour', 'quota.timeZone']);
    expect(h.users.findByUsername('kim')).toBeUndefined();
  });

  test('quotas need users.write to change; unknown users are 404; a non-administrator cannot change an administrator\'s quota', async () => {
    const { h, admin, adminId } = await world();
    await h.addUser('olive', ['OPERATOR']);
    const op = await h.login('olive');
    expect((await h.request(`/api/users/${adminId}/quota`, { method: 'PUT', cookie: op, json: { quota: null } })).status).toBe(403);
    expect((await h.request('/api/users/nope/quota', { cookie: admin })).status).toBe(404);
    expect((await h.request('/api/users/nope/quota', { method: 'PUT', cookie: admin, json: { quota: null } })).status).toBe(404);
    expect((await h.request(`/api/users/${adminId}/quota`, { method: 'PUT', cookie: admin, json: {} })).status).toBe(400);

    const role = await data<{ id: string }>(await h.request('/api/roles', { method: 'POST', cookie: admin, json: { name: 'User manager', permissions: ['users.read', 'users.write'] } }));
    await h.addUser('uma', [role.id]);
    const manager = await h.login('uma');
    const refused = await h.request(`/api/users/${adminId}/quota`, { method: 'PUT', cookie: manager, json: { quota: quota() } });
    expect(refused.status).toBe(403);
  });
});

describe('turning quotas off', () => {
  /** Uses up a 20-token daily quota (two answers of 11 tokens). */
  async function usedUp() {
    const w = await world();
    await w.h.request(`/api/users/${w.adminId}/quota`, { method: 'PUT', cookie: w.admin, json: { quota: quota({ amount: 20 }) } });
    expect((await chat(w.h, w.key.secret)).status).toBe(200);
    expect((await chat(w.h, w.key.secret)).status).toBe(200);
    expect((await chat(w.h, w.key.secret)).status).toBe(429);
    return w;
  }

  test('one user\'s quota can be turned off and on again, keeping its settings and usage', async () => {
    const { h, admin, key, adminId } = await usedUp();
    const off = await data<UserQuotaView>(await h.request(`/api/users/${adminId}/quota`, { method: 'PUT', cookie: admin, json: { quota: quota({ amount: 20, enabled: false }) } }));
    expect(off).toMatchObject({ quota: { enabled: false, amount: 20 }, usage: { used: 22 }, quotasEnabled: true, enforced: false });
    expect((await chat(h, key.secret)).status).toBe(200);

    const on = await data<UserQuotaView>(await h.request(`/api/users/${adminId}/quota`, { method: 'PUT', cookie: admin, json: { quota: quota({ amount: 20, enabled: true }) } }));
    expect(on.enforced).toBe(true);
    expect((await chat(h, key.secret)).status).toBe(429);
    const audit = h.audit.search({ action: 'USER_QUOTA_UPDATED' }).items.filter((r) => r.resourceId === adminId);
    expect(audit.length).toBe(3);
  });

  test('the "Enforce user quotas" setting turns every quota off at once', async () => {
    const { h, admin, key } = await usedUp();
    const saved = await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { quotasEnabled: 0 } } });
    expect(saved.status).toBe(200);
    expect((await chat(h, key.secret)).status).toBe(200);
    expect(await data<UserQuotaView>(await h.request('/api/auth/quota', { cookie: admin }))).toMatchObject({ quotasEnabled: false, enforced: false, quota: { enabled: true } });

    await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { quotasEnabled: null } } }); // back to the default: on
    expect((await chat(h, key.secret)).status).toBe(429);
    expect((await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { quotasEnabled: 2 } } })).status).toBe(400);
  });

  test('quotas saved before they could be turned off are on; "enabled" must be true or false', async () => {
    const { h, admin, adminId } = await world();
    h.db.run('INSERT INTO user_quotas (user_id, quota, updated_at) VALUES (?, ?, ?)', [adminId, JSON.stringify({ unit: 'requests', amount: 5, period: 'day', resetHour: 0, resetWeekday: 1, resetDayOfMonth: 1, timeZone: 'UTC' }), '2026-01-01T00:00:00Z']);
    h.clock.advance(31_000); // past the quota cache
    expect((await data<UserQuotaView>(await h.request('/api/auth/quota', { cookie: admin }))).quota?.enabled).toBe(true);
    const bad = await h.request(`/api/users/${adminId}/quota`, { method: 'PUT', cookie: admin, json: { quota: { ...quota(), enabled: 'no' } } });
    expect(bad.status).toBe(400);
  });
});
