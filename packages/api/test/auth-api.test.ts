import { describe, expect, test } from 'bun:test';
import type { ApiErrorBody, ApiSuccess, AuthSession, SessionInfo, SetupStatus } from '@clawapi/shared';
import { ADMIN, SETUP_TOKEN, cookieFrom, createHarness } from '../../../tests/support/harness.ts';

const json = async <T>(res: Response) => (await res.json()) as T;

describe('setup over HTTP', () => {
  test('status, completion, then closed', async () => {
    const h = createHarness();
    expect((await json<ApiSuccess<SetupStatus>>(await h.request('/api/setup/status'))).data.required).toBe(true);

    const res = await h.request('/api/setup', { method: 'POST', json: { setupToken: SETUP_TOKEN, ...ADMIN } });
    expect(res.status).toBe(201);
    const body = await json<ApiSuccess<AuthSession>>(res);
    expect(body.data.user.username).toBe('admin');
    expect(JSON.stringify(body)).not.toContain(ADMIN.password);
    expect(cookieFrom(res)).toStartWith('clawapi_session=');

    expect((await json<ApiSuccess<SetupStatus>>(await h.request('/api/setup/status'))).data.required).toBe(false);
    const again = await h.request('/api/setup', { method: 'POST', json: { setupToken: SETUP_TOKEN, ...ADMIN } });
    expect(again.status).toBe(409);
  });

  test('wrong token is 401 and creates nobody', async () => {
    const h = createHarness();
    const res = await h.request('/api/setup', { method: 'POST', json: { setupToken: 'nope', ...ADMIN } });
    expect(res.status).toBe(401);
    expect(h.users.count()).toBe(0);
  });

  test('invalid body is 400 with field issues', async () => {
    const h = createHarness();
    const res = await h.request('/api/setup', { method: 'POST', json: { username: 'x', admin: true } });
    expect(res.status).toBe(400);
    const paths = (await json<ApiErrorBody>(res)).error.details?.issues?.map((i) => i.path);
    expect(paths).toContain('admin');
    expect(paths).toContain('password');
  });
});

describe('login / session / logout', () => {
  test('full flow', async () => {
    const h = createHarness();
    await h.completeSetup();

    const login = await h.request('/api/auth/login', { method: 'POST', json: { username: 'admin', password: ADMIN.password } });
    expect(login.status).toBe(200);
    const cookie = cookieFrom(login);

    const session = await h.request('/api/auth/session', { cookie });
    expect(session.status).toBe(200);
    expect((await json<ApiSuccess<AuthSession>>(session)).data.user.displayName).toBe(ADMIN.displayName);

    const logout = await h.request('/api/auth/logout', { method: 'POST', cookie });
    expect(logout.status).toBe(204);
    expect(logout.headers.getSetCookie()[0]).toContain('Max-Age=0');

    expect((await h.request('/api/auth/session', { cookie })).status).toBe(401);
  });

  test('session cookie attributes', async () => {
    const h = createHarness();
    await h.completeSetup();
    const res = await h.request('/api/auth/login', { method: 'POST', json: { username: 'admin', password: ADMIN.password } });
    const header = res.headers.getSetCookie()[0]!;
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=43200'); // 12 h absolute lifetime
    expect(header).not.toContain('Secure');
  });

  test('secure deployments use a __Host- Secure cookie', async () => {
    const h = createHarness({ secureCookie: true });
    const res = await h.request('/api/setup', { method: 'POST', json: { setupToken: SETUP_TOKEN, ...ADMIN } });
    const header = res.headers.getSetCookie()[0]!;
    expect(header).toStartWith('__Host-clawapi_session=');
    expect(header).toContain('Secure');
  });

  test('bad credentials are 401 with a generic message', async () => {
    const h = createHarness();
    await h.completeSetup();
    const res = await h.request('/api/auth/login', { method: 'POST', json: { username: 'admin', password: 'wrong' } });
    expect(res.status).toBe(401);
    expect((await json<ApiErrorBody>(res)).error.message).toBe('Invalid username or password.');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test('throttled logins are 429 with Retry-After', async () => {
    const h = createHarness();
    await h.completeSetup();
    for (let i = 0; i < 10; i++) await h.request('/api/auth/login', { method: 'POST', json: { username: 'admin', password: 'x' } });
    const res = await h.request('/api/auth/login', { method: 'POST', json: { username: 'admin', password: ADMIN.password } });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  test('an invalid cookie is rejected and cleared', async () => {
    const h = createHarness();
    await h.completeSetup();
    const res = await h.request('/api/auth/session', { cookie: 'clawapi_session=forged' });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()[0]).toContain('Max-Age=0');
  });

  test('requires JSON', async () => {
    const h = createHarness();
    const res = await h.request('/api/auth/login', { method: 'POST', body: 'username=admin&password=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.status).toBe(400);
  });
});

describe('own sessions', () => {
  test('list and revoke', async () => {
    const h = createHarness();
    const first = await h.completeSetup();
    const second = await h.login();
    const list = await json<ApiSuccess<SessionInfo[]>>(await h.request('/api/auth/sessions', { cookie: second }));
    expect(list.data).toHaveLength(2);
    const other = list.data.find((s) => !s.current)!;

    expect((await h.request(`/api/auth/sessions/${other.id}`, { method: 'DELETE', cookie: second })).status).toBe(204);
    expect((await h.request('/api/auth/session', { cookie: first })).status).toBe(401);
    expect((await h.request(`/api/auth/sessions/${other.id}`, { method: 'DELETE', cookie: second })).status).toBe(404);
  });
});

describe('protection', () => {
  test('only the intended routes are public', () => {
    const h = createHarness();
    const publicRoutes = h.api.router.list().filter((r) => r.access === 'public').map((r) => `${r.method} ${r.pattern}`);
    expect(publicRoutes.sort()).toEqual([
      'GET /api/health', 'GET /api/setup/status', 'POST /api/auth/login', 'POST /api/auth/logout', 'POST /api/setup',
    ]);
  });

  test('protected routes return 401 without a session', async () => {
    const h = createHarness();
    for (const path of ['/api/auth/session', '/api/auth/sessions']) {
      const res = await h.request(path);
      expect(res.status).toBe(401);
      expect((await json<ApiErrorBody>(res)).error.code).toBe('AUTHENTICATION_ERROR');
    }
  });

  test('the console session never authenticates the external gateway', async () => {
    const h = createHarness();
    const cookie = await h.completeSetup();
    let sawAuth: unknown = 'unset';
    h.api.router.get('/v1/probe', 'public', (ctx) => { sawAuth = ctx.auth; return new Response('ok'); });
    await h.request('/v1/probe', { cookie });
    expect(sawAuth).toBeNull();
  });
});

describe('CSRF', () => {
  test('cross-site Origin is rejected', async () => {
    const h = createHarness();
    const res = await h.request('/api/auth/login', { method: 'POST', json: { username: 'a', password: 'b' }, headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });

  test('same-origin Origin is accepted', async () => {
    const h = createHarness();
    await h.completeSetup();
    const res = await h.request('/api/auth/login', { method: 'POST', json: { username: 'admin', password: ADMIN.password }, headers: { origin: 'http://clawapi.test' } });
    expect(res.status).toBe(200);
  });

  test('cross-site Sec-Fetch-Site is rejected', async () => {
    const h = createHarness();
    const res = await h.request('/api/auth/login', { method: 'POST', json: { username: 'a', password: 'b' }, headers: { 'sec-fetch-site': 'cross-site' } });
    expect(res.status).toBe(403);
  });

  test('cookie-authenticated unsafe requests need the CSRF header', async () => {
    const h = createHarness();
    const cookie = await h.completeSetup();
    expect((await h.request('/api/auth/logout', { method: 'POST', cookie, csrf: false })).status).toBe(403);
    expect((await h.request('/api/auth/session', { cookie, csrf: false })).status).toBe(200); // safe methods are fine
    expect((await h.request('/api/auth/logout', { method: 'POST', cookie })).status).toBe(204);
  });
});
