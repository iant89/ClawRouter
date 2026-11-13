import { describe, expect, test } from 'bun:test';
import type { ApiErrorBody, ApiKeyRequestInfo, ApiSuccess, CreatedApiKey, RoleInfo } from '@clawrouter/shared';
import { createHarness } from '../../../tests/support/harness.ts';

const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;
const errorOf = async (res: Response) => ((await res.json()) as ApiErrorBody).error;
const DAY = 24;

/**
 * Owner rule (2026-11-13): keys an Administrator creates may never expire; keys
 * anyone else creates last at most the "Maximum key lifetime" setting (30 days).
 */
async function world() {
  const h = createHarness();
  const admin = await h.completeSetup();
  const role = async (name: string, permissions: string[]) => (await data<RoleInfo>(await h.request('/api/roles', { method: 'POST', cookie: admin, json: { name, permissions } }))).id;
  await h.addUser('dev', [await role('Developer', ['models.read', 'api_keys.own'])]);
  await h.addUser('kim', [await role('Key manager', ['api_keys.read', 'api_keys.write'])]);
  await h.addUser('val', ['VIEWER']);
  return { h, admin, dev: await h.login('dev'), kim: await h.login('kim'), val: await h.login('val') };
}

describe('maximum key lifetime by creator', () => {
  test('the session tells the console each user\'s limit', async () => {
    const { h, admin, dev } = await world();
    const session = async (cookie: string) => (await data<{ keyLifetimeLimitHours: number | null }>(await h.request('/api/auth/session', { cookie }))).keyLifetimeLimitHours;
    expect(await session(admin)).toBeNull();
    expect(await session(dev)).toBe(30 * DAY);
  });

  test('administrators may create keys that never expire', async () => {
    const { h, admin } = await world();
    const res = await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'forever', expiry: { type: 'never' } } });
    expect(res.status).toBe(201);
    expect((await data<CreatedApiKey>(res)).key.expiresAt).toBeNull();
    expect((await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'ten years', expiry: { type: 'after', hours: 3650 * DAY } } })).status).toBe(201);
  });

  test('everyone else: at most 30 days by default, and never "never"', async () => {
    const { h, dev, kim } = await world();
    for (const [cookie, path] of [[dev, '/api/me/api-keys'], [kim, '/api/api-keys']] as const) {
      const never = await h.request(path, { method: 'POST', cookie, json: { name: 'forever', expiry: { type: 'never' } } });
      expect(never.status).toBe(400);
      expect((await errorOf(never)).details).toMatchObject({ issues: [{ path: 'expiry', message: expect.stringContaining('only Administrators can create keys that never expire') }] });
      // No expiry at all means "never" too.
      expect((await h.request(path, { method: 'POST', cookie, json: { name: 'unset' } })).status).toBe(400);
      expect((await h.request(path, { method: 'POST', cookie, json: { name: 'long', expiry: { type: 'after', hours: 31 * DAY } } })).status).toBe(400);
      // API Access also takes a date (expiresAt); own keys use `expiry` only.
      if (path === '/api/api-keys') {
        const atDate = await h.request(path, { method: 'POST', cookie, json: { name: 'date', expiresAt: new Date(h.clock.time + 40 * DAY * 3_600_000).toISOString() } });
        expect((await errorOf(atDate)).details).toMatchObject({ issues: [{ path: 'expiresAt' }] });
      }
      expect((await h.request(path, { method: 'POST', cookie, json: { name: 'month', expiry: { type: 'after', hours: 30 * DAY } } })).status).toBe(201);
      expect((await h.request(path, { method: 'POST', cookie, json: { name: 'today', expiry: { type: 'end_of_day', timeZone: 'UTC' } } })).status).toBe(201);
    }
  });

  test('the administrator changes the limit in Settings; it applies to new keys at once', async () => {
    const { h, admin, dev } = await world();
    const saved = await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { keyMaxLifetimeDays: 7 } } });
    expect(saved.status).toBe(200);
    const create = (hours: number) => h.request('/api/me/api-keys', { method: 'POST', cookie: dev, json: { name: `k${hours}`, expiry: { type: 'after', hours } } });
    expect((await create(8 * DAY)).status).toBe(400);
    expect((await create(7 * DAY)).status).toBe(201);
    await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { keyMaxLifetimeDays: 90 } } });
    expect((await create(90 * DAY)).status).toBe(201);
    for (const bad of [0, 3651, 1.5]) {
      expect((await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { keyMaxLifetimeDays: bad } } })).status).toBe(400);
    }
  });

  test('key requests: the requester\'s limit applies, even when an administrator approves', async () => {
    const { h, admin, val } = await world();
    const submit = (json: unknown) => h.request('/api/me/api-key-requests', { method: 'POST', cookie: val, json });
    expect((await submit({ name: 'forever', purpose: 'reports', expiry: { type: 'never' } })).status).toBe(400);
    // Without an expiry, the request asks for the longest allowed.
    const r = await data<ApiKeyRequestInfo>(await submit({ name: 'reports', purpose: 'weekly reports' }));
    expect(r.expiry).toEqual({ type: 'after', hours: 30 * DAY });
    // An administrator cannot approve a never-expiring key for them: they create it, not the administrator.
    const approveNever = await h.request(`/api/api-key-requests/${r.id}/approve`, { method: 'POST', cookie: admin, json: { expiry: { type: 'never' } } });
    expect(approveNever.status).toBe(400);
    expect((await h.request(`/api/api-key-requests/${r.id}/approve`, { method: 'POST', cookie: admin, json: {} })).status).toBe(200);
    const created = await data<CreatedApiKey>(await h.request(`/api/me/api-key-requests/${r.id}/create`, { method: 'POST', cookie: val, json: {} }));
    expect(Date.parse(created.key.expiresAt!) - h.clock.time).toBe(30 * DAY * 3_600_000);
  });
});
