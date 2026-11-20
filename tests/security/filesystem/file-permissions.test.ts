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

// SEC-023: ClawRouter's files hold the database (password hashes, encrypted credentials,
// request history), the secret key and the setup token. Other accounts on the machine
// must not read them, whatever umask ClawRouter was started with.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, generateSecretKey, loadConfig, PRIVATE_UMASK, restrictUmask, tightenMode, type LogRecord } from '@clawrouter/core';
import { migrations, openSqlite, runMigrations } from '@clawrouter/database';
import { applyRepairs, plannedRepairs, runDoctor } from '../../../apps/server/src/doctor.ts';
import { createBackup, restoreBackup } from '../../../apps/server/src/backup.ts';
import { loadSecretBox } from '../../../apps/server/src/secret-key.ts';
import { startClawRouter } from '../../../apps/server/src/server.ts';
import { fastHasher } from '../../support/harness.ts';

const repo = join(import.meta.dir, '..', '..', '..');
const root = mkdtempSync(join(tmpdir(), 'clawrouter-sec023-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `case-${++n}`);
const mode = (path: string) => statSync(path).mode & 0o777;

// The tests run with a wide umask, as a server started from a default shell would be.
let previous = 0;
beforeEach(() => {
  previous = process.umask(0o022);
});
afterEach(() => {
  process.umask(previous);
});

async function start(dir: string, records: LogRecord[] = []) {
  const config = loadConfig({ CLAWROUTER_ENV: 'test', CLAWROUTER_PORT: '0', CLAWROUTER_DATABASE_PATH: join(dir, 'clawrouter.db') });
  const log = createLogger({ level: 'debug', sink: (r) => records.push(r) });
  return { app: await startClawRouter({ config, log, version: 'test', hasher: fastHasher }), config };
}

describe('files ClawRouter creates are private (SEC-023)', () => {
  test('a first start: data directory 0700; database, -wal, -shm, process-ID file, setup token and secret key 0600', async () => {
    const dir = join(fresh(), 'data');
    const { app } = await start(dir);
    try {
      expect(mode(dir)).toBe(0o700);
      const files = readdirSync(dir).sort();
      expect(files).toEqual(['clawrouter.db', 'clawrouter.db-shm', 'clawrouter.db-wal', 'clawrouter.db.pid', 'secret.key', 'setup-token']);
      for (const f of files) expect([f, mode(join(dir, f))]).toEqual([f, 0o600]);
    } finally {
      await app.stop();
    }
  });

  test('a database and generated key left readable by an older version are made private at start, and it is logged', async () => {
    const dir = fresh();
    mkdirSync(dir, { mode: 0o700 });
    const dbPath = join(dir, 'clawrouter.db');
    const db = openSqlite({ path: dbPath });
    runMigrations(db, migrations);
    db.close();
    chmodSync(dbPath, 0o644);
    writeFileSync(join(dir, 'secret.key'), `${generateSecretKey()}\n`);
    chmodSync(join(dir, 'secret.key'), 0o644);

    const records: LogRecord[] = [];
    const { app } = await start(dir, records);
    try {
      expect(mode(dbPath)).toBe(0o600);
      expect(mode(join(dir, 'secret.key'))).toBe(0o600);
      for (const ext of ['-wal', '-shm']) expect(mode(dbPath + ext)).toBe(0o600);
      expect(records.some((r) => r.msg.includes('database files were readable by other accounts'))).toBe(true);
      expect(records.some((r) => r.msg.includes('secret key file was readable by other accounts'))).toBe(true);
    } finally {
      await app.stop();
    }
  });

  test("an operator's own directory is not changed, only reported", async () => {
    const dir = fresh();
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const { app, config } = await start(dir);
    try {
      expect(mode(dir)).toBe(0o755);
      expect(mode(join(dir, 'clawrouter.db'))).toBe(0o600);
      const files = (await runDoctor(config, loadSecretBox(config, createLogger({ level: 'fatal' })), null)).filter((c) => c.area === 'files');
      expect(files[0]).toMatchObject({ level: 'warn', message: expect.stringContaining(`${dir} (data directory, 0755: its group and other users can read/enter it)`), repair: { id: 'file-permissions' } });
    } finally {
      await app.stop();
    }
  });

  test('backups: directories 0700, files 0600, the backup directory itself included', async () => {
    const dir = fresh();
    const db = openSqlite({ path: join(dir, 'clawrouter.db') });
    runMigrations(db, migrations);
    const box = loadSecretBox(loadConfig({ CLAWROUTER_ENV: 'test', CLAWROUTER_DATABASE_PATH: join(dir, 'clawrouter.db') }), createLogger({ level: 'fatal' }));
    const backups = join(dir, 'backups');
    try {
      const normal = await createBackup(db, { dir: backups, box, version: 't' });
      const credentials = await createBackup(db, { dir: backups, box, version: 't', includeSecretKey: generateSecretKey(), confirmSecretKey: true });
      expect(mode(backups)).toBe(0o700);
      for (const b of [normal.path, credentials.path]) {
        expect(mode(b)).toBe(0o700);
        for (const f of readdirSync(b)) expect([f, mode(join(b, f))]).toEqual([f, 0o600]);
      }
    } finally {
      db.close();
    }
  });

  test('a restored database is 0600', async () => {
    const dir = fresh();
    const dbPath = join(dir, 'clawrouter.db');
    const db = openSqlite({ path: dbPath });
    runMigrations(db, migrations);
    const box = loadSecretBox(loadConfig({ CLAWROUTER_ENV: 'test', CLAWROUTER_DATABASE_PATH: dbPath }), createLogger({ level: 'fatal' }));
    const { path } = await createBackup(db, { dir: join(dir, 'backups'), box, version: 't' });
    db.close();
    chmodSync(dbPath, 0o644);
    await restoreBackup(path, { dbPath, box });
    expect(mode(dbPath)).toBe(0o600);
  });
});

describe('doctor reports and repairs open permissions (SEC-023)', () => {
  test('finds every kind of file, and --fix makes them private without following links', async () => {
    const dir = fresh();
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const dbPath = join(dir, 'clawrouter.db');
    const db = openSqlite({ path: dbPath });
    runMigrations(db, migrations);
    db.close();
    const config = loadConfig({ CLAWROUTER_ENV: 'test', CLAWROUTER_DATABASE_PATH: dbPath });
    const box = loadSecretBox(config, createLogger({ level: 'fatal' }));
    const backupDb = openSqlite({ path: dbPath });
    const { path: backup } = await createBackup(backupDb, { dir: config.database.backupDir, box, version: 't' });
    backupDb.close();
    writeFileSync(join(dir, 'setup-token'), 'x\n');
    // Reading the database in WAL mode leaves its -wal file behind, with the database's mode.
    await runDoctor(config, box, null);
    const wide = [dir, dbPath, `${dbPath}-wal`, `${dbPath}-shm`, join(dir, 'secret.key'), join(dir, 'setup-token'), config.database.backupDir, backup, join(backup, 'clawrouter.db'), join(backup, 'manifest.json')];
    for (const p of wide) chmodSync(p, existsSync(p) && statSync(p).isDirectory() ? 0o755 : 0o644);
    // A link in the data directory to someone else's file: never followed, never changed.
    const outside = join(fresh() + '-outside');
    writeFileSync(outside, 'not ours');
    chmodSync(outside, 0o644);
    symlinkSync(outside, `${dbPath}.pid`);

    const before = await runDoctor(config, box, null);
    const check = before.find((c) => c.repair?.id === 'file-permissions')!;
    expect(check.message).toStartWith(`${wide.length} of ClawRouter's files`);
    for (const what of ['data directory', 'database', 'secret key', 'setup token', 'backup directory', 'backup']) expect(check.message).toContain(`(${what}, 0`);
    expect(check.message).not.toContain(outside);

    const results = await applyRepairs(config, box, plannedRepairs(before).filter((r) => r.id === 'file-permissions'), { version: 't' });
    expect(results).toEqual([{ id: 'file-permissions', ok: true, message: `Made ${wide.length} file(s) and directory(ies) private to their owner.` }]);
    // (The repair's audit record closes the database, which removes -wal and -shm.)
    for (const p of wide.filter((p) => existsSync(p))) expect([p, mode(p)]).toEqual([p, statSync(p).isDirectory() ? 0o700 : 0o600]);
    expect(mode(outside)).toBe(0o644);
    const after = await runDoctor(config, box, null);
    expect(after.find((c) => c.area === 'files')).toMatchObject({ level: 'ok' });
  });

  test('a TLS private key may be read by its group (0640), not by other users', async () => {
    const dir = fresh();
    mkdirSync(dir, { mode: 0o700 });
    const cert = join(dir, 'cert.pem');
    const key = join(dir, 'key.pem');
    writeFileSync(cert, 'x');
    writeFileSync(key, 'x');
    const config = loadConfig({ CLAWROUTER_ENV: 'test', CLAWROUTER_DATABASE_PATH: join(dir, 'clawrouter.db'), CLAWROUTER_TLS_CERT_FILE: cert, CLAWROUTER_TLS_KEY_FILE: key });
    chmodSync(key, 0o640);
    expect((await runDoctor(config, null, 'none yet')).filter((c) => c.area === 'files' && c.level === 'warn')).toEqual([]);
    chmodSync(key, 0o644);
    const before = await runDoctor(config, null, 'none yet');
    expect(before.find((c) => c.area === 'files')!.message).toContain(`${key} (TLS private key, 0644: other users can read it)`);
    await applyRepairs(config, null, plannedRepairs(before).filter((r) => r.id === 'file-permissions'), { version: 't' });
    expect(mode(key)).toBe(0o640);
  });

  test('tightenMode keeps the owner bits and never follows a link', () => {
    const dir = fresh();
    mkdirSync(dir);
    const file = join(dir, 'f');
    writeFileSync(file, '');
    chmodSync(file, 0o755);
    expect(tightenMode(file)).toBe(true);
    expect(mode(file)).toBe(0o700);
    expect(tightenMode(file)).toBe(false);
    const target = join(dir, 'target');
    writeFileSync(target, '');
    chmodSync(target, 0o666);
    symlinkSync(target, join(dir, 'link'));
    expect(tightenMode(join(dir, 'link'))).toBe(false);
    expect(mode(target)).toBe(0o666);
  });
});

describe('the umask (SEC-023)', () => {
  test('restrictUmask sets 0077', () => {
    restrictUmask();
    expect(process.umask()).toBe(PRIVATE_UMASK);
  });

  test('the server and every command-line tool that writes files restrict the umask first', () => {
    const entries = ['apps/server/src/main.ts', ...['backup', 'clear-credentials', 'doctor', 'migrate', 'reset-password', 'restore', 'rotate-secret-key'].map((s) => `scripts/${s}.ts`)];
    for (const e of entries) expect([e, /^restrictUmask\(\);$/m.test(readFileSync(join(repo, e), 'utf8'))]).toEqual([e, true]);
    // Every tool the production build ships (build:cli) is in that list.
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const shipped = pkg.scripts['build:cli']!.match(/scripts\/[a-z-]+\.ts/g)!;
    for (const s of shipped) expect(entries).toContain(s);
  });
});
