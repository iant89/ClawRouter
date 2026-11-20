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

// SEC-021 (with SEC-003): backup files. A real backup with its manifest or database damaged:
// changed fields, broken JSON, flipped, cut and inserted bytes, and, for the database, the
// manifest resealed so the checksum matches (what a careful attacker does), so the damage
// reaches SQLite and the schema checks. Checking a backup always ends in a list of problems
// or a refusal with a message; restoring a damaged one is refused and leaves the database it
// would have replaced exactly as it was.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '@clawrouter/core';
import { migrations, openSqlite, runMigrations } from '@clawrouter/database';
import { checkBackup, createBackup, restoreBackup, type BackupManifest } from '../../../apps/server/src/backup.ts';
import type { Harness } from '../../support/harness.ts';
import { createHarness } from '../support.ts';
import { forAll, mutate, mutateText, type Rng } from './fuzz.ts';

const root = mkdtempSync(join(tmpdir(), 'clawrouter-fuzz-backup-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `case-${++n}`);
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

let h: Harness;
let original: string;
let manifest: BackupManifest;
let dbBytes: Uint8Array;
let manifestText: string;

beforeAll(async () => {
  h = createHarness();
  await h.completeSetup();
  await h.providers.create({ id: 'u', username: 'admin' }, { name: 'Public', identifier: 'public', kind: 'openai_compatible', endpoint: 'https://api.example.test/v1', apiKey: 'sk-backup-fuzz-0123456789' }, { ip: null });
  ({ path: original, manifest } = await createBackup(h.db, { dir: fresh(), box: h.secrets, version: 't' }));
  dbBytes = readFileSync(join(original, 'clawrouter.db'));
  manifestText = readFileSync(join(original, 'manifest.json'), 'utf8');
});

/** Damage to database bytes: flips, cuts, inserted junk, a zeroed or copied page, garbage where SQLite's header is. */
function damageBytes(r: Rng, bytes: Uint8Array): Uint8Array {
  let b: Uint8Array = Uint8Array.from(bytes);
  for (let t = 1 + r.int(4); t > 0; t--) {
    const at = r.bool(0.3) ? r.int(Math.min(200, b.length)) : r.int(b.length);
    switch (r.int(6)) {
      case 0: b[at] = r.int(256); break;
      case 1: b = b.slice(0, at); break;
      case 2: { const junk = Uint8Array.from({ length: 1 + r.int(64) }, () => r.int(256)); b = Uint8Array.from([...b.slice(0, at), ...junk, ...b.slice(at)]); break; }
      case 3: b.fill(0, at, at + 1 + r.int(4096)); break;
      case 4: b.copyWithin(at, r.int(b.length), r.int(b.length)); break;
      default: for (let i = 0; i < 16; i++) b[r.int(Math.min(100, b.length))] = r.int(256);
    }
  }
  return b;
}

interface Damage { manifest: string; db: Uint8Array | null; reseal: boolean }

function damage(r: Rng): Damage {
  const roll = r.int(10);
  if (roll < 3) return { manifest: JSON.stringify(mutate(r, manifest)), db: null, reseal: false };
  if (roll < 4) return { manifest: mutateText(r, manifestText), db: null, reseal: false };
  return { manifest: manifestText, db: damageBytes(r, dbBytes), reseal: roll < 9 };
}

/** A copy of the real backup with `d` applied. */
function damaged(d: Damage): string {
  const dir = fresh();
  cpSync(original, dir, { recursive: true });
  if (d.db) {
    writeFileSync(join(dir, 'clawrouter.db'), d.db);
    if (d.reseal) writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, database: { ...manifest.database, bytes: d.db.length, sha256: sha256(d.db) } }));
    else writeFileSync(join(dir, 'manifest.json'), d.manifest);
  } else writeFileSync(join(dir, 'manifest.json'), d.manifest);
  return dir;
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

const refusal = (error: unknown) => {
  if (error instanceof AppError && error.status < 500) return;
  throw new Error(`refused with ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)} instead of a clear message`, { cause: error });
};

describe('damaged backups', () => {
  test('a check lists the problems or refuses with a message', async () => {
    await forAll('backup check', 50, (r) => damage(r), async (d) => {
      const dir = damaged(d);
      let check: Awaited<ReturnType<typeof checkBackup>> | null = null;
      try {
        check = await checkBackup(dir, h.secrets, root);
      } catch (error) {
        refusal(error);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      if (!check) return;
      expect(Array.isArray(check.errors) && check.errors.every((e) => typeof e === 'string')).toBe(true);
      // Changed bytes without a resealed manifest never pass the checksum ("damage" can leave the bytes as they were).
      if (d.db && !d.reseal && sha256(d.db) !== manifest.database.sha256) expect(check.errors.length).toBeGreaterThan(0);
    });
  }, 120_000);

  test('a restore is refused, and the database it would replace is untouched', async () => {
    await forAll('backup restore', 30, (r) => ({ ...damage(r), db: damageBytes(r, dbBytes), reseal: r.bool(0.8) }), async (d) => {
      const dir = damaged(d);
      const dbPath = target();
      const before = sha256(readFileSync(dbPath));
      let restored = false;
      try {
        await restoreBackup(dir, { dbPath, box: h.secrets });
        restored = true;
      } catch (error) {
        refusal(error);
      }
      // Damage that leaves a database which passes every check (a byte in unused space) may be restored; anything else must not be.
      if (!restored) expect(sha256(readFileSync(dbPath))).toBe(before);
      else {
        const db = openSqlite({ path: dbPath });
        expect(db.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check).toBe('ok');
        db.close();
      }
      rmSync(dir, { recursive: true, force: true });
      rmSync(join(dbPath, '..'), { recursive: true, force: true });
    });
  }, 120_000);

  test('the undamaged backup still restores (or the fuzzing above proves little)', async () => {
    const dbPath = target();
    await restoreBackup(original, { dbPath, box: h.secrets });
  });
});
