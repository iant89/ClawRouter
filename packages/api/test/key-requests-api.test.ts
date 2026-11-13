import { describe, expect, test } from 'bun:test';
import type { ApiErrorBody, ApiKeyInfo, ApiKeyRequestInfo, ApiSuccess, CreatedApiKey, RoleInfo } from '@clawrouter/shared';
import { createHarness, type Harness } from '../../../tests/support/harness.ts';

const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;
const errorOf = async (res: Response) => ((await res.json()) as ApiErrorBody).error;
const v1 = (h: Harness, key: string) => h.request('/v1/models', { headers: { authorization: `Bearer ${key}` } });
const notified = (h: Harness, source: string) =>
  (h.db.all<{ user_id: string; title: string; body: string }>('SELECT user_id, title, body FROM notifications WHERE source = ? ORDER BY created_at', [source]));

async function world() {
  const h = createHarness();
  const admin = await h.completeSetup();
  const role = async (name: string, permissions: string[]) => (await data<RoleInfo>(await h.request('/api/roles', { method: 'POST', cookie: admin, json: { name, permissions } }))).id;
  const selfService = await role('Developer', ['models.read', 'api_keys.own']);
  const keyManager = await role('Key manager', ['api_keys.read', 'api_keys.write', 'requests.read']);
  const ids = {
    admin: h.users.findByUsername('admin')!.id,
    dev: (await h.addUser('dev', [selfService])).id,
    viewer: (await h.addUser('val', ['VIEWER'])).id,
    manager: (await h.addUser('kim', [keyManager])).id,
    // An administrator who is also a Viewer: shares a role with Viewer requesters.
    adminViewer: (await h.addUser('ada2', ['ADMIN', 'VIEWER'])).id,
  };
  return { h, admin, ids, dev: await h.login('dev'), viewer: await h.login('val'), manager: await h.login('kim') };
}

describe('own API keys (api_keys.own)', () => {
  test('a user with the permission creates, lists and revokes their own keys, with the expiry they chose', async () => {
    const { h, ids } = await world();
    let dev: string;
    h.clock.time = Date.parse('2026-11-13T15:00:00Z');
    dev = await h.login('dev');
    const today = await data<CreatedApiKey>(await h.request('/api/me/api-keys', { method: 'POST', cookie: dev, json: { name: 'today only', expiry: { type: 'end_of_day', timeZone: 'America/New_York' } } }));
    expect(today.key.expiresAt).toBe('2026-11-14T05:00:00.000Z');
    expect(today.key.createdBy?.id).toBe(ids.dev);
    const week = await data<CreatedApiKey>(await h.request('/api/me/api-keys', { method: 'POST', cookie: dev, json: { name: 'a week', expiry: { type: 'after', hours: 168 } } }));
    expect(week.key.expiresAt).toBe('2026-11-20T15:00:00.000Z');
    expect((await v1(h, today.secret)).status).toBe(200);

    const mine = await data<ApiKeyInfo[]>(await h.request('/api/me/api-keys', { cookie: dev }));
    expect(mine.map((k) => k.name).sort()).toEqual(['a week', 'today only']);
    expect(JSON.stringify(mine)).not.toContain(today.secret.slice(13));

    // The day ends: the key stops working by itself.
    h.clock.time = Date.parse('2026-11-14T05:00:01Z');
    expect((await v1(h, today.secret)).status).toBe(401);
    const revoked = await h.request(`/api/me/api-keys/${week.key.id}`, { method: 'DELETE', cookie: await h.login('dev') });
    expect((await data<ApiKeyInfo>(revoked)).status).toBe('REVOKED');
  });

  test('limits are for administrators; other people\'s keys cannot be seen or revoked', async () => {
    const { h, admin, dev, viewer } = await world();
    const limited = await h.request('/api/me/api-keys', { method: 'POST', cookie: dev, json: { name: 'x', rateLimit: { requestsPerMinute: 99999, tokensPerMinute: null } } });
    expect(limited.status).toBe(400);
    const adminKey = await data<CreatedApiKey>(await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'service', expiry: { type: 'after', hours: 1 } } }));
    expect((await h.request(`/api/me/api-keys/${adminKey.key.id}`, { method: 'DELETE', cookie: dev })).status).toBe(404);
    expect((await data<ApiKeyInfo[]>(await h.request('/api/me/api-keys', { cookie: dev })))).toEqual([]);
    // Without the permission: no creating (they can request instead).
    expect((await h.request('/api/me/api-keys', { method: 'POST', cookie: viewer, json: { name: 'x' } })).status).toBe(403);
    expect((await h.request('/api/me/api-keys', { cookie: viewer })).status).toBe(200);
  });
});

describe('key requests (owner rule)', () => {
  test('approvers outside the requester\'s roles are notified; the approver never sees the key', async () => {
    const { h, ids, viewer, manager } = await world();
    const res = await h.request('/api/me/api-key-requests', {
      method: 'POST', cookie: viewer, json: { name: 'Reporting script', purpose: 'Nightly summaries for the support team', allowedModels: ['gpt-4o', 'claude-sonnet'], expiry: { type: 'after', hours: 720 } },
    });
    expect(res.status).toBe(201);
    const request = await data<ApiKeyRequestInfo>(res);
    expect(request).toMatchObject({ status: 'PENDING', requestedBy: { username: 'val' }, expiry: { type: 'after', hours: 720 } });

    // Admin and Key manager hold api_keys.write; ada2 does too but shares the Viewer role; dev cannot approve.
    expect(notified(h, 'api_key_request.created').map((n) => n.user_id).sort()).toEqual([ids.admin, ids.manager].sort());
    expect(notified(h, 'api_key_request.created')[0]!.body).toContain('val asked for an API key "Reporting script"');

    // The approver narrows the models and the lifetime.
    const approved = await data<ApiKeyRequestInfo>(await h.request(`/api/api-key-requests/${request.id}/approve`, {
      method: 'POST', cookie: manager, json: { allowedModels: ['gpt-4o'], expiry: { type: 'after', hours: 24 }, note: 'One day to start with' },
    }));
    expect(approved).toMatchObject({ status: 'APPROVED', allowedModels: ['gpt-4o'], expiry: { type: 'after', hours: 24 }, decidedBy: { username: 'kim' }, decisionNote: 'One day to start with' });
    expect(JSON.stringify(approved)).not.toMatch(/crk_[0-9a-f]{8}_/);
    const told = notified(h, 'api_key_request.decided');
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ user_id: ids.viewer, title: 'API key request approved' });

    // The requester creates the key: it is theirs, with what was approved.
    const made = await h.request(`/api/me/api-key-requests/${request.id}/create`, { method: 'POST', cookie: viewer });
    expect(made.status).toBe(201);
    expect(made.headers.get('cache-control')).toBe('no-store');
    const key = await data<CreatedApiKey & { request: ApiKeyRequestInfo }>(made);
    expect(key.key).toMatchObject({ name: 'Reporting script', allowedModels: ['gpt-4o'], createdBy: { id: ids.viewer } });
    expect(Date.parse(key.key.expiresAt!) - h.clock.time).toBe(24 * 3_600_000);
    expect(key.request).toMatchObject({ status: 'FULFILLED', apiKeyId: key.key.id });
    expect((await v1(h, key.secret)).status).toBe(200);
    // Once only.
    expect((await h.request(`/api/me/api-key-requests/${request.id}/create`, { method: 'POST', cookie: viewer })).status).toBe(409);

    // It is the requester's key: listed as theirs, revocable by them, suspended with them.
    expect((await data<ApiKeyInfo[]>(await h.request('/api/me/api-keys', { cookie: viewer }))).map((k) => k.id)).toEqual([key.key.id]);
    await h.userAdmin.update({ id: null, username: 'test' }, ids.viewer, { status: 'DISABLED' }, { ip: null, userAgent: null });
    expect((await v1(h, key.secret)).status).toBe(401);

    const actions = h.audit.list().filter((r) => r.resourceId === request.id).map((r) => r.action).sort();
    expect(actions).toEqual(['API_KEY_REQUESTED', 'API_KEY_REQUEST_APPROVED']);
    expect(JSON.stringify(h.db.all('SELECT * FROM audit_log')) + JSON.stringify(h.db.all('SELECT * FROM notifications'))).not.toContain(key.secret.slice(13));
  });

  test('a denial tells the requester why; cancelled and decided requests cannot change again', async () => {
    const { h, ids, viewer, manager } = await world();
    const submit = async (name: string) => data<ApiKeyRequestInfo>(await h.request('/api/me/api-key-requests', { method: 'POST', cookie: viewer, json: { name, purpose: 'testing' } }));
    const a = await submit('first');
    const denied = await h.request(`/api/api-key-requests/${a.id}/deny`, { method: 'POST', cookie: manager, json: { reason: 'Use the shared reporting key instead' } });
    expect((await data<ApiKeyRequestInfo>(denied)).status).toBe('DENIED');
    expect(notified(h, 'api_key_request.decided')[0]).toMatchObject({ user_id: ids.viewer, title: 'API key request denied' });
    expect(notified(h, 'api_key_request.decided')[0]!.body).toContain('Use the shared reporting key instead');
    expect((await h.request(`/api/me/api-key-requests/${a.id}/create`, { method: 'POST', cookie: viewer })).status).toBe(409);
    expect((await h.request(`/api/api-key-requests/${a.id}/approve`, { method: 'POST', cookie: manager, json: {} })).status).toBe(409);
    expect((await h.request(`/api/api-key-requests/${a.id}/deny`, { method: 'POST', cookie: manager, json: { reason: '' } })).status).toBe(400);

    const b = await submit('second');
    expect((await data<ApiKeyRequestInfo>(await h.request(`/api/me/api-key-requests/${b.id}`, { method: 'DELETE', cookie: viewer }))).status).toBe('CANCELLED');
    expect((await h.request(`/api/api-key-requests/${b.id}/approve`, { method: 'POST', cookie: manager, json: {} })).status).toBe(409);
  });

  test('people who can create keys are told to do so; requests are private to their requester', async () => {
    const { h, dev, viewer, manager } = await world();
    const self = await h.request('/api/me/api-key-requests', { method: 'POST', cookie: dev, json: { name: 'x', purpose: 'y' } });
    expect(self.status).toBe(409);
    expect((await errorOf(self)).message).toBe('You can create API keys yourself; no request is needed.');
    expect((await h.request('/api/me/api-key-requests', { method: 'POST', cookie: manager, json: { name: 'x', purpose: 'y' } })).status).toBe(409);

    const r = await data<ApiKeyRequestInfo>(await h.request('/api/me/api-key-requests', { method: 'POST', cookie: viewer, json: { name: 'mine', purpose: 'y' } }));
    const other = await h.login('ada2');
    expect((await h.request(`/api/me/api-key-requests/${r.id}`, { method: 'DELETE', cookie: other })).status).toBe(404);
    expect((await h.request(`/api/me/api-key-requests/${r.id}/create`, { method: 'POST', cookie: other })).status).toBe(404);
    expect(await data<unknown[]>(await h.request('/api/me/api-key-requests', { cookie: other }))).toEqual([]);
    // Only approvers see everyone's.
    expect((await h.request('/api/api-key-requests', { cookie: viewer })).status).toBe(403);
    const pending = await h.request('/api/api-key-requests?status=PENDING', { cookie: manager });
    expect((await data<ApiKeyRequestInfo[]>(pending)).map((x) => x.name)).toEqual(['mine']);
    expect((await h.request('/api/api-key-requests?status=MAYBE', { cookie: manager })).status).toBe(400);
  });

  test('validation and the pending limit', async () => {
    const { h, viewer } = await world();
    const post = (json: unknown) => h.request('/api/me/api-key-requests', { method: 'POST', cookie: viewer, json });
    expect((await post({ name: 'x' })).status).toBe(400);
    expect((await post({ name: 'x', purpose: 'y', expiry: { type: 'end_of_day', timeZone: 'Nowhere/Land' } })).status).toBe(400);
    expect((await post({ name: 'x', purpose: 'y', expiry: { type: 'at', at: '2020-01-01T00:00:00Z' } })).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await post({ name: `k${i}`, purpose: 'y' })).status).toBe(201);
    const sixth = await post({ name: 'k5', purpose: 'y' });
    expect(sixth.status).toBe(409);
  });

  test('when everyone who could approve shares a role with the requester, nobody is notified but the request is listed', async () => {
    const h = createHarness();
    await h.completeSetup();
    // The only administrator is also a Viewer; the requester is a Viewer.
    await h.addUser('both', ['ADMIN', 'VIEWER']);
    const adminId = h.users.findByUsername('admin')!.id;
    await h.userAdmin.update({ id: null, username: 'test' }, adminId, { status: 'DISABLED' }, { ip: null, userAgent: null });
    await h.addUser('val', ['VIEWER']);
    const viewer = await h.login('val');
    expect((await h.request('/api/me/api-key-requests', { method: 'POST', cookie: viewer, json: { name: 'x', purpose: 'y' } })).status).toBe(201);
    expect(notified(h, 'api_key_request.created')).toEqual([]);
    expect(h.logs.some((r) => r.msg.startsWith('API key request has nobody to notify'))).toBe(true);
    const both = await h.login('both');
    expect((await data<unknown[]>(await h.request('/api/api-key-requests', { cookie: both })))).toHaveLength(1);
  });
});
