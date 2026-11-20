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

// SEC-003: backup and restore treat a backup directory as untrusted input. Backups are
// made and restored from the command line only (there is no HTTP route for them), so
// the attacker here is whoever could write into a backup directory before a restore.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrations, openSqlite, runMigrations } from '@clawrouter/database';
import { checkBackup, createBackup, listBackups, pruneBackups, restoreBackup, type BackupManifest } from '../../apps/server/src/backup.ts';
import { createHarness } from '../support/harness.ts';

const root = mkdtempSync(join(tmpdir(), 'clawrouter-sec-backup-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `case-${++n}`);

async function backup() {
  const h = createHarness();
  await h.completeSetup();
  const { path, manifest } = await createBackup(h.db, { dir: fresh(), box: h.secrets, version: 't' });
  return { h, path, manifest };
}

/** An empty migrated database to restore over. */
function target(): string {
  const dir = fresh();
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'clawrouter.db');
  const db = openSqlite({ path: dbPath });
  runMigrations(db, migrations);
  db.close();
  return dbPath;
}

/** Rewrites the manifest so checksum and size match a modified database (what a careful attacker does). */
function reseal(path: string, manifest: BackupManifest) {
  const bytes = readFileSync(join(path, 'clawrouter.db'));
  const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  writeFileSync(join(path, 'manifest.json'), JSON.stringify({ ...manifest, database: { ...manifest.database, bytes: bytes.length, sha256 } }));
}

function tamper(path: string, manifest: BackupManifest, sql: string) {
  const db = openSqlite({ path: join(path, 'clawrouter.db') });
  db.exec(sql);
  db.close();
  rmSync(join(path, 'clawrouter.db-wal'), { force: true });
  rmSync(join(path, 'clawrouter.db-shm'), { force: true });
  reseal(path, manifest);
}

describe('backup files are never followed through symbolic links', () => {
  test('a database that is a link to another file is refused, and the target is never read into the database', async () => {
    const { h, path } = await backup();
    const outside = join(fresh());
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'shadow'), 'root:$6$secret-hash:19000:0:99999:7:::\n');
    rmSync(join(path, 'clawrouter.db'));
    symlinkSync(join(outside, 'shadow'), join(path, 'clawrouter.db'));
    expect((await checkBackup(path, h.secrets)).errors.join(' ')).toContain('symbolic link');
    const dbPath = target();
    await expect(restoreBackup(path, { dbPath, box: h.secrets })).rejects.toThrow('symbolic link');
    expect(readFileSync(dbPath).includes('secret-hash')).toBe(false);
  });

  test('a manifest that is a link, and a backup directory that is a link, are refused', async () => {
    const { h, path } = await backup();
    const copy = join(fresh());
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, 'manifest.json'), readFileSync(join(path, 'manifest.json')));
    rmSync(join(path, 'manifest.json'));
    symlinkSync(join(copy, 'manifest.json'), join(path, 'manifest.json'));
    await expect(checkBackup(path, h.secrets)).rejects.toThrow('symbolic link');

    const other = await backup();
    const link = join(root, `link-${++n}`);
    symlinkSync(other.path, link);
    await expect(checkBackup(link, other.h.secrets)).rejects.toThrow('symbolic link');
  });

  test('a database that is a directory is not a regular file', async () => {
    const { h, path } = await backup();
    rmSync(join(path, 'clawrouter.db'));
    mkdirSync(join(path, 'clawrouter.db'));
    expect((await checkBackup(path, h.secrets)).errors.join(' ')).toContain('not a regular file');
  });

  test('listing and pruning ignore linked directories, so pruning never deletes through a link', async () => {
    const { h, path } = await backup();
    const dir = join(path, '..');
    const victim = join(fresh());
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'keep-me'), 'x');
    writeFileSync(join(victim, 'manifest.json'), JSON.stringify({ label: 'manual' }));
    symlinkSync(victim, join(dir, 'clawrouter-20000101-000000'));
    expect(listBackups(dir).map((b) => b.path)).toEqual([path]);
    pruneBackups(dir, 'manual', 0);
    expect(readdirSync(victim).sort()).toEqual(['keep-me', 'manifest.json']);
    expect(h).toBeDefined();
  });
});

describe('a crafted database is refused even with a matching checksum', () => {
  test.each([
    ['an extra trigger', "CREATE TRIGGER evil AFTER INSERT ON audit_log BEGIN UPDATE users SET password_hash = 'attacker'; END"],
    ['an extra table', 'CREATE TABLE stash (x TEXT)'],
    ['an extra view', 'CREATE VIEW leak AS SELECT * FROM users'],
    ['a changed table', 'ALTER TABLE users ADD COLUMN backdoor TEXT'],
    ['a dropped index', 'DROP INDEX IF EXISTS ' + 'idx_audit_log_created_at'],
  ])('%s', async (what, sql) => {
    const { h, path, manifest } = await backup();
    if (what === 'a dropped index') {
      const db = openSqlite({ path: join(path, 'clawrouter.db'), readonly: true });
      const index = db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' LIMIT 1")!.name;
      db.close();
      tamper(path, manifest, `DROP INDEX ${index}`);
    } else tamper(path, manifest, sql);
    const errors = (await checkBackup(path, h.secrets)).errors.join(' ');
    expect(errors).toContain('does not have the schema ClawRouter creates');
    const dbPath = target();
    await expect(restoreBackup(path, { dbPath, box: h.secrets })).rejects.toThrow('schema');
  });

  test('a database whose migrations differ from its manifest is refused', async () => {
    const { h, path, manifest } = await backup();
    tamper(path, manifest, "DELETE FROM schema_migrations WHERE id = (SELECT MAX(id) FROM schema_migrations)");
    expect((await checkBackup(path, h.secrets)).errors.join(' ')).toContain('other migrations than its manifest');
  });

  test('a file that is not SQLite fails the integrity check, not with a crash', async () => {
    const { h, path, manifest } = await backup();
    writeFileSync(join(path, 'clawrouter.db'), Buffer.alloc(8192, 0x41));
    reseal(path, manifest);
    expect((await checkBackup(path, h.secrets)).errors.join(' ')).toContain('integrity check');
  });
});

describe('manifests are validated', () => {
  test.each([
    ['not JSON', '{'],
    ['the wrong format', JSON.stringify({ format: 'other' })],
    ['migrations that are not a list', JSON.stringify({ format: 'clawrouter-backup', formatVersion: 1, migrations: 'all' })],
    ['a checksum that is not hex', JSON.stringify({ format: 'clawrouter-backup', formatVersion: 1, database: { file: 'clawrouter.db', bytes: 1, sha256: '../../x' } })],
    ['another database file name', JSON.stringify({ format: 'clawrouter-backup', formatVersion: 1, database: { file: '../../etc/passwd', bytes: 1, sha256: 'a'.repeat(64) } })],
  ])('%s is refused with a clear error', async (_what, text) => {
    const { h, path } = await backup();
    writeFileSync(join(path, 'manifest.json'), text);
    const error = await checkBackup(path, h.secrets).catch((e) => e);
    expect(error.code).toBe('VALIDATION_ERROR');
  });

  test('an oversized manifest is refused without being parsed', async () => {
    const { h, path } = await backup();
    writeFileSync(join(path, 'manifest.json'), `{"format":"clawrouter-backup","pad":"${'x'.repeat(2 * 1024 * 1024)}"}`);
    await expect(checkBackup(path, h.secrets)).rejects.toThrow('too large');
  });
});

describe('restore installs exactly what was checked', () => {
  test('the restored database has the manifest checksum, mode 0600, and no staging files are left', async () => {
    const { h, path, manifest } = await backup();
    const dbPath = target();
    await restoreBackup(path, { dbPath, box: h.secrets });
    const dir = join(dbPath, '..');
    expect(readdirSync(dir).filter((f) => f.startsWith('.clawrouter-restore'))).toEqual([]);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    // The restore wrote an audit record afterwards, so compare the schema ledger instead of the bytes.
    const db = openSqlite({ path: dbPath, readonly: true });
    expect(db.all<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id').map((r) => r.id)).toEqual(manifest.migrations);
    db.close();
  });

  test('a failed check leaves the current database alone and cleans up', async () => {
    const { h, path, manifest } = await backup();
    tamper(path, manifest, 'CREATE TABLE stash (x TEXT)');
    const dbPath = target();
    const before = readFileSync(dbPath);
    await expect(restoreBackup(path, { dbPath, box: h.secrets })).rejects.toThrow();
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(readdirSync(join(dbPath, '..')).filter((f) => f.startsWith('.clawrouter-restore'))).toEqual([]);
  });
});

describe('backup creation', () => {
  test('backups are private: directory 0700, files 0600', async () => {
    const h = createHarness();
    await h.completeSetup();
    const dir = fresh();
    const { path } = await createBackup(h.db, { dir, box: h.secrets, version: 't', includeSecretKey: 'k'.repeat(44), confirmSecretKey: true });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'credentials')).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(path)) expect(statSync(join(path, f)).mode & 0o777).toBe(0o600);
  });

  test.each(['../../etc', 'a/b', 'UPPER', '', '-x'])('label %p cannot become part of a path', async (label) => {
    const h = createHarness();
    await expect(createBackup(h.db, { dir: fresh(), box: h.secrets, version: 't', label })).rejects.toThrow('Invalid backup label');
  });
});
