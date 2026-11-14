import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretBox, generateSecretKey, loadConfig, parseSecretKey, silentLogger } from '@clawrouter/core';
import { migrations, openSqlite, runMigrations } from '@clawrouter/database';
import { checkBackup, createBackup, listBackups, pruneBackups, restoreBackup, type BackupManifest } from '../src/backup.ts';
import { startClawRouter } from '../src/server.ts';
import { createHarness, fastHasher } from '../../../tests/support/harness.ts';

const root = mkdtempSync(join(tmpdir(), 'clawrouter-backup-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `case-${++n}`);
const actor = { id: 'u1', username: 'admin' };

/** A harness with one provider key (an encrypted value) and the admin user. */
async function world() {
  const h = createHarness();
  await h.completeSetup();
  await h.providers.create(actor, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: 'https://api.example.test/v1', apiKey: 'sk-backup-canary-0123456789' }, { ip: null });
  return h;
}

describe('backups (phase 17)', () => {
  test('a backup is a verified copy with a manifest; the secret key only when asked', async () => {
    const h = await world();
    const dir = fresh();
    const { path, manifest } = await createBackup(h.db, { dir, box: h.secrets, version: '1.2.3', now: new Date('2026-11-14T15:30:00Z') });
    expect(path).toBe(join(dir, 'clawrouter-20261114-153000'));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(path, 'clawrouter.db')).mode & 0o777).toBe(0o600);
    expect(manifest).toMatchObject({
      format: 'clawrouter-backup', clawrouterVersion: '1.2.3', label: 'manual', migrations: migrations.map((m) => m.id),
      secretKey: { fingerprint: h.secrets.fingerprint, included: false }, encryptedValues: 1,
    });
    expect(existsSync(join(path, 'secret.key'))).toBe(false);
    expect(JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'))).toEqual(manifest);
    // The copy is a complete database.
    const copy = openSqlite({ path: join(path, 'clawrouter.db'), readonly: true });
    expect(copy.get<{ n: number }>('SELECT COUNT(*) AS n FROM providers')!.n).toBe(1);
    copy.close();
    expect(h.audit.list({ action: 'BACKUP_CREATED' })[0]!.metadata).toMatchObject({ label: 'manual', keyIncluded: false });

    const withKey = await createBackup(h.db, { dir, box: h.secrets, version: '1.2.3', includeSecretKey: 'the-key-text', now: new Date('2026-11-14T15:30:00Z') });
    expect(withKey.path).not.toBe(path); // same second: a new name
    expect(readFileSync(join(withKey.path, 'secret.key'), 'utf8')).toBe('the-key-text\n');
    expect(statSync(join(withKey.path, 'secret.key')).mode & 0o777).toBe(0o600);
    expect(withKey.manifest.secretKey.included).toBe(true);
  });

  test('checks catch damage, backups from a newer version, and the wrong key', async () => {
    const h = await world();
    const dir = fresh();
    const { path } = await createBackup(h.db, { dir, box: h.secrets, version: 't' });
    expect(await checkBackup(path, h.secrets)).toMatchObject({ errors: [], unreadableSecrets: 0 });
    expect((await checkBackup(path, createSecretBox(parseSecretKey(generateSecretKey())))).unreadableSecrets).toBe(1);

    const manifestFile = join(path, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as BackupManifest;
    writeFileSync(manifestFile, JSON.stringify({ ...manifest, migrations: [...manifest.migrations, '9999_future'] }));
    expect((await checkBackup(path, h.secrets)).errors.join(' ')).toContain('newer ClawRouter');
    writeFileSync(manifestFile, JSON.stringify(manifest));
    appendFileSync(join(path, 'clawrouter.db'), 'x');
    expect((await checkBackup(path, h.secrets)).errors.join(' ')).toContain('checksum');
    await expect(checkBackup(dir, h.secrets)).rejects.toThrow('not a complete ClawRouter backup');
  });

  test('restore replaces the database, keeps the old one, and needs the right key (or --force)', async () => {
    const h = await world();
    const dir = fresh();
    const { path } = await createBackup(h.db, { dir, box: h.secrets, version: 't' });
    const dbPath = join(fresh(), 'clawrouter.db');
    const target = openSqlite({ path: dbPath });
    runMigrations(target, migrations);
    target.close();

    const otherKey = createSecretBox(parseSecretKey(generateSecretKey()));
    await expect(restoreBackup(path, { dbPath, box: otherKey })).rejects.toThrow('cannot be opened with the configured secret key');
    // A running server (its pid file) blocks a restore.
    writeFileSync(`${dbPath}.pid`, `${process.pid}\n`);
    await expect(restoreBackup(path, { dbPath, box: h.secrets })).rejects.toThrow('is running');
    rmSync(`${dbPath}.pid`);

    const { previous } = await restoreBackup(path, { dbPath, box: h.secrets, now: new Date('2026-11-14T16:00:00Z') });
    expect(previous).toBe(`${dbPath}.before-restore-20261114-160000`);
    expect(existsSync(previous!)).toBe(true);
    const restored = openSqlite({ path: dbPath });
    expect(restored.get<{ identifier: string }>('SELECT identifier FROM providers')!.identifier).toBe('openai');
    expect(restored.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'BACKUP_RESTORED'")!.n).toBe(1);
    restored.close();
    // --force restores with another key; its encrypted values are then unreadable.
    expect((await restoreBackup(path, { dbPath, box: otherKey, force: true })).previous).not.toBeNull();
  });

  test('old automatic backups are pruned per kind', async () => {
    const h = await world();
    const dir = fresh();
    for (const hour of [1, 2, 3]) await createBackup(h.db, { dir, box: h.secrets, version: 't', label: 'scheduled', now: new Date(`2026-11-14T0${hour}:00:00Z`) });
    await createBackup(h.db, { dir, box: h.secrets, version: 't', now: new Date('2026-11-14T00:00:00Z') });
    expect(pruneBackups(dir, 'scheduled', 2)).toEqual([join(dir, 'clawrouter-20261114-010000-scheduled')]);
    expect(listBackups(dir).map((b) => `${b.manifest?.label} ${b.manifest?.createdAt}`)).toEqual([
      'scheduled 2026-11-14T03:00:00.000Z', 'scheduled 2026-11-14T02:00:00.000Z', 'manual 2026-11-14T00:00:00.000Z',
    ]);
  });

  test('the server backs up an existing database before migrating it; manual mode refuses to start', async () => {
    const dir = fresh();
    const dbPath = join(dir, 'clawrouter.db');
    const old = openSqlite({ path: dbPath });
    runMigrations(old, migrations.slice(0, -1)); // a database from the previous version
    old.close();
    const env = { CLAWROUTER_ENV: 'test', CLAWROUTER_PORT: '0', CLAWROUTER_DATABASE_PATH: dbPath, CLAWROUTER_SETUP_TOKEN: 'x'.repeat(20), CLAWROUTER_SECRET_KEY: generateSecretKey() };

    await expect(startClawRouter({ config: loadConfig({ ...env, CLAWROUTER_MIGRATIONS: 'manual' }), log: silentLogger, version: 't', hasher: fastHasher })).rejects.toThrow('bun run migrate');

    const app = await startClawRouter({ config: loadConfig({ ...env, CLAWROUTER_BACKUP_BEFORE_MIGRATE: 'true' }), log: silentLogger, version: 't', hasher: fastHasher });
    expect(readFileSync(`${dbPath}.pid`, 'utf8').trim()).toBe(String(process.pid));
    await app.stop({ graceMs: 0 });
    expect(existsSync(`${dbPath}.pid`)).toBe(false);
    const backups = listBackups(join(dir, 'backups'));
    expect(backups).toHaveLength(1);
    expect(backups[0]!.manifest).toMatchObject({ label: 'pre-migrate', migrations: migrations.slice(0, -1).map((m) => m.id) });
  });
});
