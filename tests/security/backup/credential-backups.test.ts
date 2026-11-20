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

// SEC-011: normal backups (database: configuration and operational data, credentials only
// encrypted) are kept apart from credential backups (the same plus the secret key). The key
// goes in only with explicit confirmation, behind a warning, into a private directory that
// normal listings, pruning and doctor never look at.

import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '@clawrouter/database';
import {
  checkBackup, createBackup, credentialBackupDir, holdsSecretKey, listBackups, listCredentialBackups, pruneBackups, restoreBackup,
} from '../../apps/server/src/backup.ts';
import { createHarness } from '../support/harness.ts';

const root = mkdtempSync(join(tmpdir(), 'clawrouter-sec-credentials-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `case-${++n}`);
const KEY_TEXT = 'Zm9yLXRlc3RzLW9ubHktbm90LWEtcmVhbC1rZXktMDAwMDA=';

async function world() {
  const h = createHarness();
  await h.completeSetup();
  await h.providers.create({ id: 'u', username: 'admin' }, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: 'https://api.example.test/v1', apiKey: 'sk-credential-canary-0123456789' }, { ip: null });
  return h;
}

describe('normal backups (SEC-011)', () => {
  test('hold the database (configuration and operational data) and no key; stored credentials only encrypted', async () => {
    const h = await world();
    const dir = fresh();
    const { path, manifest } = await createBackup(h.db, { dir, box: h.secrets, version: 't' });
    expect(readdirSync(path).sort()).toEqual(['clawrouter.db', 'manifest.json']);
    expect(manifest.kind).toBe('normal');
    expect(manifest.secretKey.included).toBe(false);
    // The configuration and operational data are in the copy...
    const copy = openSqlite({ path: join(path, 'clawrouter.db'), readonly: true });
    expect(copy.get<{ n: number }>('SELECT COUNT(*) AS n FROM providers')!.n).toBe(1);
    expect(copy.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n).toBe(1);
    copy.close();
    // ...but no credential in readable form, and nothing of the key.
    const bytes = readFileSync(join(path, 'clawrouter.db')).toString('latin1');
    expect(bytes).not.toContain('sk-credential-canary-0123456789');
    expect(readFileSync(join(path, 'manifest.json'), 'utf8')).not.toContain(KEY_TEXT);
    expect(existsSync(credentialBackupDir(dir))).toBe(false);
  });
});

describe('credential backups (SEC-011)', () => {
  test('need explicit confirmation: without it nothing is written', async () => {
    const h = await world();
    const dir = fresh();
    await expect(createBackup(h.db, { dir, box: h.secrets, version: 't', includeSecretKey: KEY_TEXT })).rejects.toThrow('explicit confirmation');
    await expect(createBackup(h.db, { dir, box: h.secrets, version: 't', includeSecretKey: KEY_TEXT, confirmSecretKey: false })).rejects.toThrow('explicit confirmation');
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    expect(h.audit.list({ action: 'CREDENTIAL_BACKUP_CREATED' })).toEqual([]);
  });

  test('go into credentials/ with restrictive permissions, audited apart', async () => {
    const h = await world();
    const dir = fresh();
    const { path, manifest } = await createBackup(h.db, { dir, box: h.secrets, version: 't', includeSecretKey: KEY_TEXT, confirmSecretKey: true, now: new Date('2026-11-20T10:00:00Z') });
    expect(path).toBe(join(dir, 'credentials', 'clawrouter-20261120-100000-credentials'));
    expect(manifest).toMatchObject({ kind: 'credentials', label: 'credentials', secretKey: { included: true } });
    expect(statSync(credentialBackupDir(dir)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(path)) expect(statSync(join(path, f)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(path, 'secret.key'), 'utf8').trim()).toBe(KEY_TEXT);
    const audit = h.audit.list({ action: 'CREDENTIAL_BACKUP_CREATED' });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(KEY_TEXT);
    expect(h.audit.list({ action: 'BACKUP_CREATED' })).toEqual([]);
  });

  test('a credentials directory left with a wide mode is tightened before the key is written', async () => {
    const h = await world();
    const dir = fresh();
    mkdirSync(credentialBackupDir(dir), { recursive: true });
    chmodSync(credentialBackupDir(dir), 0o755);
    await createBackup(h.db, { dir, box: h.secrets, version: 't', includeSecretKey: KEY_TEXT, confirmSecretKey: true });
    expect(statSync(credentialBackupDir(dir)).mode & 0o777).toBe(0o700);
  });

  test('normal listings never show them; their own listing shows no key', async () => {
    const h = await world();
    const dir = fresh();
    await createBackup(h.db, { dir, box: h.secrets, version: 't' });
    await createBackup(h.db, { dir, box: h.secrets, version: 't', includeSecretKey: KEY_TEXT, confirmSecretKey: true });
    const normal = listBackups(dir);
    expect(normal).toHaveLength(1);
    expect(normal.some((b) => holdsSecretKey(b.manifest))).toBe(false);
    const credentials = listCredentialBackups(dir);
    expect(credentials).toHaveLength(1);
    expect(holdsSecretKey(credentials[0]!.manifest)).toBe(true);
    expect(JSON.stringify([normal, credentials])).not.toContain(KEY_TEXT);
  });

  test('pruning never removes a backup with the key, even one made before they were kept apart', async () => {
    const h = await world();
    const dir = fresh();
    await createBackup(h.db, { dir, box: h.secrets, version: 't', includeSecretKey: KEY_TEXT, confirmSecretKey: true, label: 'manual', now: new Date('2026-11-01T00:00:00Z') });
    // An older-style backup with the key beside the normal ones.
    const legacy = await createBackup(h.db, { dir, box: h.secrets, version: 't', now: new Date('2026-11-02T00:00:00Z') });
    writeFileSync(join(legacy.path, 'secret.key'), `${KEY_TEXT}\n`, { mode: 0o600 });
    const manifest = JSON.parse(readFileSync(join(legacy.path, 'manifest.json'), 'utf8'));
    delete manifest.kind;
    manifest.secretKey.included = true;
    writeFileSync(join(legacy.path, 'manifest.json'), JSON.stringify(manifest));
    for (let d = 3; d <= 5; d++) await createBackup(h.db, { dir, box: h.secrets, version: 't', now: new Date(`2026-11-0${d}T00:00:00Z`) });
    const removed = pruneBackups(dir, 'manual', 1);
    expect(removed).toHaveLength(2); // the 3rd and 4th; the legacy one with the key stays
    expect(existsSync(legacy.path)).toBe(true);
    expect(listCredentialBackups(dir)).toHaveLength(1);
    expect(holdsSecretKey(listBackups(dir).find((b) => b.path === legacy.path)!.manifest)).toBe(true);
  });

  test('a credential backup restores like any other', async () => {
    const h = await world();
    const dir = fresh();
    const { path } = await createBackup(h.db, { dir, box: h.secrets, version: 't', includeSecretKey: KEY_TEXT, confirmSecretKey: true });
    expect((await checkBackup(path, h.secrets)).errors).toEqual([]);
    const dbPath = join(fresh(), 'clawrouter.db');
    await restoreBackup(path, { dbPath, box: h.secrets });
    expect(existsSync(dbPath)).toBe(true);
  });

  test('the command line refuses a credential backup without confirmation', async () => {
    const dir = fresh();
    const proc = Bun.spawn(['bun', 'scripts/backup.ts', '--include-secret-key', '--dir', dir], {
      cwd: join(import.meta.dir, '..', '..'), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'development', CLAWROUTER_DATABASE_PATH: join(dir, 'none.db') },
    });
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(code).toBe(1);
    expect(err).toContain('WARNING: a credential backup contains the secret key');
    expect(err).toContain('--yes');
    expect(existsSync(credentialBackupDir(dir))).toBe(false);
  });
});
