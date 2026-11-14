import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base32Decode, hotp, totpStep } from '@clawrouter/authentication';
import { createSecretBox, generateSecretKey, loadConfig, parseSecretKey, silentLogger } from '@clawrouter/core';
import { migrations, openSqlite, runMigrations } from '@clawrouter/database';
import type { ApiSuccess, TotpSetup, TwoFactorStatus } from '@clawrouter/shared';
import { clearUnreadable, findUnreadable } from '../src/clear-credentials.ts';
import { runDoctor } from '../src/doctor.ts';
import { startClawRouter } from '../src/server.ts';
import { createHarness, fastHasher } from '../../../tests/support/harness.ts';

const root = mkdtempSync(join(tmpdir(), 'clawrouter-recovery-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const newBox = () => createSecretBox(parseSecretKey(generateSecretKey()));
const actor = { id: 'u1', username: 'admin' };

describe('credential recovery (lost secret key)', () => {
  test('lists, then forgets, exactly the values the configured key cannot open', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await h.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: 'https://api.example.test/v1', apiKey: 'sk-recovery-0123456789abcdef' }, { ip: null });
    await h.request('/api/settings/mail', { method: 'PUT', cookie: admin, json: { enabled: true, host: 'smtp.example.test', port: 587, security: 'starttls', username: 'mailer', password: 'smtp-recovery', from: 'c@example.test' } });
    const setup = ((await (await h.request('/api/auth/2fa/totp', { method: 'POST', cookie: admin, json: {} })).json()) as ApiSuccess<TotpSetup>).data;
    await h.request('/api/auth/2fa/totp/confirm', { method: 'POST', cookie: admin, json: { code: hotp(base32Decode(setup.secret), totpStep(h.clock.time)) } });

    expect(await findUnreadable(h.db, h.secrets)).toEqual([]);
    const lost = newBox(); // the old key is gone; a new one is configured
    expect((await findUnreadable(h.db, lost)).map((s) => `${s.store}: ${s.label}`)).toEqual([
      'provider credentials: provider openai', 'mail server password: mail server smtp.example.test', 'authenticator-app secrets: user admin',
    ]);

    const cleared = await clearUnreadable(h.db, lost);
    expect(cleared).toHaveLength(3);
    expect(await findUnreadable(h.db, lost)).toEqual([]);
    expect(h.providers.list()[0]!.credential.configured).toBe(false);
    expect(h.mail.get()).toMatchObject({ host: 'smtp.example.test', passwordSet: false });
    const status = ((await (await h.request('/api/auth/2fa', { cookie: admin })).json()) as ApiSuccess<TwoFactorStatus>).data;
    expect(status.enrolled).not.toContain('totp');
    const record = h.audit.list({ action: 'CREDENTIALS_CLEARED' })[0]!;
    expect(record.metadata).toMatchObject({ keyFingerprint: lost.fingerprint });
    expect(JSON.stringify(record)).not.toContain('sk-recovery');
  });
});

describe('doctor', () => {
  test('reports a key that cannot open stored values, and a healthy deployment', async () => {
    const dir = join(root, 'doctor');
    const dbPath = join(dir, 'clawrouter.db');
    const key = generateSecretKey();
    const config = loadConfig({ CLAWROUTER_ENV: 'production', CLAWROUTER_DATABASE_PATH: dbPath, CLAWROUTER_SECRET_KEY: key, CLAWROUTER_PORT: '0', CLAWROUTER_SETUP_TOKEN: 'x'.repeat(20) });
    const app = await startClawRouter({ config, log: silentLogger, version: 't', hasher: fastHasher });
    await app.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: 'https://api.example.test/v1', apiKey: 'sk-doctor-0123456789abcdef' }, { ip: null });

    const good = await runDoctor(config, createSecretBox(parseSecretKey(key)), null);
    const level = (checks: typeof good, area: string) => checks.filter((c) => c.area === area).map((c) => c.level);
    expect(level(good, 'encrypted values')).toEqual(['ok']);
    expect(level(good, 'migrations')).toEqual(['ok']);
    expect(level(good, 'database')).toEqual(['ok']);
    expect(good.find((c) => c.area === 'server')!.message).toContain(String(process.pid));
    expect(level(good, 'backups')).toContain('warn'); // production without any backup yet

    const wrong = await runDoctor(config, newBox(), null);
    expect(wrong.find((c) => c.area === 'encrypted values')).toMatchObject({ level: 'error', message: expect.stringContaining('provider openai') });
    expect(JSON.stringify(wrong)).not.toContain('sk-doctor');
    await app.stop({ graceMs: 0 });

    const noKey = await runDoctor(config, null, 'file not found');
    expect(noKey.find((c) => c.area === 'secret key')!.level).toBe('error');
  });

  test('a database from a newer version is an error', async () => {
    const dbPath = join(root, 'newer.db');
    const db = openSqlite({ path: dbPath });
    runMigrations(db, migrations);
    db.run("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES ('9999_future', 'x', '2027-01-01')");
    db.close();
    const checks = await runDoctor(loadConfig({ CLAWROUTER_DATABASE_PATH: dbPath }), newBox(), null);
    expect(checks.find((c) => c.area === 'migrations')).toMatchObject({ level: 'error', message: expect.stringContaining('newer ClawRouter') });
  });
});

/** A self-signed certificate valid for `days`, via openssl (skipped where it is missing). */
function certificate(days: number): { cert: string; key: string } | null {
  const dir = mkdtempSync(join(root, 'tls-'));
  const result = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', String(days), '-subj', '/CN=localhost',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdout: 'ignore', stderr: 'ignore' });
  return result.exitCode === 0 ? { cert: join(dir, 'cert.pem'), key: join(dir, 'key.pem') } : null;
}

describe('serving HTTPS directly', () => {
  test('with CLAWROUTER_TLS_CERT_FILE/KEY_FILE ClawRouter speaks HTTPS; doctor warns before the certificate expires', async () => {
    const tls = certificate(10);
    if (!tls) return; // no openssl here
    const config = loadConfig({ CLAWROUTER_ENV: 'test', CLAWROUTER_PORT: '0', CLAWROUTER_SETUP_TOKEN: 'x'.repeat(20), CLAWROUTER_TLS_CERT_FILE: tls.cert, CLAWROUTER_TLS_KEY_FILE: tls.key });
    expect(config.auth.cookieSecure).toBe(true);
    const app = await startClawRouter({ config, log: silentLogger, version: 't', hasher: fastHasher });
    try {
      expect(app.url.protocol).toBe('https:');
      const res = await fetch(new URL('/api/health/live', app.url), { tls: { rejectUnauthorized: false } } as RequestInit);
      expect(res.status).toBe(200);
      expect(res.headers.get('strict-transport-security')).toContain('max-age='); // browsers keep to HTTPS from then on
    } finally {
      await app.stop({ graceMs: 0 });
    }
    const checks = await runDoctor(config, newBox(), null);
    expect(checks.find((c) => c.area === 'https')).toMatchObject({ level: 'warn', message: expect.stringContaining('expires in') });
  });
});
