/**
 * Audit probes, part 3: the command-line tools (backup, restore, doctor, migrate,
 * key rotation, password reset), configuration export and import, the audit trail,
 * graceful shutdown, and a second server with real HTTPS and a trusted proxy.
 */
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, items } from './lib.ts';
import { PW, type World } from './probes-web.ts';
import { cli, startServer } from './server.ts';

const randomKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');

export async function operations(w: World) {
  const { r } = w;
  const env = { CLAWROUTER_ENV: 'production', CLAWROUTER_DATABASE_PATH: w.db, CLAWROUTER_SECRET_KEY_FILE: join(w.dir, 'secret.key') };
  const backups = join(w.dir, 'backups');
  const b = await cli(w.dist, 'backup', ['--dir', backups], env);
  const backupDir = /Backup written to (\S+)/.exec(b.out)?.[1] ?? '';
  r.check('OP1', 'Backups', 'a consistent backup can be taken while the server runs; the key is left out', b.code === 0 && !!backupDir && /secret key is not in the backup/i.test(b.out), b.out.split('\n')[0]);
  const list = await cli(w.dist, 'backup', ['--dir', backups, '--list'], env);
  r.check('OP2', 'Backups', 'backups are listed with their key fingerprint', list.code === 0 && /key [0-9a-f]{16}/.test(list.out));
  const doc = await cli(w.dist, 'doctor', ['--json'], env);
  const checks = JSON.parse(doc.out.slice(doc.out.indexOf('['))) as { level: string; area: string; message: string }[];
  r.check('OP3', 'Doctor', 'doctor finds the deployment healthy (no problems) and sees the running server', !checks.some((c) => c.level === 'error') && checks.some((c) => c.area === 'server' && /running/.test(c.message)), checks.filter((c) => c.level !== 'ok').map((c) => `${c.area}: ${c.message}`).join('; ').slice(0, 200));
  const mig = await cli(w.dist, 'migrate', ['--status'], env);
  r.check('OP4', 'Migrations', 'migrate --status lists every migration as applied', mig.code === 0 && !/pending|✖/.test(mig.out) && /0025_/.test(mig.out));
  const over = await cli(w.dist, 'restore', [backupDir, '--yes'], env);
  r.check('OP5', 'Restore', 'restore refuses to overwrite a running server', over.code !== 0 && /running/i.test(over.out), over.out.trim().split('\n')[0]);
  const otherKey = join(w.dir, 'other.key');
  writeFileSync(otherKey, randomKey(), { mode: 0o600 });
  const wrongKey = await cli(w.dist, 'restore', [backupDir, '--yes'], { ...env, CLAWROUTER_DATABASE_PATH: join(w.dir, 'copy-wrong.db'), CLAWROUTER_SECRET_KEY_FILE: otherKey });
  r.check('OP6', 'Restore', 'restore refuses a backup the configured key cannot open', wrongKey.code !== 0 && /cannot be opened/.test(wrongKey.out));
  const copyDb = join(w.dir, 'copy.db');
  const restored = await cli(w.dist, 'restore', [backupDir, '--yes'], { ...env, CLAWROUTER_DATABASE_PATH: copyDb });
  r.check('OP7', 'Restore', 'a backup restores into a new database', restored.code === 0 && /Restored/.test(restored.out));
  const newKey = join(w.dir, 'new.key');
  writeFileSync(newKey, randomKey(), { mode: 0o600 });
  const rot = await cli(w.dist, 'rotate-secret-key', ['--new-key-file', newKey], { ...env, CLAWROUTER_DATABASE_PATH: copyDb });
  const after = await cli(w.dist, 'doctor', [], { ...env, CLAWROUTER_DATABASE_PATH: copyDb, CLAWROUTER_SECRET_KEY_FILE: newKey });
  const old = await cli(w.dist, 'doctor', [], { ...env, CLAWROUTER_DATABASE_PATH: copyDb });
  r.check('OP8', 'Key rotation', 'rotation re-encrypts every secret; the old key then opens none', rot.code === 0 && /all \d+ open with this key/.test(after.out) && /cannot be opened with this key/.test(old.out));
  const reset = await cli(w.dist, 'reset-password', ['olga', '--enable'], { ...env, CLAWROUTER_DATABASE_PATH: copyDb, CLAWROUTER_SECRET_KEY_FILE: newKey });
  const temp = /Temporary password for olga: (\S+)/.exec(reset.out)?.[1] ?? '';
  w.planted.push(temp);
  r.check('OP9', 'Password reset', 'reset-password prints a temporary password', reset.code === 0 && temp.length >= 16);
  const copy = await startServer(w.dist, w.dir, 'copy-server', { CLAWROUTER_DATABASE_PATH: copyDb, CLAWROUTER_SECRET_KEY_FILE: newKey });
  try {
    const a = new Client(copy.base);
    const signin = await a.login('admin', PW);
    const users = items((await a.call('/api/users')).data).length;
    const original = items((await w.admin.call('/api/users')).data).length;
    const test = await a.call(`/api/providers/${w.providerId}/test`, { json: {} });
    r.check('OP10', 'Restore', 'a server on the restored, re-keyed copy has every user and its provider key still works', signin.status === 200 && users === original && test.data?.ok === true, `${users}/${original} users, provider test ${test.data?.message ?? test.status}`);
    const o = new Client(copy.base);
    await o.login('olga', temp);
    const held = await o.call('/api/providers');
    r.check('OP11', 'Password reset', 'the temporary password must be changed before anything else', held.status === 403 && /password/i.test(held.text));
  } finally {
    const log = await copy.stop();
    r.check('OP12', 'Shutdown', 'SIGTERM drains and stops cleanly', /shutdown requested/.test(log) && /draining/.test(log) && /ClawRouter stopped/.test(log));
  }

  const ex = await w.admin.call('/api/configuration/export');
  r.check('OP13', 'Configuration', 'the export holds no provider key and no password', ex.status === 200 && !ex.text.includes(w.providerKey) && !/"(apiKey|password)":\s*"[^"]/.test(ex.text), Object.keys(ex.data ?? {}).join(', '));
  const prev = await w.admin.call('/api/configuration/import/preview', { json: ex.data });
  const changed = (prev.data?.changes ?? []).filter((c: { action: string }) => c.action !== 'unchanged');
  r.check('OP14', 'Configuration', 'importing an export back changes nothing', prev.status === 200 && changed.length === 0, changed.map((c: { section: string; name: string; action: string }) => `${c.section}/${c.name}:${c.action}`).join(', '));
  const rosa = w.users.rosa!.client;
  const imp = await rosa.call('/api/configuration/import/preview', { json: ex.data });
  r.check('OP15', 'Configuration', 'importing needs settings.write', imp.status === 403);

  // One query per action (a page holds at most 200 records).
  const count = async (action: string) => (await w.admin.call(`/api/audit?action=${action}&pageSize=1`)).body?.meta?.total ?? 0;
  const want = ['SETUP_COMPLETED', 'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'USER_CREATED', 'USER_UPDATED', 'USER_DISABLED', 'USER_ENABLED', 'ROLE_CREATED', 'ROLE_UPDATED', 'ROLE_CHANGED', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'EMAIL_CHANGED', 'TWO_FACTOR_ENABLED', 'TWO_FACTOR_DISABLED', 'TWO_FACTOR_RESET', 'API_KEY_CREATED', 'API_KEY_UPDATED', 'API_KEY_REVOKED', 'API_KEY_REQUESTED', 'USER_QUOTA_UPDATED', 'PROVIDER_CREATED', 'PROVIDER_UPDATED', 'PROVIDER_DELETED', 'CREDENTIAL_CREATED', 'MODEL_CREATED', 'ROUTING_UPDATED', 'CONNECTION_TEST', 'OPERATION_STARTED', 'CONFIGURATION_EXPORTED', 'BACKUP_CREATED', 'ANNOUNCEMENT_CREATED', 'ANNOUNCEMENT_DELETED', 'CAPTURE_STARTED', 'CAPTURES_EXPORTED', 'SETTINGS_CHANGED', 'SESSION_REVOKED'];
  const unknown: string[] = [];
  const missing: string[] = [];
  for (const a of want) {
    const res = await w.admin.call(`/api/audit?action=${a}&pageSize=1`);
    if (res.status === 400) unknown.push(a);
    else if (!(await count(a))) missing.push(a);
  }
  r.check('OP16', 'Audit', 'sign-ins, users, roles, passwords, keys, providers, exports, backups, announcements, captures, settings, two-factor resets and session revocations are audited', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${want.length - unknown.length} kinds present`);
  if (unknown.length) r.note('OP17', 'Audit', 'action names this check guessed that do not exist', `${unknown.join(', ')} (see AUDIT_ACTIONS for the real names)`);
  const spoof = new Client(w.base);
  await spoof.call('/api/auth/login', { json: { username: 'admin', password: 'spoofed address attempt' }, headers: { 'x-forwarded-for': '203.0.113.9' } });
  const last = items((await w.admin.call('/api/audit?pageSize=5')).data).find((a) => a.action === 'LOGIN_FAILED');
  r.check('OP18', 'Proxies', 'without trusted proxies, X-Forwarded-For is ignored (audit keeps the real address)', last?.ip === '127.0.0.1', `${last?.ip}`);
}

export async function httpsAndProxy(w: World) {
  const { r } = w;
  const cert = join(w.dir, 'tls.crt');
  const keyFile = join(w.dir, 'tls.key');
  const gen = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
  if (gen.exitCode !== 0) {
    r.note('TLS0', 'HTTPS', 'HTTPS checks skipped', 'openssl could not create a test certificate');
    return;
  }
  const db = join(w.dir, 'tls.db');
  const secret = join(w.dir, 'tls-secret.key');
  copyFileSync(join(w.dir, 'secret.key'), secret);
  const token = 'tls-setup-token-0123456789abcdef';
  const s = await startServer(w.dist, w.dir, 'tls-server', { CLAWROUTER_DATABASE_PATH: db, CLAWROUTER_SECRET_KEY_FILE: secret, CLAWROUTER_SETUP_TOKEN: token, CLAWROUTER_TLS_CERT_FILE: cert, CLAWROUTER_TLS_KEY_FILE: keyFile, CLAWROUTER_TRUSTED_PROXIES: '127.0.0.1' });
  try {
    const a = new Client(s.base);
    const page = await a.raw('/');
    r.check('TLS1', 'HTTPS', 'over HTTPS, HSTS is sent', /max-age=\d+/.test(page.headers.get('strict-transport-security') ?? ''), page.headers.get('strict-transport-security') ?? '(none)');
    const setupRes = await a.call('/api/setup', { json: { setupToken: token, username: 'admin', displayName: 'Ada', password: PW }, headers: { 'x-forwarded-for': '198.51.100.7' } });
    const cookie = setupRes.res.headers.getSetCookie().find((c) => c.includes('clawrouter_session=')) ?? '';
    r.check('TLS2', 'HTTPS', 'the session cookie is Secure with the __Host- prefix', /^__Host-clawrouter_session=/.test(cookie) && /;\s*Secure/i.test(cookie), cookie.replace(/=[^;]+/, '=…'));
    const plain = await fetch(s.base.replace('https', 'http') + '/api/health').then((x) => x.status).catch(() => 'refused');
    r.check('TLS3', 'HTTPS', 'plain HTTP is not served on the HTTPS port', plain !== 200, `${plain}`);
    await new Client(s.base).call('/api/auth/login', { json: { username: 'admin', password: 'wrong from behind a proxy' }, headers: { 'x-forwarded-for': '203.0.113.50, 198.51.100.20' } });
    const fwd = items((await a.call('/api/audit?pageSize=5')).data).find((x) => x.action === 'LOGIN_FAILED');
    r.check('TLS4', 'Proxies', 'behind a trusted proxy, the right-most untrusted X-Forwarded-For hop is the client', fwd?.ip === '198.51.100.20', `${fwd?.ip}`);
    const blocked: number[] = [];
    for (let i = 0; i < 25; i++) blocked.push((await fetch(`${s.base}/v1/models`, { headers: { authorization: `Bearer crk_${'q'.repeat(60)}`, 'x-forwarded-for': '192.0.2.1' }, tls: { rejectUnauthorized: false } } as RequestInit)).status);
    const otherClient = (await fetch(`${s.base}/v1/models`, { headers: { authorization: `Bearer crk_${'q'.repeat(60)}`, 'x-forwarded-for': '192.0.2.2' }, tls: { rejectUnauthorized: false } } as RequestInit)).status;
    r.check('TLS5', 'Proxies', 'per-address limits apply to the real client, not the proxy (another client is not blocked)', blocked.includes(429) && otherClient === 401, `first client ${blocked.at(-1)}, second ${otherClient}`);
  } finally {
    await s.stop();
  }
}
