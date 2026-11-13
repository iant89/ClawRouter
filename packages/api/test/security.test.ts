/**
 * Phase 15 security tests: secrets never leave the server, and hostile input is
 * refused cleanly. Complements the authorization sweep (authorization-api.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import type { ApiSuccess, CreatedApiKey, ProviderInfo, UserWithRoles } from '@clawrouter/shared';
import { ADMIN, cookieFrom, createHarness, SETUP_TOKEN, type Harness } from '../../../tests/support/harness.ts';

const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;

/** Values that must never appear anywhere a user, a log reader or an auditor can see. */
const CANARY = {
  providerKey: 'sk-canaryPROVIDERkey0123456789abcdef',
  tempPassword: 'canary-TEMP-password-77',
  newPassword: 'canary-NEW-password-88',
  typedPassword: 'canary-typed-into-username-99',
  wrongPassword: 'canary-WRONG-password-11',
  wrongApiKey: 'crk_deadbeef_CANARYwrongKEY0123456789abcdefghijklmnopq',
};

/** Exercises the platform the way an operator would, planting secrets along the way. */
async function plantedWorld() {
  const h = createHarness();
  const admin = await h.completeSetup();
  const provider = await data<ProviderInfo>(await h.request('/api/providers', {
    method: 'POST', cookie: admin, json: { name: 'Canary', identifier: 'canary', kind: 'openai', endpoint: 'https://api.example.test/v1', apiKey: CANARY.providerKey },
  }));
  const key = await data<CreatedApiKey>(await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'canary key' } }));
  const user = await data<UserWithRoles>(await h.request('/api/users', {
    method: 'POST', cookie: admin, json: { username: 'sam', displayName: 'Sam', password: CANARY.tempPassword, roles: ['VIEWER'] },
  }));
  const sam = await h.login('sam', CANARY.tempPassword);
  await h.request('/api/auth/password', { method: 'POST', cookie: sam, json: { currentPassword: CANARY.tempPassword, newPassword: CANARY.newPassword } });
  await h.request(`/api/users/${user.id}/password`, { method: 'POST', cookie: admin, json: { password: CANARY.tempPassword } });
  // Hostile and clumsy sign-ins, gateway calls with good and bad keys.
  await h.request('/api/auth/login', { method: 'POST', json: { username: 'admin', password: CANARY.wrongPassword } });
  await h.request('/api/auth/login', { method: 'POST', json: { username: CANARY.typedPassword, password: 'x' } });
  await h.request('/v1/models', { headers: { authorization: `Bearer ${key.secret}` } });
  await h.request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }) });
  await h.request('/v1/models', { headers: { authorization: `Bearer ${CANARY.wrongApiKey}` } });
  await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { sessionIdleMinutes: 30 } } });
  await h.request(`/api/providers/${provider.id}/test`, { method: 'POST', cookie: admin, json: {} });
  return { h, admin, apiKeySecret: key.secret, sessionToken: admin.split('=')[1]! };
}

/** Every value an admin can read through GET routes (ids filled in where known). */
async function everythingReadable(h: Harness, cookie: string): Promise<string> {
  const ids: { providers: string[]; users: string[] } = {
    providers: (await data<{ id: string }[]>(await h.request('/api/providers', { cookie }))).map((p) => p.id),
    users: (await data<{ id: string }[]>(await h.request('/api/users', { cookie }))).map((u) => u.id),
  };
  let text = '';
  for (const route of h.api.router.list().filter((r) => r.method === 'GET' && !r.pattern.startsWith('/v1/'))) {
    const id = route.pattern.startsWith('/api/providers/') ? ids.providers[0] : route.pattern.startsWith('/api/users/') ? ids.users[0] : 'unknown';
    const res = await h.request(route.pattern.replace(':id', id ?? 'unknown'), { cookie });
    text += `\n${route.pattern} ${res.status} ${await res.text()} ${JSON.stringify([...res.headers])}`;
  }
  return text;
}

describe('secrets never leave the server (canary sweep)', () => {
  test('no planted secret appears in any API response, log, audit record, notification or readable table', async () => {
    const { h, admin, apiKeySecret, sessionToken } = await plantedWorld();
    const surfaces = {
      api: await everythingReadable(h, admin),
      logs: JSON.stringify(h.logs),
      logBuffer: JSON.stringify(h.logBuffer.query({ limit: 10_000 })),
      audit: JSON.stringify(h.db.all('SELECT * FROM audit_log')),
      notifications: JSON.stringify(h.db.all('SELECT * FROM notifications')),
      requests: JSON.stringify(h.db.all('SELECT * FROM requests')),
      settings: JSON.stringify(h.db.all('SELECT * FROM settings')),
      operations: JSON.stringify(h.db.all('SELECT * FROM operations')),
      providers: JSON.stringify(h.db.all('SELECT * FROM providers')),
      usage: JSON.stringify(h.db.all('SELECT * FROM usage_records')),
    };
    const secrets: Record<string, string> = {
      ...CANARY,
      apiKeySecretPart: apiKeySecret.slice(13),
      adminPassword: ADMIN.password,
      setupToken: SETUP_TOKEN,
      sessionToken,
      passwordHash: '$argon2',
    };
    const leaks: string[] = [];
    for (const [surface, text] of Object.entries(surfaces)) {
      for (const [name, secret] of Object.entries(secrets)) if (text.includes(secret)) leaks.push(`${name} in ${surface}`);
    }
    expect(leaks).toEqual([]);
    // Sanity: the sweep really saw the system (otherwise it proves nothing).
    expect(surfaces.api).toContain('"canary key"');
    expect(surfaces.audit).toContain('LOGIN_FAILED');
    expect(surfaces.api.length).toBeGreaterThan(20_000);
  });

  test('a password typed into the username field is not recorded', async () => {
    const h = createHarness();
    await h.completeSetup();
    await h.request('/api/auth/login', { method: 'POST', json: { username: CANARY.typedPassword, password: 'whatever' } });
    const failed = h.audit.list({ action: 'LOGIN_FAILED' });
    expect(failed[0]!.metadata).toMatchObject({ username: null, unknownUser: true, reason: 'invalid_credentials' });
    await h.request('/api/auth/login', { method: 'POST', json: { username: 'ADMIN', password: 'wrong password!' } });
    expect(h.audit.list({ action: 'LOGIN_FAILED' }).some((r) => r.metadata?.username === 'admin')).toBe(true);
  });
});

describe('hostile input is refused cleanly', () => {
  const garbage: unknown[] = [null, 0, -1, 1e308, 'x'.repeat(5000), [], [[[]]], { __proto__: { admin: true } }, { constructor: { prototype: { x: 1 } } }, '<script>alert(1)</script>', '\u0000￿', true];

  test('no route answers garbage bodies with a server error', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const userId = (await data<{ id: string }[]>(await h.request('/api/users', { cookie: admin })))[0]!.id;
    const failures: string[] = [];
    for (const route of h.api.router.list().filter((r) => r.method !== 'GET' && !r.pattern.startsWith('/v1/') && r.pattern !== '/api/auth/logout')) {
      for (const body of garbage) {
        const path = route.pattern.replace(':id', userId);
        const res = await h.request(path, { method: route.method, cookie: admin, json: body });
        if (res.status >= 500) failures.push(`${route.method} ${route.pattern} ${JSON.stringify(body)?.slice(0, 40)} -> ${res.status}`);
        // Also with garbage wrapped in every field name the route might read.
        const wrapped = await h.request(path, { method: route.method, cookie: admin, json: { name: body, values: body, roles: body, permissions: body, password: body, status: body, model: body, messages: body } });
        if (wrapped.status >= 500) failures.push(`${route.method} ${route.pattern} wrapped ${JSON.stringify(body)?.slice(0, 40)} -> ${wrapped.status}`);
      }
    }
    expect(failures).toEqual([]);
    // The session survived all of it (the admin did not, e.g., lock themselves out).
    expect((await h.request('/api/auth/session', { cookie: admin })).status).toBe(200);
  });

  test('/v1 refuses garbage in the OpenAI error format, never with a 500', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const { secret } = await data<CreatedApiKey>(await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'k' } }));
    for (const path of ['/v1/chat/completions', '/v1/embeddings']) {
      for (const body of [...garbage, { model: garbage, messages: garbage }, { model: 'x', messages: [{ role: 'system', content: { nested: [1, 2] } }] }]) {
        const res = await h.request(path, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        expect([path, res.status < 500 || res.status === 502 || res.status === 503]).toEqual([path, true]);
        const err = (await res.json()) as { error?: { message?: string; type?: string } };
        expect(typeof err.error?.message).toBe('string');
      }
    }
  });

  test('injection-shaped search and filter values are treated as text', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    for (const q of ["' OR 1=1 --", '%', '_', '\\', '"; DROP TABLE users; --', '%00', '../../etc/passwd']) {
      for (const path of ['/api/audit', '/api/logs', '/api/requests']) {
        const res = await h.request(`${path}?q=${encodeURIComponent(q)}&actor=${encodeURIComponent(q)}`, { cookie: admin });
        expect([path, q, res.status]).toEqual([path, q, 200]);
      }
    }
    expect((await h.request('/api/users', { cookie: admin })).status).toBe(200);
    // A wildcard search does not match everything.
    const all = await data<unknown[]>(await h.request('/api/audit?q=%25', { cookie: admin }));
    expect(all).toHaveLength(0);
  });

  test('a session cookie alone cannot change anything cross-site', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const attack = { method: 'POST', cookie: admin, json: { name: 'Evil', permissions: ['logs.read'] } };
    expect((await h.request('/api/roles', { ...attack, csrf: false })).status).toBe(403);
    expect((await h.request('/api/roles', { ...attack, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await h.request('/api/roles', { ...attack, headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    // A form post cannot send JSON: the content type is refused.
    expect((await h.request('/api/roles', { method: 'POST', cookie: admin, headers: { 'content-type': 'text/plain' }, body: '{"name":"Evil","permissions":["logs.read"]}' })).status).toBe(400);
    expect((await h.request('/api/roles', attack)).status).toBe(201);
  });

  test('session tokens: rotated on sign-in, useless after sign-out, cleared when invalid', async () => {
    const h = createHarness();
    const first = await h.completeSetup();
    const second = await h.login();
    expect(second).not.toBe(first);
    const out = await h.request('/api/auth/logout', { method: 'POST', cookie: second });
    expect(out.status).toBe(204);
    expect((await h.request('/api/auth/session', { cookie: second })).status).toBe(401);
    const forged = await h.request('/api/auth/session', { cookie: 'clawrouter_session=forged-token' });
    expect(forged.status).toBe(401);
    expect(forged.headers.getSetCookie().join()).toContain('Max-Age=0');
    // The cookie attributes.
    const login = await h.request('/api/auth/login', { method: 'POST', json: { username: ADMIN.username, password: ADMIN.password } });
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith('clawrouter_session='))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookieFrom(login)).not.toBe(first);
  });
});

describe('failure paths', () => {
  test('a database failure is a generic 500: no SQL, table names or stack in the response, the cause in the log', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    h.db.exec('DROP TABLE audit_log');
    const res = await h.request('/api/audit', { cookie: admin });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'DATABASE_ERROR', message: 'A database error occurred.' } });
    expect(text).not.toMatch(/audit_log|SQLITE|no such table|\.ts:\d+/i);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    // Operators can still find out what happened, by request id.
    const logged = h.logs.find((r) => r.msg === 'request failed' && r.requestId === res.headers.get('x-request-id'));
    expect(JSON.stringify(logged)).toContain('audit_log');
  });

  test('a provider that hangs or fails never leaks its error body or credentials to the client', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    h.setProviderFetch((async () => new Response(JSON.stringify({ error: { message: 'upstream secret detail sk-canaryPROVIDERkey0123456789abcdef' } }), { status: 500 })) as unknown as typeof fetch);
    const p = await data<ProviderInfo>(await h.request('/api/providers', {
      method: 'POST', cookie: admin, json: { name: 'Bad', identifier: 'bad', kind: 'openai', endpoint: 'https://api.example.test/v1', apiKey: CANARY.providerKey },
    }));
    const res = await h.request(`/api/providers/${p.id}/test`, { method: 'POST', cookie: admin, json: {} });
    expect(await res.text()).not.toContain(CANARY.providerKey);
    expect(JSON.stringify(h.logs)).not.toContain(CANARY.providerKey);
  });

  test('unknown routes and methods answer 404/405 without revealing anything', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    expect((await h.request('/api/does-not-exist', { cookie: admin })).status).toBe(404);
    const wrong = await h.request('/api/settings', { method: 'DELETE', cookie: admin });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toContain('GET');
  });
});
