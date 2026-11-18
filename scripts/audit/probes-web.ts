/**
 * Audit probes, part 1: the HTTP surface, setup, sign-in and sessions, CSRF,
 * authorization and escalation, other users' data, key lifetime rules, and secrets.
 */
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { MockProviders } from '../../tests/support/mock-providers.ts';
import type { MockSmtp } from '../../tests/support/mock-smtp.ts';
import { Client, items, type Recorder } from './lib.ts';

export const PW = 'correct horse battery staple';

export interface World {
  r: Recorder;
  base: string;
  dist: string;
  dir: string;
  db: string;
  env: Record<string, string>;
  mock: MockProviders;
  smtp: MockSmtp;
  setupToken: string;
  providerKey: string;
  admin: Client;
  users: Record<string, { client: Client; id: string; password: string }>;
  roles: Record<string, string>;
  /** Secrets planted during the run, searched for later. */
  planted: string[];
  gatewayKey: string;
  providerId: string;
  serverLog: () => string;
}

export async function surface(w: World) {
  const { r } = w;
  const anon = new Client(w.base);
  const page = await anon.raw('/');
  const csp = page.headers.get('content-security-policy') ?? '';
  r.check('H1', 'Headers', 'console HTML has a CSP with same-origin scripts only (no inline, no eval)', /script-src 'self'(;|$)/.test(csp) && !/unsafe-(inline|eval)[^;]*;?/.test(csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? ''), csp.slice(0, 120));
  r.check('H2', 'Headers', 'console forbids framing', page.headers.get('x-frame-options') === 'DENY' && /frame-ancestors 'none'/.test(csp));
  r.check('H3', 'Headers', 'nosniff and a referrer policy', page.headers.get('x-content-type-options') === 'nosniff' && !!page.headers.get('referrer-policy'));
  r.check('H4', 'Headers', 'no HSTS over plain HTTP', !page.headers.get('strict-transport-security'));
  const api = await anon.raw('/api/health');
  r.check('H5', 'Headers', 'API answers have a deny-all CSP and no-store', /default-src 'none'/.test(api.headers.get('content-security-policy') ?? '') && api.headers.get('cache-control') === 'no-store');
  const nf = await anon.raw('/api/no-such-route');
  r.check('H6', 'Headers', 'error answers keep the security headers', nf.status === 404 && nf.headers.get('x-content-type-options') === 'nosniff');
  r.check('H7', 'Headers', 'no server or framework banner', !/bun|clawrouter/i.test(page.headers.get('server') ?? '') && !page.headers.get('x-powered-by'), page.headers.get('server') ?? '(none)');
  const probes = ['/..%2f..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/assets/..%2f..%2fmain.js', '/main.js', '/server.js', '/cli/doctor.js', '/.env', '/package.json', '/data/secret.key', '/..\\..\\etc\\passwd', '/index.html/../main.js', '/%00', '/.git/config'];
  const leaked: string[] = [];
  for (const p of probes) {
    const res = await anon.raw(p);
    const t = await res.text();
    if (/root:x:0|Bun\.serve|CLAWROUTER_SECRET|"dependencies"|\[core\]|import\.meta/.test(t)) leaked.push(`${p} ${res.status}`);
  }
  r.check('H8', 'Static files', 'no path traversal; no server code, CLI bundle, config or key served', leaked.length === 0, leaked.join(', ') || `${probes.length} probes`);
  const html = await (await anon.raw('/')).text();
  const js = /src="\/?([^"]+\.js)"/.exec(html)?.[1];
  const map = js ? await anon.raw(`/${js}.map`) : null;
  r.check('H9', 'Static files', 'source maps are not served', map?.status === 404, `${map?.status}`);
  const pub = await anon.call('/api/health');
  const checks: { detail?: string; latencyMs?: number }[] = pub.data?.checks ?? [];
  r.check('H10', 'Health', 'public /api/health gives statuses only (no details, latencies zeroed) to anonymous callers', pub.status === 200 && checks.length > 0 && checks.every((c) => c.detail === undefined && !c.latencyMs), `${checks.length} checks`);
  r.note('H11', 'Health', 'what anonymous callers can see', `status, version ${pub.data?.version}, environment, start time and uptime (useful to load balancers; consider whether the version should be public)`);
}

export async function setup(w: World) {
  const { r } = w;
  const anon = new Client(w.base);
  const st = await anon.call('/api/setup/status');
  r.check('U1', 'Setup', 'a fresh install reports that setup is needed', st.data?.required === true, JSON.stringify(st.data));
  const wrong = await anon.call('/api/setup', { json: { setupToken: 'wrong-token-wrong-token-wrong-0', username: 'evil', displayName: 'Evil', password: PW } });
  r.check('U2', 'Setup', 'a wrong setup token is refused', wrong.status === 401, `${wrong.status}`);
  const cross = await anon.call('/api/setup', { json: { setupToken: w.setupToken, username: 'evil', displayName: 'Evil', password: PW }, origin: 'https://evil.example' });
  r.check('U3', 'CSRF', 'setup from another site is refused, even with the right token', cross.status === 403, `${cross.status}`);
  const ok = await w.admin.call('/api/setup', { json: { setupToken: w.setupToken, username: 'admin', displayName: 'Ada Admin', password: PW } });
  r.check('U4', 'Setup', 'the right token creates the first administrator, signed in', ok.status === 201 && !!w.admin.session(), `${ok.status}`);
  const again = await new Client(w.base).call('/api/setup', { json: { setupToken: w.setupToken, username: 'admin2', displayName: 'Two', password: PW } });
  r.check('U5', 'Setup', 'setup closes for good after first use', again.status === 409, `${again.status}`);
  await w.admin.call('/api/onboarding/setup-wizard', { method: 'PUT', json: { status: 'DISMISSED' } });
  await w.admin.call('/api/auth/tour', { json: { outcome: 'SKIPPED' } });
}

export async function signIn(w: World) {
  const { r } = w;
  const t0 = performance.now();
  const unknown = await new Client(w.base).login('no-such-user', 'whatever-password-1');
  const tUnknown = performance.now() - t0;
  const t1 = performance.now();
  const wrong = await new Client(w.base).login('admin', 'whatever-password-1');
  const tWrong = performance.now() - t1;
  r.check('S1', 'Sign-in', 'unknown user and wrong password get the same answer', unknown.status === 401 && wrong.status === 401 && unknown.body?.error?.message === wrong.body?.error?.message, `"${unknown.body?.error?.message}"`);
  r.check('S2', 'Sign-in', 'similar timing for unknown user and wrong password (dummy hash)', Math.abs(tUnknown - tWrong) < Math.max(tUnknown, tWrong) * 0.75, `${tUnknown.toFixed(0)} vs ${tWrong.toFixed(0)} ms`);
  const c = new Client(w.base);
  c.cookies.set('clawrouter_session', 'attacker-chosen-session-value');
  const res = await c.login('admin', PW);
  const cookie = res.res.headers.getSetCookie().find((x) => x.includes('clawrouter_session=')) ?? '';
  r.check('S3', 'Sessions', 'session cookie is HttpOnly, SameSite=Strict, Path=/', /HttpOnly/i.test(cookie) && /SameSite=Strict/i.test(cookie) && /Path=\//.test(cookie), cookie.replace(/=[^;]+/, '=…'));
  r.check('S4', 'Sessions', 'sign-in replaces a pre-set cookie (no fixation); token ≥ 256 bits', c.session() !== 'attacker-chosen-session-value' && (c.session()?.length ?? 0) >= 43, `${c.session()?.length} chars`);
  const forged = new Client(w.base);
  forged.cookies.set('clawrouter_session', 'A'.repeat(43));
  r.check('S5', 'Sessions', 'a forged session cookie is refused', (await forged.call('/api/auth/session')).status === 401);
  const stolen = c.session()!;
  await c.call('/api/auth/logout', { json: {} });
  const thief = new Client(w.base);
  thief.cookies.set('clawrouter_session', stolen);
  r.check('S6', 'Sessions', 'a token is dead after sign-out (server-side revocation)', (await thief.call('/api/auth/session')).status === 401);
}

export async function csrf(w: World) {
  const { r, admin } = w;
  const body = { theme: 'dark' };
  const noHeader = await admin.call('/api/auth/theme', { method: 'PUT', json: body, csrf: false });
  const crossOrigin = await admin.call('/api/auth/theme', { method: 'PUT', json: body, origin: 'https://evil.example' });
  const nullOrigin = await admin.call('/api/auth/theme', { method: 'PUT', json: body, origin: 'null' });
  const crossSite = await admin.call('/api/auth/theme', { method: 'PUT', json: body, origin: null, headers: { 'sec-fetch-site': 'cross-site' } });
  const form = await admin.call('/api/auth/theme', { method: 'PUT', body: 'theme=dark', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const plain = await admin.call('/api/auth/theme', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'text/plain' } });
  const same = await admin.call('/api/auth/theme', { method: 'PUT', json: body });
  r.check('C1', 'CSRF', 'a signed-in change without the CSRF header is refused', noHeader.status === 403, `${noHeader.status}`);
  r.check('C2', 'CSRF', 'another site\'s Origin, a "null" Origin and Sec-Fetch-Site cross-site are refused', crossOrigin.status === 403 && nullOrigin.status === 403 && crossSite.status === 403, `${crossOrigin.status}/${nullOrigin.status}/${crossSite.status}`);
  r.check('C3', 'CSRF', 'form-encoded and text/plain bodies are refused (only JSON, which needs a preflight)', form.status === 400 && plain.status === 400, `${form.status}/${plain.status}`);
  r.check('C4', 'CSRF', 'a same-origin request with the header works', same.status === 200, `${same.status}`);
  const pre = await admin.raw('/api/auth/theme', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' } });
  r.check('C5', 'CORS', 'no CORS on /api', !pre.headers.get('access-control-allow-origin'), `${pre.status}`);
}

async function newUser(w: World, username: string, roles: string[]) {
  const temp = `temporary pass ${username.length} 4821 qx`;
  const created = await w.admin.call('/api/users', { json: { username, displayName: username, password: temp, roles } });
  if (created.status !== 201) throw new Error(`create ${username}: ${created.status} ${created.text}`);
  w.planted.push(temp);
  const c = new Client(w.base, username);
  await c.login(username, temp);
  const password = `${PW} ${username}-ok`.replace(username, username.toUpperCase().split('').reverse().join(''));
  const ch = await c.call('/api/auth/password', { json: { currentPassword: temp, newPassword: password } });
  if (ch.status !== 200) throw new Error(`password ${username}: ${ch.status} ${ch.text}`);
  w.users[username] = { client: c, id: created.data.id, password };
  return w.users[username]!;
}
async function newRole(w: World, name: string, permissions: string[]) {
  const res = await w.admin.call('/api/roles', { json: { name, permissions } });
  if (res.status !== 201) throw new Error(`role ${name}: ${res.status} ${res.text}`);
  w.roles[name] = res.data.id;
  return res.data.id as string;
}

export async function people(w: World) {
  const { r } = w;
  const temp = await w.admin.call('/api/users', { json: { username: 'weak', displayName: 'w', password: 'weak-123', roles: [] } });
  r.check('P1', 'Passwords', 'a short password is refused', temp.status === 400, `${temp.status} ${temp.body?.error?.details?.issues?.[0]?.message ?? ''}`);
  const withName = await w.admin.call('/api/users', { json: { username: 'samuel', displayName: 's', password: 'samuel horse battery staple', roles: [] } });
  r.check('P2', 'Passwords', 'a password containing the username is refused', withName.status === 400, `${withName.status}`);
  await newUser(w, 'olga', ['OPERATOR']);
  await newUser(w, 'victor', ['VIEWER']);
  const dev = await newRole(w, 'Developers', ['api_keys.own', 'models.read']);
  await newUser(w, 'dana', [dev]);
  await newUser(w, 'dmitri', [dev]);
  await newUser(w, 'uma', [await newRole(w, 'User managers', ['users.read', 'users.write', 'roles.read', 'roles.assign'])]);
  await newUser(w, 'rosa', [await newRole(w, 'Role managers', ['roles.read', 'roles.write', 'roles.assign', 'users.read'])]);
  await newUser(w, 'nora', []);
  await newUser(w, 'kim', [dev]);
  const fresh = new Client(w.base);
  await w.admin.call('/api/users', { json: { username: 'tess', displayName: 'Tess', password: 'temporary pass 4 4821 qx', roles: ['VIEWER'] } });
  await fresh.login('tess', 'temporary pass 4 4821 qx');
  const blocked = await fresh.call('/api/providers');
  r.check('P3', 'Passwords', 'a temporary password allows nothing until it is changed', blocked.status === 403 && blocked.text.includes('password'), `${blocked.status}`);
}

export async function authorization(w: World) {
  const { r, admin, users: u, roles } = w;
  const adminId = (await admin.call('/api/auth/session')).data.user.id;
  const a = async (c: Client, path: string, method: string, json?: unknown) => (await c.call(path, { method, json })).status;
  r.check('A1', 'Authorization', 'a user manager cannot make themself Administrator', (await a(u.uma!.client, `/api/users/${u.uma!.id}/roles`, 'PUT', { roles: ['ADMIN'] })) === 403);
  r.check('A2', 'Authorization', 'nor give anyone a role with permissions they lack', (await a(u.uma!.client, `/api/users/${u.victor!.id}/roles`, 'PUT', { roles: ['OPERATOR'] })) === 403);
  r.check('A3', 'Authorization', "nor reset an administrator's password", (await a(u.uma!.client, `/api/users/${adminId}/password`, 'POST', { password: 'Owned by the user manager 1' })) === 403);
  r.check('A4', 'Authorization', 'nor disable an administrator', (await a(u.uma!.client, `/api/users/${adminId}`, 'PATCH', { status: 'DISABLED' })) === 403);
  r.check('A5', 'Authorization', "nor change another user's email (codes are sent there)", (await a(u.uma!.client, `/api/users/${u.victor!.id}`, 'PATCH', { email: 'attacker@example.com' })) >= 400);
  r.check('A6', 'Authorization', 'nor reset two-factor sign-in of an administrator', (await a(u.uma!.client, `/api/users/${adminId}/two-factor/reset`, 'POST', {})) === 403);
  r.check('A7', 'Authorization', 'a role manager cannot create a role with permissions they lack', (await a(u.rosa!.client, '/api/roles', 'POST', { name: 'Sneaky', permissions: ['settings.write'] })) === 403);
  r.check('A8', 'Authorization', 'nor widen their own role', (await a(u.rosa!.client, `/api/roles/${roles['Role managers']}`, 'PATCH', { permissions: ['roles.read', 'roles.write', 'roles.assign', 'users.read', 'settings.write'] })) === 403);
  const all = (await admin.call('/api/roles')).data.find((x: { id: string }) => x.id === 'ADMIN').permissions;
  r.check('A9', 'Authorization', 'no other role may hold every permission, even when an administrator asks', (await a(admin, '/api/roles', 'POST', { name: 'Second admin', permissions: all })) === 400);
  const edit = await a(admin, '/api/roles/ADMIN', 'PATCH', { name: 'Renamed' });
  const del = await a(admin, '/api/roles/ADMIN', 'DELETE');
  r.check('A10', 'Authorization', 'the Administrator role cannot be edited or deleted', edit === 409 && del === 409, `${edit}/${del}`);
  r.check('A11', 'Authorization', 'the last administrator cannot disable themself', (await a(admin, `/api/users/${adminId}`, 'PATCH', { status: 'DISABLED' })) === 409);
  const writes: [string, string, unknown][] = [
    ['/api/providers', 'POST', { name: 'x', identifier: 'xx', kind: 'openai' }], ['/api/settings', 'PUT', { values: { mcpEnabled: 1 } }],
    ['/api/routing', 'PUT', {}], ['/api/rate-limits', 'PUT', {}], ['/api/api-keys', 'POST', { name: 'x' }],
    ['/api/users', 'POST', { username: 'zz', displayName: 'z', password: 'x', roles: [] }], ['/api/announcements', 'POST', {}], ['/api/captures/manual', 'POST', {}],
    ['/api/configuration/import', 'POST', {}], ['/api/settings/mail', 'PUT', {}],
  ];
  const leaks: string[] = [];
  for (const [p, m, j] of writes) {
    const s = await a(u.victor!.client, p, m, j);
    if (s !== 403) leaks.push(`${m} ${p} ${s}`);
  }
  r.check('A12', 'Authorization', 'a Viewer cannot change anything', leaks.length === 0, leaks.join(', ') || `${writes.length} writes refused`);
  const reads = ['/api/logs', '/api/audit', '/api/users', '/api/sessions', '/api/captures', '/api/api-keys'];
  const vr = await Promise.all(reads.map(async (p) => `${p} ${await a(u.victor!.client, p, 'GET')}`));
  r.check('A13', 'Authorization', "a Viewer cannot read logs, audit, users, sessions, captures or everyone's keys", vr.every((x) => x.endsWith('403')), vr.join(', '));
  const nb = await Promise.all(['/api/providers', '/api/requests', '/api/usage', '/api/models', '/api/health/history', '/api/routing'].map(async (p) => `${p} ${await a(u.nora!.client, p, 'GET')}`));
  r.check('A14', 'Authorization', 'a user without roles is refused everywhere but their own pages', nb.every((x) => x.endsWith('403')), nb.join(', '));
  const own = await Promise.all(['/api/auth/session', '/api/me/api-keys', '/api/notifications', '/api/auth/sessions'].map(async (p) => `${p} ${await a(u.nora!.client, p, 'GET')}`));
  r.check('A15', 'Authorization', 'and can still see their own session, keys, notifications and sessions', own.every((x) => x.endsWith('200')), own.join(', '));
}

export async function otherUsers(w: World) {
  const { r, users: u } = w;
  const dana = u.dana!.client;
  const dmitri = u.dmitri!.client;
  const k = await dana.call('/api/me/api-keys', { json: { name: 'dana-key', expiry: { type: 'after', hours: 24 } } });
  const keyId = k.data?.key?.id;
  w.planted.push(k.data?.secret);
  const del = await dmitri.call(`/api/me/api-keys/${keyId}`, { method: 'DELETE' });
  const still = items((await dana.call('/api/me/api-keys')).data).some((x) => x.id === keyId && x.status === 'ACTIVE');
  r.check('O1', 'Other users', "a user cannot revoke another user's key", del.status === 404 && still, `${del.status}`);
  r.check('O2', 'Other users', "a user's key list shows only their own keys", !JSON.stringify((await dmitri.call('/api/me/api-keys')).data).includes(keyId));
  const sid = items((await dana.call('/api/auth/sessions')).data)[0]?.id;
  const ds = await dmitri.call(`/api/auth/sessions/${sid}`, { method: 'DELETE' });
  r.check('O3', 'Other users', "a user cannot end another user's session", ds.status === 404 && (await dana.call('/api/auth/session')).status === 200, `${ds.status}`);
  const op = await w.admin.call('/api/operations', { json: { type: 'health.check' } });
  const og = await dmitri.call(`/api/operations/${op.data?.id}`);
  const oc = await dmitri.call(`/api/operations/${op.data?.id}/cancel`, { json: {} });
  r.check('O4', 'Other users', 'without health.read, a health operation can be neither seen nor cancelled', og.status === 404 && oc.status === 404, `${og.status}/${oc.status}`);
  const req = await dmitri.call('/api/me/api-key-requests', { json: { name: 'dmitri wants', purpose: 'testing', expiry: { type: 'after', hours: 24 } } });
  const rid = req.data?.id;
  r.check('O5', 'Key requests', 'a requester cannot approve their own request', (await dmitri.call(`/api/api-key-requests/${rid}/approve`, { json: {} })).status === 403);
  r.check('O6', 'Key requests', "nobody else can turn someone's request into a key", (await dana.call(`/api/me/api-key-requests/${rid}/create`, { json: {} })).status === 404);
  const nora = u.nora!.client;
  const nreq = await nora.call('/api/me/api-key-requests', { json: { name: 'nora wants', purpose: 'reports', expiry: { type: 'after', hours: 24 } } });
  const adminNotes = JSON.stringify((await w.admin.call('/api/notifications')).data);
  const danaNotes = JSON.stringify((await dana.call('/api/notifications')).data);
  r.check('O7', 'Key requests', 'a key request notifies those who can approve it, not other users', nreq.status === 201 && adminNotes.includes('nora') && !danaNotes.includes('nora wants'), `${nreq.status}`);
  const nid = items((await w.admin.call('/api/notifications')).data)[0]?.id;
  if (nid) {
    await dmitri.call(`/api/notifications/${nid}`, { method: 'DELETE' });
    await dmitri.call(`/api/notifications/${nid}/read`, { json: {} });
    const after = items((await w.admin.call('/api/notifications')).data).find((n) => n.id === nid);
    r.check('O8', 'Other users', "a user can neither delete nor mark another user's notification", !!after && !after.readAt && after.read !== true, `${after ? 'kept' : 'gone'}`);
  }
}

export async function keyRules(w: World) {
  const { r, users: u } = w;
  const dana = u.dana!.client;
  const never = await dana.call('/api/me/api-keys', { json: { name: 'forever', expiry: { type: 'never' } } });
  r.check('K1', 'Key lifetime', 'a non-administrator cannot create a key that never expires', never.status === 400, `${never.status}`);
  const long = await dana.call('/api/me/api-keys', { json: { name: 'long', expiry: { type: 'after', hours: 24 * 31 } } });
  r.check('K2', 'Key lifetime', 'nor one that lives longer than the 30-day maximum', long.status === 400, `${long.status}`);
  const rl = await dana.call('/api/me/api-keys', { json: { name: 'unlimited', expiry: { type: 'after', hours: 1 }, rateLimit: { window: 'minute', requests: 100000 } } });
  r.check('K3', 'Self-service keys', 'self-service keys cannot set their own rate limit', rl.status === 400, `${rl.status}`);
  const nob = await u.nora!.client.call('/api/me/api-keys', { json: { name: 'x', expiry: { type: 'after', hours: 1 } } });
  r.check('K4', 'Self-service keys', 'creating own keys needs api_keys.own', nob.status === 403, `${nob.status}`);
  const adm = await w.admin.call('/api/me/api-keys', { json: { name: 'admin forever', expiry: { type: 'never' } } });
  r.check('K5', 'Key lifetime', 'an administrator may create a key that never expires', adm.status === 201, `${adm.status}`);
  w.planted.push(adm.data?.secret);
  const many: number[] = [];
  for (let i = 0; i < 6; i++) many.push((await u.kim!.client.call('/api/me/api-key-requests', { json: { name: `r${i}`, purpose: 'p', expiry: { type: 'after', hours: 1 } } })).status);
  r.check('K6', 'Key requests', 'at most 5 pending requests per user', many.filter((s) => s === 201).length <= 5 && many.at(-1)! >= 400, many.join(','));
}

export async function secrets(w: World) {
  const { r, admin } = w;
  const p = await admin.call('/api/providers', { json: { name: 'Mock OpenAI', identifier: 'mock', kind: 'openai', endpoint: `${w.mock.url}/openai/v1`, apiKey: w.providerKey } });
  w.providerId = p.data?.id;
  await admin.call(`/api/providers/${w.providerId}/models/import`, { json: { providerModelIds: ['gpt-4o-mini', 'gpt-4o', 'text-embedding-3-small'] } });
  r.check('X1', 'Providers', 'a provider is added with its key; the answer never shows it', p.status === 201 && !p.text.includes(w.providerKey), `${p.status}`);
  const test = await admin.call(`/api/providers/${w.providerId}/test`, { json: {} });
  r.check('X1b', 'Providers', 'a connection test decrypts the stored key and authenticates at the provider', test.data?.ok === true && !test.text.includes(w.providerKey), test.data?.message ?? `${test.status}`);
  const k = await admin.call('/api/api-keys', { json: { name: 'audit-gateway', expiry: { type: 'never' } } });
  w.gatewayKey = k.data?.secret ?? '';
  w.planted.push(w.gatewayKey);
  r.check('X2', 'API keys', 'a key secret is shown once at creation, with Cache-Control: no-store', w.gatewayKey.startsWith('crk_') && k.res.headers.get('cache-control') === 'no-store');
  const moved = await admin.call(`/api/providers/${w.providerId}`, { method: 'PATCH', json: { endpoint: 'https://api.example.com/v1' } });
  r.check('X3', 'Providers', 'moving a stored key to a different host needs the key entered again', moved.status === 400, `${moved.status} ${moved.body?.error?.details?.issues?.[0]?.message ?? ''}`);
}

/** Runs at the end: every planted secret is searched for everywhere it could leak. */
export async function leakSweep(w: World) {
  const { r, admin } = w;
  const planted = w.planted.filter((s) => typeof s === 'string' && s.length >= 8);
  planted.push(w.providerKey, PW, w.setupToken);
  for (const u of Object.values(w.users)) planted.push(u.password);
  const views = ['/api/providers', `/api/providers/${w.providerId}`, '/api/api-keys', '/api/me/api-keys', '/api/configuration/export', '/api/audit?pageSize=200', '/api/logs?pageSize=500', '/api/settings', '/api/settings/mail', '/api/requests', '/api/notifications', '/api/users', '/api/sessions', '/api/operations', '/api/captures', '/api/usage', '/api/rate-limits/usage', '/api/announcements'];
  const found: string[] = [];
  for (const v of views) {
    const res = await admin.call(v);
    for (const s of planted) if (res.text.includes(s)) found.push(`${v}: ${s.slice(0, 6)}…`);
  }
  r.check('L1', 'Secrets', 'no API answer contains a planted key, password or token', found.length === 0, found.join(', ') || `${views.length} views × ${planted.length} secrets`);
  const db = new Database(w.db, { readonly: true });
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  const hits: string[] = [];
  for (const { name } of tables) {
    const text = JSON.stringify(db.query(`SELECT * FROM "${name}"`).all());
    for (const s of planted) if (text.includes(s)) hits.push(`${name}: ${s.slice(0, 6)}…`);
  }
  const hashes = JSON.stringify(db.query('SELECT password_hash FROM users').all());
  db.close();
  r.check('L2', 'Secrets', 'no database table holds a planted secret in plain text', hits.length === 0, hits.join(', ') || `${tables.length} tables`);
  r.check('L3', 'Secrets', 'passwords are stored as argon2id hashes', /\$argon2id\$/.test(hashes));
  const log = w.serverLog();
  const inLog = planted.filter((s) => log.includes(s));
  r.check('L4', 'Secrets', 'the server log holds no planted secret', inLog.length === 0, inLog.map((s) => `${s.slice(0, 6)}…`).join(', '));
  const files = readFileSync(`${w.dir}/secret.key`, 'utf8');
  r.check('L5', 'Secrets', 'the encryption key is not in the database or the log', !JSON.stringify(hits).includes(files.trim()) && !log.includes(files.trim()));
}
