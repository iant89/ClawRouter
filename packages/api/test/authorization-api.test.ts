import { describe, expect, test } from 'bun:test';
import type { ApiErrorBody, ApiSuccess, AuthSession, RoleInfo, UserWithRoles } from '@clawapi/shared';
import { PERMISSIONS } from '@clawapi/shared';
import { createHarness } from '../../../tests/support/harness.ts';

const json = async <T>(res: Response) => (await res.json()) as T;

async function world() {
  const h = createHarness();
  const admin = await h.completeSetup();
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = { admin };
  for (const [name, roles] of [['operator', ['OPERATOR']], ['viewer', ['VIEWER']], ['nobody', []]] as const) {
    ids[name] = (await h.addUser(name, [...roles])).id;
    cookies[name] = await h.login(name);
  }
  return { h, ids, cookies };
}

/** A sample request for each protected route, used to prove the router enforces its declared access. */
function sampleRequest(method: string, pattern: string, ids: Record<string, string>) {
  const path = pattern.replace(':id', ids.viewer!);
  const body = method === 'GET' || method === 'DELETE' ? undefined : pattern.endsWith('/roles') ? { roles: ['VIEWER'] } : { userId: ids.viewer };
  return { path, init: { method, json: body } };
}

describe('every protected endpoint enforces its permission (phase 3 exit criterion)', () => {
  test('each route declares a known access level', () => {
    const h = createHarness();
    for (const r of h.api.router.list()) {
      expect(['public', 'authenticated', ...PERMISSIONS]).toContain(r.access);
    }
  });

  test('users without the permission get 403; holders get through; anonymous gets 401', async () => {
    const { h, ids, cookies } = await world();
    const routes = h.api.router.list().filter((r) => r.access !== 'public' && r.access !== 'authenticated');
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      const { path, init } = sampleRequest(route.method, route.pattern, ids);
      const anon = await h.request(path, init);
      expect([route.pattern, anon.status]).toEqual([route.pattern, 401]);
      const denied = await h.request(path, { ...init, cookie: cookies.nobody });
      expect([route.pattern, denied.status]).toEqual([route.pattern, 403]);
      expect((await json<ApiErrorBody>(denied)).error.code).toBe('AUTHORIZATION_ERROR');
      const allowed = await h.request(path, { ...init, cookie: cookies.admin });
      expect([route.pattern, allowed.status < 400 || allowed.status === 404]).toEqual([route.pattern, true]);
    }
  });

  test('role matrix for the administration endpoints', async () => {
    const { h, cookies } = await world();
    const matrix: [string, Record<string, number>][] = [
      ['/api/roles', { admin: 200, operator: 403, viewer: 403, nobody: 403 }],
      ['/api/users', { admin: 200, operator: 403, viewer: 403, nobody: 403 }],
      ['/api/sessions', { admin: 200, operator: 403, viewer: 403, nobody: 403 }],
      ['/api/auth/session', { admin: 200, operator: 200, viewer: 200, nobody: 200 }],
      ['/api/auth/sessions', { admin: 200, operator: 200, viewer: 200, nobody: 200 }],
    ];
    for (const [path, expected] of matrix) {
      for (const [who, status] of Object.entries(expected)) {
        expect([path, who, (await h.request(path, { cookie: cookies[who] })).status]).toEqual([path, who, status]);
      }
    }
  });
});

describe('session payload', () => {
  test('includes roles and effective permissions', async () => {
    const { h, cookies } = await world();
    const op = (await json<ApiSuccess<AuthSession>>(await h.request('/api/auth/session', { cookie: cookies.operator }))).data;
    expect(op.roles).toEqual(['OPERATOR']);
    expect(op.permissions).toContain('providers.write');
    expect(op.permissions).not.toContain('users.read');
    const nobody = (await json<ApiSuccess<AuthSession>>(await h.request('/api/auth/session', { cookie: cookies.nobody }))).data;
    expect(nobody).toMatchObject({ roles: [], permissions: [] });
  });

  test('login and setup responses include them too', async () => {
    const h = createHarness();
    const res = await h.request('/api/setup', { method: 'POST', json: { setupToken: 'test-setup-token-0123456789', username: 'admin', displayName: 'A', password: 'correct horse battery staple' } });
    expect((await json<ApiSuccess<AuthSession>>(res)).data.roles).toEqual(['ADMIN']);
  });
});

describe('PUT /api/users/:id/roles', () => {
  test('a role change applies on the next request without signing the user out', async () => {
    const { h, ids, cookies } = await world();
    expect((await h.request('/api/roles', { cookie: cookies.viewer })).status).toBe(403);
    const res = await h.request(`/api/users/${ids.viewer}/roles`, { method: 'PUT', cookie: cookies.admin, json: { roles: ['ADMIN'] } });
    expect(res.status).toBe(200);
    expect((await json<ApiSuccess<UserWithRoles>>(res)).data.roles).toEqual(['ADMIN']);
    expect((await h.request('/api/roles', { cookie: cookies.viewer })).status).toBe(200);

    await h.request(`/api/users/${ids.viewer}/roles`, { method: 'PUT', cookie: cookies.admin, json: { roles: [] } });
    expect((await h.request('/api/roles', { cookie: cookies.viewer })).status).toBe(403);
    expect((await h.request('/api/auth/session', { cookie: cookies.viewer })).status).toBe(200);
  });

  test('last administrator protection is a 409', async () => {
    const { h, cookies } = await world();
    const me = (await json<ApiSuccess<AuthSession>>(await h.request('/api/auth/session', { cookie: cookies.admin }))).data.user.id;
    const res = await h.request(`/api/users/${me}/roles`, { method: 'PUT', cookie: cookies.admin, json: { roles: ['VIEWER'] } });
    expect(res.status).toBe(409);
    expect((await json<ApiErrorBody>(res)).error.message).toContain('at least one active administrator');
  });

  test('validation and unknown users', async () => {
    const { h, ids, cookies } = await world();
    expect((await h.request(`/api/users/${ids.viewer}/roles`, { method: 'PUT', cookie: cookies.admin, json: { roles: 'ADMIN' } })).status).toBe(400);
    expect((await h.request(`/api/users/${ids.viewer}/roles`, { method: 'PUT', cookie: cookies.admin, json: { roles: ['ROOT'] } })).status).toBe(400);
    expect((await h.request('/api/users/missing/roles', { method: 'PUT', cookie: cookies.admin, json: { roles: [] } })).status).toBe(404);
  });

  test('an operator cannot grant themselves roles', async () => {
    const { h, ids, cookies } = await world();
    const res = await h.request(`/api/users/${ids.operator}/roles`, { method: 'PUT', cookie: cookies.operator, json: { roles: ['ADMIN'] } });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/roles and /api/users', () => {
  test('return roles with permissions and users with roles, never password hashes', async () => {
    const { h, cookies } = await world();
    const roles = (await json<ApiSuccess<RoleInfo[]>>(await h.request('/api/roles', { cookie: cookies.admin }))).data;
    expect(roles.map((r) => r.id)).toEqual(['ADMIN', 'OPERATOR', 'VIEWER']);
    const usersRes = await h.request('/api/users', { cookie: cookies.admin });
    const text = await usersRes.text();
    expect(text).not.toContain('argon2');
    const users = (JSON.parse(text) as ApiSuccess<UserWithRoles[]>).data;
    expect(users.map((u) => [u.username, u.roles])).toEqual([['admin', ['ADMIN']], ['nobody', []], ['operator', ['OPERATOR']], ['viewer', ['VIEWER']]]);
  });
});
