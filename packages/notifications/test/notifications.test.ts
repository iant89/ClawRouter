import { describe, expect, test } from 'bun:test';
import { ADMIN, createHarness } from '../../../tests/support/harness.ts';

const recipientOf = (h: ReturnType<typeof createHarness>, userId: string) => ({ userId, permissions: [...h.authz.principalFor(userId).permissions] });

describe('notification service', () => {
  test('addresses one user or the holders of a permission, evaluated when read', async () => {
    const h = createHarness();
    const admin = (await h.addUser('a', ['ADMIN'])).id;
    const viewer = (await h.addUser('v', ['VIEWER'])).id;
    const nobody = (await h.addUser('n')).id;
    h.notifications.notify({ audiencePermission: 'audit.read', severity: 'WARNING', title: 'for auditors', source: 't' });
    h.notifications.notify({ userId: nobody, severity: 'INFO', title: 'for nobody', source: 't' });

    expect(h.notifications.list(recipientOf(h, admin)).items.map((n) => n.title)).toEqual(['for auditors']);
    expect(h.notifications.list(recipientOf(h, viewer)).items).toEqual([]);
    expect(h.notifications.list(recipientOf(h, nobody)).items.map((n) => n.title)).toEqual(['for nobody']);

    // Gaining a role makes earlier audience notifications visible.
    h.db.run("INSERT INTO user_roles (user_id, role_id, assigned_at) VALUES (?, 'OPERATOR', 'now')", [viewer]);
    expect(h.notifications.list(recipientOf(h, viewer)).items.map((n) => n.title)).toEqual(['for auditors']);
  });

  test('read and dismissed state is per user', async () => {
    const h = createHarness();
    const a = (await h.addUser('a', ['ADMIN'])).id;
    const b = (await h.addUser('b', ['ADMIN'])).id;
    const id = h.notifications.notify({ audiencePermission: 'health.read', severity: 'ERROR', title: 'x', source: 't' });
    h.notifications.notify({ audiencePermission: 'health.read', severity: 'INFO', title: 'y', source: 't' });

    expect(h.notifications.list(recipientOf(h, a)).unread).toBe(2);
    expect(h.notifications.markRead(recipientOf(h, a), id)).toBe(true);
    expect(h.notifications.list(recipientOf(h, a)).unread).toBe(1);
    expect(h.notifications.list(recipientOf(h, b)).unread).toBe(2);

    expect(h.notifications.dismiss(recipientOf(h, a), id)).toBe(true);
    expect(h.notifications.list(recipientOf(h, a)).items.map((n) => n.title)).toEqual(['y']);
    expect(h.notifications.list(recipientOf(h, b)).items).toHaveLength(2);

    expect(h.notifications.markAllRead(recipientOf(h, b))).toBe(2);
    expect(h.notifications.list(recipientOf(h, b)).unread).toBe(0);
    expect(h.notifications.list(recipientOf(h, b), { unreadOnly: true }).items).toEqual([]);
  });

  test('a user cannot touch notifications they cannot see', async () => {
    const h = createHarness();
    const a = (await h.addUser('a', ['ADMIN'])).id;
    const v = (await h.addUser('v', ['VIEWER'])).id;
    const id = h.notifications.notify({ userId: a, severity: 'INFO', title: 'private', source: 't' });
    expect(h.notifications.markRead(recipientOf(h, v), id)).toBe(false);
    expect(h.notifications.dismiss(recipientOf(h, v), id)).toBe(false);
  });

  test('only safe in-app links are kept and long text is truncated', async () => {
    const h = createHarness();
    const a = (await h.addUser('a', ['ADMIN'])).id;
    h.notifications.notify({ userId: a, severity: 'INFO', title: 'x'.repeat(500), link: 'https://evil.example', source: 't' });
    h.notifications.notify({ userId: a, severity: 'INFO', title: 'y', link: '//evil.example', source: 't' });
    h.clock.advance(1);
    h.notifications.notify({ userId: a, severity: 'INFO', title: 'z', link: '/health', source: 't' });
    const items = h.notifications.list(recipientOf(h, a)).items;
    expect(items[0]!.link).toBe('/health');
    expect(items.slice(1).every((n) => n.link === null)).toBe(true);
    expect(items.find((n) => n.title.startsWith('x'))!.title).toHaveLength(200);
  });

  test('old notifications are purged after 30 days', async () => {
    const h = createHarness();
    const a = (await h.addUser('a', ['ADMIN'])).id;
    h.notifications.notify({ userId: a, severity: 'INFO', title: 'old', source: 't' });
    h.clock.advance(31 * 86_400_000);
    h.notifications.notify({ userId: a, severity: 'INFO', title: 'new', source: 't' });
    expect(h.notifications.purgeOld()).toBe(1);
    expect(h.notifications.list(recipientOf(h, a)).items.map((n) => n.title)).toEqual(['new']);
  });
});

describe('producers', () => {
  test('health changes notify health readers, but not the normal startup', async () => {
    const h = createHarness();
    const a = (await h.addUser('a', ['VIEWER'])).id;
    h.events.emit('health.changed', { previous: 'UNKNOWN', current: 'HEALTHY', checkedAt: new Date().toISOString() });
    h.events.emit('health.changed', { previous: 'HEALTHY', current: 'OFFLINE', checkedAt: new Date().toISOString() });
    h.clock.advance(1000);
    h.events.emit('health.changed', { previous: 'OFFLINE', current: 'HEALTHY', checkedAt: new Date().toISOString() });
    const items = h.notifications.list(recipientOf(h, a)).items;
    expect(items.map((n) => [n.severity, n.title, n.link])).toEqual([
      ['SUCCESS', 'Platform health recovered', '/health'],
      ['ERROR', 'Platform health: Offline', '/health'],
    ]);
  });

  test('a role change notifies the affected user', async () => {
    const h = createHarness();
    await h.completeSetup();
    const admin = h.users.findByUsername(ADMIN.username)!;
    const bob = (await h.addUser('bob')).id;
    h.authz.setUserRoles({ id: admin.id, username: admin.username }, bob, ['OPERATOR'], { ip: null });
    const [n] = h.notifications.list(recipientOf(h, bob)).items;
    expect(n).toMatchObject({ title: 'Your roles changed', body: 'You now have: Operator.' });
  });

  test('repeated failed sign-ins notify auditors once per block, without the password', async () => {
    const h = createHarness();
    await h.completeSetup();
    const admin = h.users.findByUsername(ADMIN.username)!;
    for (let i = 0; i < 12; i++) await h.auth.login('admin', `bad-password-${i}`, { ip: '203.0.113.9', userAgent: null }).catch(() => {});
    const items = h.notifications.list(recipientOf(h, admin.id)).items.filter((n) => n.source === 'auth.login_throttled');
    expect(items).toHaveLength(1);
    expect(items[0]!.body).toContain('"admin"');
    expect(items[0]!.body).toContain('203.0.113.9');
    expect(JSON.stringify(items)).not.toContain('bad-password');
  });
});
