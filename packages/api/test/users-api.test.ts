import { describe, expect, test } from 'bun:test';
import { createArgon2Hasher } from '@clawrouter/authentication';
import type { ApiErrorBody, ApiSuccess, AuthSession, RoleInfo, UserSummary, UserWithRoles } from '@clawrouter/shared';
import { recoverPassword } from '../../../apps/server/src/recover.ts';
import { ADMIN, cookieFrom, createHarness, type Harness } from '../../../tests/support/harness.ts';

const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;
const errorOf = async (res: Response) => ((await res.json()) as ApiErrorBody).error;
const TEMP = 'temporary-pass-1';
const NEW = 'my-own-password-2';

async function createUser(h: Harness, cookie: string, username: string, roles: string[] = ['VIEWER'], password = TEMP) {
  return h.request('/api/users', { method: 'POST', cookie, json: { username, displayName: `${username} name`, password, roles } });
}

describe('user administration', () => {
  test('an administrator creates a user; they must change the temporary password before anything else', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const res = await createUser(h, admin, 'sam', ['OPERATOR']);
    expect(res.status).toBe(201);
    const user = await data<UserWithRoles>(res);
    expect(user).toMatchObject({ username: 'sam', displayName: 'sam name', status: 'ACTIVE', roles: ['OPERATOR'], mustChangePassword: true });
    expect(JSON.stringify(user)).not.toContain(TEMP);
    expect(h.audit.list({ action: 'USER_CREATED' }).find((r) => r.resourceId === user.id)).toBeDefined();
    expect(h.audit.list({ action: 'ROLE_CHANGED' }).find((r) => r.resourceId === user.id)).toBeDefined();

    const sam = await h.login('sam', TEMP);
    const session = await data<AuthSession>(await h.request('/api/auth/session', { cookie: sam }));
    expect(session.user.mustChangePassword).toBe(true);
    const blocked = await h.request('/api/providers', { cookie: sam });
    expect(blocked.status).toBe(403);
    expect((await errorOf(blocked)).details).toMatchObject({ reason: 'password_change_required' });

    const changed = await h.request('/api/auth/password', { method: 'POST', cookie: sam, json: { currentPassword: TEMP, newPassword: NEW } });
    expect(changed.status).toBe(200);
    expect((await data<UserSummary>(changed)).mustChangePassword).toBe(false);
    expect((await h.request('/api/providers', { cookie: sam })).status).toBe(200);
    expect((await h.request('/api/auth/login', { method: 'POST', json: { username: 'sam', password: TEMP } })).status).toBe(401);
    await h.login('sam', NEW);
  });

  test('validation: usernames, password policy, duplicates, unknown roles', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    expect((await createUser(h, admin, 'a b')).status).toBe(400);
    expect((await createUser(h, admin, 'sam', ['VIEWER'], 'short')).status).toBe(400);
    expect((await createUser(h, admin, 'sam', ['VIEWER'], 'sam-is-my-password')).status).toBe(400);
    expect((await createUser(h, admin, 'sam', ['NOPE'])).status).toBe(400);
    expect((await createUser(h, admin, 'sam')).status).toBe(201);
    const dup = await createUser(h, admin, 'SAM');
    expect(dup.status).toBe(400);
    expect((await errorOf(dup)).details).toMatchObject({ issues: [{ path: 'username', message: 'is already taken' }] });
    // A user can be created with no role at all (they can sign in and see nothing).
    expect((await createUser(h, admin, 'nobody', [])).status).toBe(201);
  });

  test('disabling ends every session; enabling lets them sign in again', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const { id } = await h.addUser('sam', ['VIEWER']);
    const sam = await h.login('sam');
    const revoked: string[] = [];
    h.events.on('session.revoked', (e) => { revoked.push(e.reason); });

    const off = await h.request(`/api/users/${id}`, { method: 'PATCH', cookie: admin, json: { status: 'DISABLED' } });
    expect((await data<UserWithRoles>(off)).status).toBe('DISABLED');
    expect(revoked).toEqual(['USER_DISABLED']);
    expect((await h.request('/api/auth/session', { cookie: sam })).status).toBe(401);
    expect((await h.request('/api/auth/login', { method: 'POST', json: { username: 'sam', password: ADMIN.password } })).status).toBe(401);

    await h.request(`/api/users/${id}`, { method: 'PATCH', cookie: admin, json: { status: 'ACTIVE', displayName: 'Samantha' } });
    expect(h.audit.list({ action: 'USER_ENABLED' })).toHaveLength(1);
    expect(h.audit.list({ action: 'USER_UPDATED' })[0]!.metadata).toMatchObject({ displayName: { after: 'Samantha' } });
    expect((await h.request('/api/auth/session', { cookie: await h.login('sam') })).status).toBe(200);
  });

  test('nobody can disable themselves, and the last active administrator stays', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const me = (await data<AuthSession>(await h.request('/api/auth/session', { cookie: admin }))).user;
    const self = await h.request(`/api/users/${me.id}`, { method: 'PATCH', cookie: admin, json: { status: 'DISABLED' } });
    expect(self.status).toBe(409);
    expect((await errorOf(self)).message).toBe('You cannot disable your own account.');

    // Another administrator may disable this one only while a second active administrator exists.
    const other = await h.addUser('second', ['ADMIN']);
    const second = await h.login('second');
    expect((await h.request(`/api/users/${me.id}`, { method: 'PATCH', cookie: second, json: { status: 'DISABLED' } })).status).toBe(200);
    // `second` is now the only active administrator. Only an administrator could disable them, and the
    // only one left is themselves; everyone else lacks their permissions.
    await h.addUser('op', ['OPERATOR']);
    const op = await h.login('op');
    expect((await h.request(`/api/users/${other.id}`, { method: 'PATCH', cookie: op, json: { status: 'DISABLED' } })).status).toBe(403);
    expect(h.authz.isLastActiveAdministrator(other.id)).toBe(true);
  });

  test('resetting a password signs the user out and requires a new password', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const { id } = await h.addUser('sam', ['VIEWER']);
    const sam = await h.login('sam');
    const res = await h.request(`/api/users/${id}/password`, { method: 'POST', cookie: admin, json: { password: TEMP } });
    expect(res.status).toBe(200);
    expect((await data<UserWithRoles>(res)).mustChangePassword).toBe(true);
    expect((await h.request('/api/auth/session', { cookie: sam })).status).toBe(401);
    const record = h.audit.list({ action: 'PASSWORD_RESET' })[0]!;
    expect(JSON.stringify(record)).not.toContain(TEMP);
    const again = await h.login('sam', TEMP);
    expect((await h.request('/api/requests', { cookie: again })).status).toBe(403);

    const me = (await data<AuthSession>(await h.request('/api/auth/session', { cookie: admin }))).user;
    expect((await h.request(`/api/users/${me.id}/password`, { method: 'POST', cookie: admin, json: { password: TEMP } })).status).toBe(409);
  });

  test('no escalation: users.write cannot touch users more powerful than the actor', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const role = await data<RoleInfo>(await h.request('/api/roles', { method: 'POST', cookie: admin, json: { name: 'User manager', permissions: ['users.read', 'users.write', 'requests.read'] } }));
    await h.addUser('manager', [role.id]);
    const manager = await h.login('manager');
    const adminUser = (await data<UserWithRoles[]>(await h.request('/api/users', { cookie: admin }))).find((u) => u.username === 'admin')!;

    const reset = await h.request(`/api/users/${adminUser.id}/password`, { method: 'POST', cookie: manager, json: { password: TEMP } });
    expect(reset.status).toBe(403);
    expect((await h.request(`/api/users/${adminUser.id}`, { method: 'PATCH', cookie: manager, json: { status: 'DISABLED' } })).status).toBe(403);
    expect((await createUser(h, manager, 'boss', ['ADMIN'])).status).toBe(403);
    expect(h.users.findByUsername('boss')).toBeUndefined();

    // Within their own permissions it works.
    const { id } = await h.addUser('reader', [role.id]);
    expect((await h.request(`/api/users/${id}/password`, { method: 'POST', cookie: manager, json: { password: TEMP } })).status).toBe(200);
    expect((await createUser(h, manager, 'helper', [])).status).toBe(201);
  });
});

describe('changing your own password', () => {
  test('needs the current password; other sessions end, this one stays', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const other = await h.login();
    const wrong = await h.request('/api/auth/password', { method: 'POST', cookie: admin, json: { currentPassword: 'not-it-at-all', newPassword: NEW } });
    expect(wrong.status).toBe(400);
    expect(h.audit.list({ action: 'PASSWORD_CHANGED' })[0]).toMatchObject({ result: 'FAILURE' });
    expect((await h.request('/api/auth/password', { method: 'POST', cookie: admin, json: { currentPassword: ADMIN.password, newPassword: 'short' } })).status).toBe(400);
    expect((await h.request('/api/auth/password', { method: 'POST', cookie: admin, json: { currentPassword: ADMIN.password, newPassword: ADMIN.password } })).status).toBe(400);

    const ok = await h.request('/api/auth/password', { method: 'POST', cookie: admin, json: { currentPassword: ADMIN.password, newPassword: NEW } });
    expect(ok.status).toBe(200);
    expect((await h.request('/api/auth/session', { cookie: admin })).status).toBe(200);
    expect((await h.request('/api/auth/session', { cookie: other })).status).toBe(401);
  });

  test('repeated wrong current passwords are throttled', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await h.request('/api/auth/password', { method: 'POST', cookie: admin, json: { currentPassword: `wrong-guess-${i}`, newPassword: NEW } })).status;
    }
    expect(last).toBe(429);
  });
});

describe('command-line recovery', () => {
  test('sets a random temporary password, ends sessions and can re-enable the account', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const { id } = await h.addUser('second', ['ADMIN']);
    await h.request(`/api/users/${id}`, { method: 'PATCH', cookie: admin, json: { status: 'DISABLED' } });
    const fast = createArgon2Hasher({ memoryCost: 1024, timeCost: 1 });

    const { user, password } = await recoverPassword(h.db, 'admin', { hasher: fast });
    expect(password).toMatch(/^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){3}$/);
    expect(user).toMatchObject({ username: 'admin', mustChangePassword: true });
    expect((await h.request('/api/auth/session', { cookie: admin })).status).toBe(401);
    const record = h.audit.list({ action: 'PASSWORD_RESET' })[0]!;
    expect(record).toMatchObject({ actorName: 'command line', actorId: null, metadata: { via: 'cli' } });
    expect(JSON.stringify(record)).not.toContain(password);
    const res = await h.request('/api/auth/login', { method: 'POST', json: { username: 'admin', password } });
    expect(res.status).toBe(200);
    expect((await h.request('/api/users', { cookie: cookieFrom(res) })).status).toBe(403);

    const enabled = await recoverPassword(h.db, 'second', { hasher: fast, enable: true });
    expect(enabled.user.status).toBe('ACTIVE');
    await expect(recoverPassword(h.db, 'ghost', { hasher: fast })).rejects.toThrow('No user called "ghost".');
  });
});
