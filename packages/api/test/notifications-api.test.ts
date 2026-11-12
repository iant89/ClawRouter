import { describe, expect, test } from 'bun:test';
import type { ApiSuccess, NotificationInfo, NotificationMeta } from '@clawapi/shared';
import { createHarness } from '../../../tests/support/harness.ts';

type List = ApiSuccess<NotificationInfo[]> & { meta: NotificationMeta };
const json = async <T>(res: Response) => (await res.json()) as T;

describe('/api/notifications', () => {
  test('list, mark read, mark all read, dismiss', async () => {
    const h = createHarness();
    const cookie = await h.completeSetup();
    const first = h.notifications.notify({ audiencePermission: 'health.read', severity: 'WARNING', title: 'one', source: 't' });
    h.clock.advance(1);
    h.notifications.notify({ audiencePermission: 'health.read', severity: 'INFO', title: 'two', source: 't' });

    let list = await json<List>(await h.request('/api/notifications', { cookie }));
    expect(list.meta.unread).toBe(2);
    expect(list.data.map((n) => n.title)).toEqual(['two', 'one']);

    expect((await h.request(`/api/notifications/${first}/read`, { method: 'POST', cookie, json: {} })).status).toBe(204);
    list = await json<List>(await h.request('/api/notifications?unread=true', { cookie }));
    expect(list.data.map((n) => n.title)).toEqual(['two']);

    const all = await h.request('/api/notifications/read-all', { method: 'POST', cookie, json: {} });
    expect((await json<ApiSuccess<{ marked: number }>>(all)).data.marked).toBe(1);

    expect((await h.request(`/api/notifications/${first}`, { method: 'DELETE', cookie })).status).toBe(204);
    list = await json<List>(await h.request('/api/notifications', { cookie }));
    expect(list.data.map((n) => n.title)).toEqual(['two']);
    expect(list.meta.unread).toBe(0);
  });

  test('requires a session; foreign or unknown ids are 404', async () => {
    const h = createHarness();
    expect((await h.request('/api/notifications')).status).toBe(401);
    await h.completeSetup();
    const viewer = (await h.addUser('v', ['VIEWER'])).id;
    const cookie = await h.login('v');
    const adminOnly = h.notifications.notify({ audiencePermission: 'audit.read', severity: 'INFO', title: 'x', source: 't' });
    expect((await json<List>(await h.request('/api/notifications', { cookie }))).data).toEqual([]);
    expect((await h.request(`/api/notifications/${adminOnly}/read`, { method: 'POST', cookie, json: {} })).status).toBe(404);
    expect((await h.request('/api/notifications/nope', { method: 'DELETE', cookie })).status).toBe(404);
    expect(viewer).toBeTruthy();
  });

  test('validates limit', async () => {
    const h = createHarness();
    const cookie = await h.completeSetup();
    expect((await h.request('/api/notifications?limit=0', { cookie })).status).toBe(400);
  });
});
