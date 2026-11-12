import { describe, expect, test } from 'bun:test';
import { PERMISSIONS } from '@clawapi/shared';
import { migrations, openSqlite, runMigrations, type Migration } from '@clawapi/database';
import { BUILT_IN_ROLE_PERMISSIONS, permissionsOfRole } from '../src/index.ts';
import { ADMIN, createHarness } from '../../../tests/support/harness.ts';

const client = { ip: '198.51.100.9', requestId: 'req_x' };

describe('built-in roles (spec §16)', () => {
  test('ADMIN has every permission', () => {
    expect([...BUILT_IN_ROLE_PERMISSIONS.ADMIN].sort()).toEqual([...PERMISSIONS].sort());
  });

  test('OPERATOR covers providers, models, routing, health, logs, audit, requests, usage, and no administration', () => {
    const op = new Set(permissionsOfRole('OPERATOR'));
    for (const p of ['providers.write', 'models.write', 'routing.write', 'health.read', 'logs.read', 'audit.read', 'requests.read', 'usage.read'] as const) {
      expect(op.has(p)).toBe(true);
    }
    for (const p of PERMISSIONS) if (/^(users|roles|sessions|settings|api_keys)\./.test(p)) expect(op.has(p)).toBe(false);
  });

  test('VIEWER is read-only', () => {
    expect(permissionsOfRole('VIEWER').every((p) => p.endsWith('.read'))).toBe(true);
    expect(permissionsOfRole('VIEWER')).not.toContain('audit.read');
  });

  test('unknown roles grant nothing', () => {
    expect(permissionsOfRole('CUSTOM')).toEqual([]);
  });
});

describe('authorization service', () => {
  test('setup makes the first user ADMIN', async () => {
    const h = createHarness();
    await h.completeSetup();
    const admin = h.users.findByUsername(ADMIN.username)!;
    expect(h.authz.principalFor(admin.id).roles).toEqual(['ADMIN']);
  });

  test('users without roles have no permissions', async () => {
    const h = createHarness();
    const { id } = await h.addUser('nobody');
    expect(h.authz.principalFor(id).permissions.size).toBe(0);
  });

  test('permissions are the union of the roles', async () => {
    const h = createHarness();
    const { id } = await h.addUser('mixed', ['VIEWER', 'OPERATOR']);
    const p = h.authz.principalFor(id);
    expect(p.permissions.has('routing.write')).toBe(true);
    expect(p.permissions.has('users.read')).toBe(false);
  });

  test('assigning roles is audited and evented', async () => {
    const h = createHarness();
    await h.completeSetup();
    const admin = h.users.findByUsername(ADMIN.username)!;
    const { id } = await h.addUser('bob');
    const events: string[][] = [];
    h.events.on('user.roles_changed', (e) => { events.push(e.roles); });

    const result = h.authz.setUserRoles({ id: admin.id, username: admin.username }, id, ['VIEWER', 'OPERATOR', 'VIEWER'], client);
    expect(result.roles).toEqual(['OPERATOR', 'VIEWER']);
    expect(events).toEqual([['OPERATOR', 'VIEWER']]);
    const rec = h.audit.list({ action: 'ROLE_CHANGED' }).find((r) => r.resourceId === id);
    expect(rec!.metadata).toMatchObject({ username: 'bob', before: [], after: ['OPERATOR', 'VIEWER'] });
    expect(rec!.actorName).toBe('admin');

    h.authz.setUserRoles({ id: admin.id, username: admin.username }, id, ['OPERATOR', 'VIEWER'], client);
    expect(h.audit.list({ action: 'ROLE_CHANGED' })).toHaveLength(2); // setup + first change; no-op not audited
  });

  test('rejects unknown roles and unknown users', async () => {
    const h = createHarness();
    const { id } = await h.addUser('bob');
    const actor = { id: 'a', username: 'a' };
    expect(() => h.authz.setUserRoles(actor, id, ['ROOT'], client)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => h.authz.setUserRoles(actor, 'missing', ['VIEWER'], client)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  test('the last active administrator cannot lose ADMIN', async () => {
    const h = createHarness();
    await h.completeSetup();
    const admin = h.users.findByUsername(ADMIN.username)!;
    const actor = { id: admin.id, username: admin.username };
    expect(() => h.authz.setUserRoles(actor, admin.id, ['VIEWER'], client)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(h.authz.principalFor(admin.id).roles).toEqual(['ADMIN']);

    // A disabled admin does not count as a remaining administrator.
    const other = await h.addUser('other-admin', ['ADMIN']);
    h.db.run("UPDATE users SET status = 'DISABLED' WHERE id = ?", [other.id]);
    expect(() => h.authz.setUserRoles(actor, admin.id, [], client)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));

    h.db.run("UPDATE users SET status = 'ACTIVE' WHERE id = ?", [other.id]);
    expect(h.authz.setUserRoles(actor, admin.id, ['VIEWER'], client).roles).toEqual(['VIEWER']);
  });

  test('lists roles with member counts', async () => {
    const h = createHarness();
    await h.completeSetup();
    await h.addUser('v1', ['VIEWER']);
    await h.addUser('v2', ['VIEWER']);
    const roles = h.authz.listRoles();
    expect(roles.map((r) => [r.id, r.memberCount])).toEqual([['ADMIN', 1], ['OPERATOR', 0], ['VIEWER', 2]]);
    expect(roles.every((r) => r.builtIn)).toBe(true);
  });
});

describe('migration 0004 on an existing installation', () => {
  test('makes only the setup administrator ADMIN', () => {
    const db = openSqlite({ path: ':memory:' });
    const before = migrations.filter((m: Migration) => m.id < '0004');
    runMigrations(db, before);
    const now = new Date().toISOString();
    for (const [id, name, created] of [['u-old', 'older', '2025-01-01'], ['u-admin', 'admin', '2025-02-01'], ['u-bob', 'bob', '2025-03-01']]) {
      db.run("INSERT INTO users (id, username, display_name, password_hash, status, created_at, updated_at, password_changed_at) VALUES (?, ?, ?, 'x', 'ACTIVE', ?, ?, ?)", [id!, name!, name!, created!, now, now]);
    }
    db.run("INSERT INTO audit_log (id, timestamp, actor_id, action, result) VALUES ('a1', ?, 'u-admin', 'SETUP_COMPLETED', 'SUCCESS')", [now]);
    runMigrations(db, migrations);
    expect(db.all('SELECT user_id, role_id FROM user_roles')).toEqual([{ user_id: 'u-admin', role_id: 'ADMIN' }]);
  });

  test('falls back to the oldest user when there is no setup record', () => {
    const db = openSqlite({ path: ':memory:' });
    runMigrations(db, migrations.filter((m: Migration) => m.id < '0004'));
    const now = new Date().toISOString();
    db.run("INSERT INTO users (id, username, display_name, password_hash, status, created_at, updated_at, password_changed_at) VALUES ('b', 'b', 'b', 'x', 'ACTIVE', '2025-05-01', ?, ?)", [now, now]);
    db.run("INSERT INTO users (id, username, display_name, password_hash, status, created_at, updated_at, password_changed_at) VALUES ('a', 'a', 'a', 'x', 'ACTIVE', '2025-01-01', ?, ?)", [now, now]);
    runMigrations(db, migrations);
    expect(db.all('SELECT user_id FROM user_roles')).toEqual([{ user_id: 'a' }]);
  });
});
