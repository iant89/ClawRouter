import { describe, expect, test } from 'bun:test';
import type { AdminSessionInfo, ApiErrorBody, ApiSuccess, PageMeta, RevokeResult } from '@clawapi/shared';
import { createHarness } from '../../../tests/support/harness.ts';

const json = async <T>(res: Response) => (await res.json()) as T;
type Page = ApiSuccess<AdminSessionInfo[]> & { meta: PageMeta };

async function twoUsers() {
  const h = createHarness();
  const admin = await h.completeSetup();
  const bob = await h.addUser('bob');
  const bob1 = await h.login('bob');
  const bob2 = await h.login('bob');
  return { h, admin, bob, bob1, bob2 };
}

describe('GET /api/sessions', () => {
  test('lists live sessions of every user with their owner, newest first', async () => {
    const { h, admin } = await twoUsers();
    const page = await json<Page>(await h.request('/api/sessions', { cookie: admin }));
    expect(page.meta).toEqual({ page: 1, pageSize: 25, total: 3 });
    expect(page.data.map((s) => s.user.username).sort()).toEqual(['admin', 'bob', 'bob']);
    expect(page.data.filter((s) => s.current).map((s) => s.user.username)).toEqual(['admin']);
    expect(JSON.stringify(page)).not.toMatch(/token/i);
  });

  test('filters by user and paginates on the server', async () => {
    const { h, admin, bob } = await twoUsers();
    const filtered = await json<Page>(await h.request(`/api/sessions?userId=${bob.id}`, { cookie: admin }));
    expect(filtered.meta.total).toBe(2);
    const p2 = await json<Page>(await h.request('/api/sessions?page=2&pageSize=2', { cookie: admin }));
    expect(p2.meta).toEqual({ page: 2, pageSize: 2, total: 3 });
    expect(p2.data).toHaveLength(1);
  });

  test('excludes revoked, idle-expired and expired sessions', async () => {
    const { h, admin, bob1 } = await twoUsers();
    await h.request('/api/auth/logout', { method: 'POST', cookie: bob1 });
    expect((await json<Page>(await h.request('/api/sessions', { cookie: admin }))).meta.total).toBe(2);
    h.clock.advance(61 * 60_000); // past the 60-minute idle timeout for everyone
    const fresh = await h.login();
    expect((await json<Page>(await h.request('/api/sessions', { cookie: fresh }))).meta.total).toBe(1);
  });

  test('rejects bad paging parameters', async () => {
    const { h, admin } = await twoUsers();
    const res = await h.request('/api/sessions?pageSize=1000', { cookie: admin });
    expect(res.status).toBe(400);
    expect((await json<ApiErrorBody>(res)).error.details?.issues?.[0]?.path).toBe('pageSize');
  });

  test('requires a session', async () => {
    expect((await createHarness().request('/api/sessions')).status).toBe(401);
  });
});

describe('DELETE /api/sessions/:id', () => {
  test("revokes another user's session immediately, audited and evented", async () => {
    const { h, admin, bob1, bob2 } = await twoUsers();
    const events: string[] = [];
    h.events.on('session.revoked', (e) => { events.push(e.reason); });
    const list = await json<Page>(await h.request('/api/sessions', { cookie: admin }));
    const target = list.data.find((s) => s.user.username === 'bob')!;

    const res = await h.request(`/api/sessions/${target.id}`, { method: 'DELETE', cookie: admin });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toEqual([]); // the admin stays signed in

    const statuses = [(await h.request('/api/auth/session', { cookie: bob1 })).status, (await h.request('/api/auth/session', { cookie: bob2 })).status];
    expect(statuses.sort()).toEqual([200, 401]);
    expect(events).toEqual(['REVOKED']);
    const [record] = h.audit.list({ action: 'SESSION_REVOKED' });
    expect(record).toMatchObject({ actorName: 'admin', resource: 'session', resourceId: target.id });
    expect(record!.metadata).toMatchObject({ scope: 'single', own: false });
  });

  test('revoking your own current session signs you out', async () => {
    const { h, admin } = await twoUsers();
    const mine = (await json<Page>(await h.request('/api/sessions', { cookie: admin }))).data.find((s) => s.current)!;
    const res = await h.request(`/api/sessions/${mine.id}`, { method: 'DELETE', cookie: admin });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()[0]).toContain('Max-Age=0');
    expect((await h.request('/api/auth/session', { cookie: admin })).status).toBe(401);
  });

  test('unknown or already revoked sessions are 404', async () => {
    const { h, admin } = await twoUsers();
    expect((await h.request('/api/sessions/nope', { method: 'DELETE', cookie: admin })).status).toBe(404);
    const target = (await json<Page>(await h.request('/api/sessions', { cookie: admin }))).data.find((s) => !s.current)!;
    await h.request(`/api/sessions/${target.id}`, { method: 'DELETE', cookie: admin });
    expect((await h.request(`/api/sessions/${target.id}`, { method: 'DELETE', cookie: admin })).status).toBe(404);
  });

  test('needs the CSRF header', async () => {
    const { h, admin } = await twoUsers();
    const target = (await json<Page>(await h.request('/api/sessions', { cookie: admin }))).data.find((s) => !s.current)!;
    expect((await h.request(`/api/sessions/${target.id}`, { method: 'DELETE', cookie: admin, csrf: false })).status).toBe(403);
  });
});

describe('POST /api/sessions/revoke', () => {
  test("revokes all of a user's sessions with one audit record", async () => {
    const { h, admin, bob, bob1, bob2 } = await twoUsers();
    const res = await h.request('/api/sessions/revoke', { method: 'POST', cookie: admin, json: { userId: bob.id } });
    expect((await json<ApiSuccess<RevokeResult>>(res)).data).toEqual({ revoked: 2 });
    expect((await h.request('/api/auth/session', { cookie: bob1 })).status).toBe(401);
    expect((await h.request('/api/auth/session', { cookie: bob2 })).status).toBe(401);
    expect((await h.request('/api/auth/session', { cookie: admin })).status).toBe(200);
    const records = h.audit.list({ action: 'SESSION_REVOKED' });
    expect(records).toHaveLength(1);
    expect(records[0]!.metadata).toMatchObject({ scope: 'all', count: 2 });
  });

  test('keepCurrent keeps the caller signed in when revoking their own sessions', async () => {
    const { h, admin } = await twoUsers();
    const other = await h.login('admin');
    const me = (await json<ApiSuccess<{ user: { id: string } }>>(await h.request('/api/auth/session', { cookie: admin }))).data.user.id;
    const res = await h.request('/api/sessions/revoke', { method: 'POST', cookie: admin, json: { userId: me, keepCurrent: true } });
    expect((await json<ApiSuccess<RevokeResult>>(res)).data.revoked).toBe(1);
    expect((await h.request('/api/auth/session', { cookie: admin })).status).toBe(200);
    expect((await h.request('/api/auth/session', { cookie: other })).status).toBe(401);
  });

  test('a user with no sessions revokes nothing and writes no audit record', async () => {
    const { h, admin } = await twoUsers();
    const { id } = await h.addUser('carol');
    const res = await h.request('/api/sessions/revoke', { method: 'POST', cookie: admin, json: { userId: id } });
    expect((await json<ApiSuccess<RevokeResult>>(res)).data.revoked).toBe(0);
    expect(h.audit.list({ action: 'SESSION_REVOKED' })).toHaveLength(0);
  });

  test('validates the body', async () => {
    const { h, admin } = await twoUsers();
    expect((await h.request('/api/sessions/revoke', { method: 'POST', cookie: admin, json: {} })).status).toBe(400);
  });
});

describe('POST /api/auth/sessions/revoke-others', () => {
  test('signs out everywhere except this browser', async () => {
    const { h, bob1, bob2 } = await twoUsers();
    const bob3 = await h.login('bob');
    const res = await h.request('/api/auth/sessions/revoke-others', { method: 'POST', cookie: bob3, json: {} });
    expect((await json<ApiSuccess<RevokeResult>>(res)).data.revoked).toBe(2);
    expect((await h.request('/api/auth/session', { cookie: bob3 })).status).toBe(200);
    expect((await h.request('/api/auth/session', { cookie: bob1 })).status).toBe(401);
    expect((await h.request('/api/auth/session', { cookie: bob2 })).status).toBe(401);
  });
});
