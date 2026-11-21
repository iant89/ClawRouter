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

// SEC-027 corpus: hostile backups.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrations, openSqlite, runMigrations } from '@clawrouter/database';
import { checkBackup, createBackup, restoreBackup, type BackupManifest } from '../../../apps/server/src/backup.ts';
import { createHarness } from '../support.ts';

const root = mkdtempSync(join(tmpdir(), 'clawrouter-case-backup-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `c${++n}`);

async function backup() {
  const h = createHarness();
  await h.completeSetup();
  const { path, manifest } = await createBackup(h.db, { dir: fresh(), box: h.secrets, version: 't' });
  return { h, path, manifest };
}
function target() {
  const dir = fresh();
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'clawrouter.db');
  const db = openSqlite({ path: dbPath });
  runMigrations(db, migrations);
  db.close();
  return dbPath;
}

describe('backup and restore attacks', () => {
  test('CASE-030: a database that is a symbolic link is refused, and its target never read', async () => {
    const { h, path } = await backup();
    const outside = fresh();
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'shadow'), 'root:$6$case-secret-hash:19000:0:99999:7:::\n');
    rmSync(join(path, 'clawrouter.db'));
    symlinkSync(join(outside, 'shadow'), join(path, 'clawrouter.db'));
    const dbPath = target();
    await expect(restoreBackup(path, { dbPath, box: h.secrets })).rejects.toThrow('symbolic link');
    expect(readFileSync(dbPath).includes('case-secret-hash')).toBe(false);
  });

  test('CASE-031: a backup with an extra trigger and a resealed checksum is refused', async () => {
    const { h, path, manifest } = await backup();
    const db = openSqlite({ path: join(path, 'clawrouter.db') });
    db.exec("CREATE TRIGGER evil AFTER INSERT ON audit_log BEGIN UPDATE users SET password_hash = 'attacker'; END");
    db.close();
    for (const s of ['-wal', '-shm']) rmSync(join(path, `clawrouter.db${s}`), { force: true });
    const bytes = readFileSync(join(path, 'clawrouter.db'));
    const sealed: BackupManifest = { ...manifest, database: { ...manifest.database, bytes: bytes.length, sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex') } };
    writeFileSync(join(path, 'manifest.json'), JSON.stringify(sealed));
    expect((await checkBackup(path, h.secrets)).errors.join(' ')).toContain('schema');
    const dbPath = target();
    await expect(restoreBackup(path, { dbPath, box: h.secrets })).rejects.toThrow('schema');
    const restored = openSqlite({ path: dbPath, readonly: true });
    expect(restored.get("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'evil'")).toBeUndefined();
    restored.close();
  });
});
