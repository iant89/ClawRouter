/*
 * ClawRouter - Self-hosted AI gateway and control platform
 * https://github.com/iant89/ClawRouter
 *
 * Copyright (C) 2026 Ian Thomas
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * in the LICENSE file for more details.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditService, createSqliteAuditRepository } from '@clawrouter/audit';
import { base32Decode, hotp, totpStep } from '@clawrouter/authentication';
import { createSecretBox, generateSecretKey, loadConfig, parseSecretKey, silentLogger } from '@clawrouter/core';
import { migrations, openSqlite, runMigrations } from '@clawrouter/database';
import type { ApiSuccess, TotpSetup, TwoFactorStatus } from '@clawrouter/shared';
import { clearUnreadable, findUnreadable } from '../src/clear-credentials.ts';
import { applyRepairs, plannedRepairs, runDoctor } from '../src/doctor.ts';
import { createBackup, listBackups } from '../src/backup.ts';
import { loadSecretBox } from '../src/secret-key.ts';
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

  test('names provider endpoints the outbound policy refuses, and the allowlist', async () => {
    // A local model server added before the outbound policy existed (SEC-001).
    const dbPath = join(root, 'outbound.db');
    const db = openSqlite({ path: dbPath });
    runMigrations(db, migrations);
    db.run("INSERT INTO providers (id, name, identifier, kind, endpoint, created_at, updated_at) VALUES ('p1', 'Local', 'local', 'ollama', 'http://127.0.0.1:11434/v1', '2026-01-01', '2026-01-01')");
    db.close();
    const closed = await runDoctor(loadConfig({ CLAWROUTER_DATABASE_PATH: dbPath, CLAWROUTER_OUTBOUND_ALLOWLIST: '' }), newBox(), null);
    expect(closed.find((c) => c.area === 'outbound')).toMatchObject({ level: 'error', message: expect.stringContaining('local (127.0.0.1 is a loopback address'), fix: expect.stringContaining('CLAWROUTER_OUTBOUND_ALLOWLIST') });
    const open = await runDoctor(loadConfig({ CLAWROUTER_DATABASE_PATH: dbPath, CLAWROUTER_OUTBOUND_ALLOWLIST: '127.0.0.1, 0.0.0.0/0' }), newBox(), null);
    expect(open.filter((c) => c.area === 'outbound').map((c) => c.level).sort()).toEqual(['info', 'ok', 'warn']);
  });

  test('warns about the secret key among normal backups, and about an open credentials directory (SEC-011)', async () => {
    const dir = join(root, 'credential-backups');
    const dbPath = join(dir, 'clawrouter.db');
    const box = newBox();
    const db = openSqlite({ path: dbPath });
    runMigrations(db, migrations);
    const backupDir = join(dir, 'backups');
    const { path } = await createBackup(db, { dir: backupDir, box, version: 't' });
    await createBackup(db, { dir: backupDir, box, version: 't', includeSecretKey: 'k'.repeat(44), confirmSecretKey: true });
    db.close();
    const config = loadConfig({ CLAWROUTER_DATABASE_PATH: dbPath });
    const backups = async () => (await runDoctor(config, box, null)).filter((c) => c.area === 'backups');
    expect((await backups()).find((c) => c.message.includes('credential backup'))).toMatchObject({ level: 'info' });
    chmodSync(join(backupDir, 'credentials'), 0o755);
    expect((await backups()).find((c) => c.message.includes('credential backup'))).toMatchObject({ level: 'warn', message: expect.stringContaining('readable by other users') });
    // A key left in a normal backup (as before SEC-011).
    const manifestFile = join(path, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, kind: undefined, secretKey: { ...manifest.secretKey, included: true } }));
    expect((await backups()).find((c) => c.message.includes('contain the secret key'))).toMatchObject({ level: 'warn' });
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

/** The DOCTOR_REPAIR records in a database's audit log. */
function repairAudit(dbPath: string) {
  const db = openSqlite({ path: dbPath });
  try {
    return createAuditService(createSqliteAuditRepository(db), silentLogger).list({ action: 'DOCTOR_REPAIR' }).map((r) => ({ resourceId: r.resourceId, result: r.result, actorName: r.actorName, metadata: r.metadata }));
  } finally {
    db.close();
  }
}

describe('doctor --fix', () => {
  const repairIds = (checks: Awaited<ReturnType<typeof runDoctor>>, includeDestructive = false) => plannedRepairs(checks, { includeDestructive }).map((r) => r.id);

  test('repairs a stale process-ID file, an open key file, missing backups and pending migrations', async () => {
    const dir = join(root, 'fix');
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'clawrouter.db');
    const keyFile = join(dir, 'secret.key');
    writeFileSync(keyFile, generateSecretKey(), { mode: 0o644 });
    chmodSync(keyFile, 0o644);
    // A database one migration behind, as after an upgrade, and a process-ID file from a crash.
    const db = openSqlite({ path: dbPath });
    runMigrations(db, migrations.slice(0, -1));
    db.close();
    writeFileSync(`${dbPath}.pid`, '2147483646\n');
    const config = loadConfig({ CLAWROUTER_ENV: 'production', CLAWROUTER_DATABASE_PATH: dbPath, CLAWROUTER_SECRET_KEY_FILE: keyFile, CLAWROUTER_SETUP_TOKEN: 'x'.repeat(20) });
    const box = loadSecretBox(config, silentLogger);

    const before = await runDoctor(config, box, null);
    // The directory (0755) and the process-ID file (0644) were made by hand with a wide umask (SEC-023).
    expect(repairIds(before)).toEqual(['stale-pid', 'key-permissions', 'file-permissions', 'backup', 'migrate']);

    const results = await applyRepairs(config, box, plannedRepairs(before), { version: 't' });
    expect(results.map((r) => [r.id, r.ok])).toEqual([['stale-pid', true], ['key-permissions', true], ['file-permissions', true], ['backup', true], ['migrate', true]]);
    expect(existsSync(`${dbPath}.pid`)).toBe(false);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(listBackups(config.database.backupDir).map((b) => b.manifest?.label).sort()).toEqual(['manual', 'pre-migrate']);

    const after = await runDoctor(config, box, null);
    expect(repairIds(after)).toEqual([]);
    expect(after.find((c) => c.area === 'migrations')).toMatchObject({ level: 'ok' });
    expect(after.filter((c) => c.level === 'error')).toEqual([]);
    // Each repair is in the audit log, in order, as the command line.
    expect(repairAudit(dbPath).map((r) => [r.resourceId, r.result]).sort()).toEqual([["backup", "SUCCESS"], ["file-permissions", "SUCCESS"], ["key-permissions", "SUCCESS"], ["migrate", "SUCCESS"], ["stale-pid", "SUCCESS"]]);
  });

  test('does not migrate under a running server, and refuses if one started meanwhile', async () => {
    const dir = join(root, 'fix-running');
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'clawrouter.db');
    const db = openSqlite({ path: dbPath });
    runMigrations(db, migrations.slice(0, -1));
    db.close();
    writeFileSync(`${dbPath}.pid`, `${process.pid}\n`); // this test process stands in for the server
    const config = loadConfig({ CLAWROUTER_DATABASE_PATH: dbPath, CLAWROUTER_SECRET_KEY: generateSecretKey() });
    const box = loadSecretBox(config, silentLogger);
    const checks = await runDoctor(config, box, null);
    expect(repairIds(checks)).not.toContain('migrate');
    expect(checks.find((c) => c.area === 'migrations')!.fix).toContain('Stop ClawRouter');
    const [result] = await applyRepairs(config, box, [{ id: 'migrate', action: 'x' }], { version: 't' });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('stop it first') });
    expect(repairAudit(dbPath)).toEqual([expect.objectContaining({ resourceId: "migrate", result: "FAILURE", actorName: "command line", metadata: expect.objectContaining({ outcome: expect.stringContaining("stop it first") }) })]);
  });

  test('forgets unreadable values only when asked, after a backup', async () => {
    const dir = join(root, 'fix-key');
    const dbPath = join(dir, 'clawrouter.db');
    const config = loadConfig({ CLAWROUTER_ENV: 'test', CLAWROUTER_DATABASE_PATH: dbPath, CLAWROUTER_SECRET_KEY: generateSecretKey(), CLAWROUTER_PORT: '0', CLAWROUTER_SETUP_TOKEN: 'x'.repeat(20) });
    const app = await startClawRouter({ config, log: silentLogger, version: 't', hasher: fastHasher });
    await app.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: 'https://api.example.test/v1', apiKey: 'sk-fix-0123456789abcdef' }, { ip: null });
    await app.stop({ graceMs: 0 });

    const lost = newBox(); // the original key is gone
    const checks = await runDoctor(config, lost, null);
    expect(repairIds(checks)).not.toContain('clear-credentials');
    expect(repairIds(checks, true)).toContain('clear-credentials');

    const results = await applyRepairs(config, lost, plannedRepairs(checks, { includeDestructive: true }), { version: 't' });
    const cleared = results.find((r) => r.id === 'clear-credentials')!;
    expect(cleared).toMatchObject({ ok: true, message: expect.stringContaining('provider openai') });
    expect(listBackups(config.database.backupDir).some((b) => b.manifest?.label === 'pre-repair')).toBe(true);
    expect(JSON.stringify(results)).not.toContain('sk-fix');
    const after = await runDoctor(config, lost, null);
    expect(after.find((c) => c.area === 'encrypted values')).toMatchObject({ level: 'ok' });
    const audit = repairAudit(dbPath);
    expect(audit.map((r) => [r.resourceId, r.result])).toContainEqual(["clear-credentials", "SUCCESS"]);
    expect(JSON.stringify(audit)).not.toContain("sk-fix");
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
