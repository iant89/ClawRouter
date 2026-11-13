import { describe, expect, test } from 'bun:test';
import { PERMISSIONS, type ApiErrorBody, type ApiSuccess, type AuthSession, type RoleInfo, type UserWithRoles } from '@clawrouter/shared';
import { createHarness, type Harness } from '../../../tests/support/harness.ts';

const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;
const errorOf = async (res: Response) => ((await res.json()) as ApiErrorBody).error;

const createRole = (h: Harness, cookie: string, body: Record<string, unknown>) => h.request('/api/roles', { method: 'POST', cookie, json: body });

describe('custom roles (owner rule)', () => {
  test('an administrator creates a role with chosen permissions, and its members get exactly those', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const res = await createRole(h, admin, { name: 'Support', description: 'Looks at requests', permissions: ['requests.read', 'usage.read', 'logs.read'] });
    expect(res.status).toBe(201);
    const role = await data<RoleInfo>(res);
    expect(role).toMatchObject({ name: 'Support', builtIn: false, permissions: ['logs.read', 'requests.read', 'usage.read'], memberCount: 0 });

    const user = await h.addUser('sam');
    expect((await h.request(`/api/users/${user.id}/roles`, { method: 'PUT', cookie: admin, json: { roles: [role.id] } })).status).toBe(200);
    const sam = await h.login('sam');
    const session = await data<AuthSession>(await h.request('/api/auth/session', { cookie: sam }));
    expect([...session.permissions].sort()).toEqual(['logs.read', 'requests.read', 'usage.read']);
    expect((await h.request('/api/requests', { cookie: sam })).status).toBe(200);
    expect((await h.request('/api/providers', { cookie: sam })).status).toBe(403);
    expect(h.audit.list({ action: 'ROLE_CREATED' })).toHaveLength(1);
  });

  test('no role other than Administrator may have every permission', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const all = await createRole(h, admin, { name: 'Almighty', permissions: [...PERMISSIONS] });
    expect(all.status).toBe(400);
    expect((await errorOf(all)).details).toMatchObject({ issues: [{ path: 'permissions', message: 'only the Administrator role may have every permission' }] });

    const almost = await data<RoleInfo>(await createRole(h, admin, { name: 'Almost', permissions: PERMISSIONS.filter((p) => p !== 'settings.write') }));
    const grow = await h.request(`/api/roles/${almost.id}`, { method: 'PATCH', cookie: admin, json: { permissions: [...PERMISSIONS] } });
    expect(grow.status).toBe(400);
  });

  test('Administrator cannot be changed or removed; Operator and Viewer are fixed defaults', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const edit = await h.request('/api/roles/ADMIN', { method: 'PATCH', cookie: admin, json: { permissions: ['health.read'] } });
    expect(edit.status).toBe(409);
    expect((await errorOf(edit)).message).toBe('The Administrator role cannot be changed.');
    const del = await h.request('/api/roles/ADMIN', { method: 'DELETE', cookie: admin });
    expect(del.status).toBe(409);
    expect((await errorOf(del)).message).toBe('The Administrator role cannot be removed.');
    expect((await h.request('/api/roles/VIEWER', { method: 'PATCH', cookie: admin, json: { name: 'Watcher' } })).status).toBe(409);
    expect((await h.request('/api/roles/OPERATOR', { method: 'DELETE', cookie: admin })).status).toBe(409);
    // A custom role cannot take the Administrator's name either.
    expect((await createRole(h, admin, { name: 'administrator', permissions: ['health.read'] })).status).toBe(400);
  });

  test('editing a role changes its members\' permissions at once; a role in use cannot be deleted', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const role = await data<RoleInfo>(await createRole(h, admin, { name: 'Support', permissions: ['requests.read'] }));
    const user = await h.addUser('sam');
    await h.request(`/api/users/${user.id}/roles`, { method: 'PUT', cookie: admin, json: { roles: [role.id] } });
    const sam = await h.login('sam');
    expect((await h.request('/api/usage', { cookie: sam })).status).toBe(403);
    const changed: string[] = [];
    h.events.on('user.roles_changed', (e) => { changed.push(e.userId); });

    const updated = await data<RoleInfo>(await h.request(`/api/roles/${role.id}`, { method: 'PATCH', cookie: admin, json: { name: 'Support desk', permissions: ['requests.read', 'usage.read'] } }));
    expect(updated).toMatchObject({ name: 'Support desk', permissions: ['requests.read', 'usage.read'], memberCount: 1 });
    expect((await h.request('/api/usage', { cookie: sam })).status).toBe(200);
    expect(changed).toEqual([user.id]);
    expect(h.audit.list({ action: 'ROLE_UPDATED' })[0]!.metadata).toMatchObject({ added: ['usage.read'], removed: [], renamedFrom: 'Support' });

    const inUse = await h.request(`/api/roles/${role.id}`, { method: 'DELETE', cookie: admin });
    expect(inUse.status).toBe(409);
    await h.request(`/api/users/${user.id}/roles`, { method: 'PUT', cookie: admin, json: { roles: [] } });
    expect((await h.request(`/api/roles/${role.id}`, { method: 'DELETE', cookie: admin })).status).toBe(204);
    expect((await data<RoleInfo[]>(await h.request('/api/roles', { cookie: admin }))).map((r) => r.id)).toEqual(['ADMIN', 'OPERATOR', 'VIEWER']);
  });

  test('validation: names, unknown permissions, empty roles, duplicates', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    expect((await createRole(h, admin, { name: '', permissions: ['health.read'] })).status).toBe(400);
    expect((await createRole(h, admin, { name: 'X', permissions: ['root.everything'] })).status).toBe(400);
    expect((await createRole(h, admin, { name: 'X', permissions: [] })).status).toBe(400);
    expect((await createRole(h, admin, { name: 'Support', permissions: ['health.read'] })).status).toBe(201);
    expect((await createRole(h, admin, { name: 'support', permissions: ['logs.read'] })).status).toBe(400);
  });
});

describe('no privilege escalation', () => {
  /** A role manager who may edit and assign roles but holds only some permissions. */
  async function withManager() {
    const h = createHarness();
    const admin = await h.completeSetup();
    const managerRole = await data<RoleInfo>(await createRole(h, admin, {
      name: 'Role manager', permissions: ['roles.read', 'roles.write', 'roles.assign', 'users.read', 'requests.read'],
    }));
    const m = await h.addUser('manager');
    await h.request(`/api/users/${m.id}/roles`, { method: 'PUT', cookie: admin, json: { roles: [managerRole.id] } });
    return { h, admin, managerRole, manager: await h.login('manager'), managerId: m.id };
  }

  test('cannot create or edit a role with permissions they do not hold', async () => {
    const { h, manager, managerRole } = await withManager();
    const res = await createRole(h, manager, { name: 'Sneaky', permissions: ['requests.read', 'settings.write'] });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toContain('settings.write');
    expect((await createRole(h, manager, { name: 'Reader', permissions: ['requests.read'] })).status).toBe(201);
    // Not even their own role.
    expect((await h.request(`/api/roles/${managerRole.id}`, { method: 'PATCH', cookie: manager, json: { permissions: ['roles.read', 'roles.write', 'roles.assign', 'users.read', 'requests.read', 'audit.read'] } })).status).toBe(403);
  });

  test('cannot assign roles more powerful than themselves: Administrator only by administrators', async () => {
    const { h, admin, manager, managerId } = await withManager();
    const user = await h.addUser('target');
    expect((await h.request(`/api/users/${user.id}/roles`, { method: 'PUT', cookie: manager, json: { roles: ['ADMIN'] } })).status).toBe(403);
    expect((await h.request(`/api/users/${managerId}/roles`, { method: 'PUT', cookie: manager, json: { roles: ['ADMIN'] } })).status).toBe(403);
    expect((await h.request(`/api/users/${user.id}/roles`, { method: 'PUT', cookie: manager, json: { roles: ['OPERATOR'] } })).status).toBe(403);
    // ...nor take Administrator away from someone.
    const adminUser = (await data<UserWithRoles[]>(await h.request('/api/users', { cookie: admin }))).find((u) => u.username === 'admin')!;
    expect((await h.request(`/api/users/${adminUser.id}/roles`, { method: 'PUT', cookie: manager, json: { roles: [] } })).status).toBe(403);
    expect((await h.request(`/api/users/${user.id}/roles`, { method: 'PUT', cookie: admin, json: { roles: ['ADMIN'] } })).status).toBe(200);
  });

  test('operators cannot manage roles at all', async () => {
    const h = createHarness();
    await h.completeSetup();
    await h.addUser('op', ['OPERATOR']);
    const op = await h.login('op');
    expect((await createRole(h, op, { name: 'X', permissions: ['health.read'] })).status).toBe(403);
  });
});
