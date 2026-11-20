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

import {
  chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync,
  statfsSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createAuditService, createSqliteAuditRepository } from '@clawrouter/audit';
import { AppError, checkSealedSecrets, type Logger, type SecretBox } from '@clawrouter/core';
import { migrations, openSqlite, runMigrations, type Database } from '@clawrouter/database';
import { sealedSecretStores } from './secret-stores.ts';

/**
 * Backups (phase 17). A backup is a directory:
 *
 *   clawrouter-20261114-153000[-label]/
 *     clawrouter.db     consistent copy (VACUUM INTO), taken while the server runs
 *     manifest.json     written last: checksum, schema version, key fingerprint
 *
 * A **normal backup** holds the database, which is the whole configuration
 * (providers, models, routing, limits, roles, settings) and the operational data
 * (users, keys as hashes, audit, usage). Stored credentials are in it only
 * encrypted, and the secret key is NOT in it: whoever holds database and key can
 * read every provider API key. Store the key separately (see docs/deployment.md);
 * the manifest records its fingerprint so a restore can tell whether the right
 * key is configured.
 *
 * A **credential backup** (SEC-011) adds `secret.key`, so the backup alone opens
 * every stored credential. It needs explicit confirmation (`confirmSecretKey`),
 * and it is written apart, under `<dir>/credentials/` (0700, re-applied on every
 * write), named `…-credentials`: normal listings, pruning and `doctor`'s backup
 * counts never see it, and it is never deleted automatically.
 */
export interface BackupManifest {
  format: 'clawrouter-backup';
  formatVersion: 1;
  createdAt: string;
  clawrouterVersion: string;
  /** Why it was made: "manual", "scheduled", "pre-migrate". */
  label: string;
  database: { file: 'clawrouter.db'; bytes: number; sha256: string };
  /** Migrations applied in the copy: a restore refuses a backup from a newer version. */
  migrations: string[];
  secretKey: { fingerprint: string; included: boolean };
  /** "credentials" when the secret key is in the backup (missing in backups made before SEC-011: read `secretKey.included`). */
  kind?: 'normal' | 'credentials';
  /** Values in the copy that are encrypted with that key. */
  encryptedValues: number;
}

const DB_FILE = 'clawrouter.db';
const MANIFEST = 'manifest.json';
const KEY_FILE = 'secret.key';
const NAME = /^clawrouter-\d{8}-\d{6}(-[a-z0-9-]+)?$/;
/** Credential backups live in this subdirectory of the backup directory, never beside normal ones. */
export const CREDENTIALS_DIR = 'credentials';

/** Where the credential backups of a backup directory are kept. */
export const credentialBackupDir = (dir: string) => join(dir, CREDENTIALS_DIR);

/** A directory that must stay private: created 0700, and tightened to 0700 if it already existed with a wider mode. */
function privateDir(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new AppError('VALIDATION_ERROR', `${path} is not a directory (a symbolic link?); refusing to write a backup there.`);
  if ((st.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

const sha256File = (path: string) => new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** Integrity check and applied migrations of a database file, opened read-only. */
function inspect(path: string): { ok: boolean; migrations: string[] } {
  const copy = openSqlite({ path, readonly: true });
  try {
    const check = copy.all<{ integrity_check: string }>('PRAGMA integrity_check').map((r) => r.integrity_check);
    const applied = copy.all<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id').map((r) => r.id);
    return { ok: check.length === 1 && check[0] === 'ok', migrations: applied };
  } finally {
    copy.close();
  }
}

export interface CreateBackupOptions {
  /** Parent directory; created (mode 0700) if missing. */
  dir: string;
  box: SecretBox;
  version: string;
  label?: string;
  /** The key text to copy into the backup: makes it a credential backup (opt-in). */
  includeSecretKey?: string | null;
  /** Must be true with `includeSecretKey`: the operator confirmed that the backup will contain the key. */
  confirmSecretKey?: boolean;
  now?: Date;
  log?: Logger;
}

/** Copies the live database into a new backup directory and verifies the copy. */
export async function createBackup(db: Database, o: CreateBackupOptions): Promise<{ path: string; manifest: BackupManifest }> {
  const now = o.now ?? new Date();
  const credentials = !!o.includeSecretKey;
  const label = o.label ?? (credentials ? 'credentials' : 'manual');
  // The label becomes part of a path: only the internal ones, never anything with a separator.
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(label)) throw new AppError('VALIDATION_ERROR', `Invalid backup label "${label}".`);
  if (credentials && o.confirmSecretKey !== true) {
    throw new AppError('VALIDATION_ERROR', 'A backup with the secret key needs explicit confirmation: it opens every stored credential on its own.');
  }
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  const parent = credentials ? credentialBackupDir(o.dir) : o.dir;
  if (credentials) privateDir(parent);
  const suffix = credentials ? (label === 'credentials' ? '-credentials' : `-${label}-credentials`) : label === 'manual' ? '' : `-${label}`;
  let path = join(parent, `clawrouter-${stamp(now)}${suffix}`);
  for (let n = 2; existsSync(path); n++) path = join(parent, `clawrouter-${stamp(now)}${suffix}-${n}`);
  mkdirSync(path, { mode: 0o700 });
  const file = join(path, DB_FILE);
  try {
    // A transactionally consistent copy while other connections keep writing (WAL).
    db.run('VACUUM INTO ?', [file]);
    chmodSync(file, 0o600);
    const { ok, migrations: applied } = inspect(file);
    if (!ok) throw new AppError('INTERNAL_ERROR', 'The backup copy failed its integrity check.');
    const encryptedValues = (await checkSealedSecrets(sealedSecretStores(db), o.box)).length;
    if (o.includeSecretKey) writeFileSync(join(path, KEY_FILE), `${o.includeSecretKey.trim()}\n`, { mode: 0o600 });
    const manifest: BackupManifest = {
      format: 'clawrouter-backup', formatVersion: 1, createdAt: now.toISOString(), clawrouterVersion: o.version, label,
      database: { file: DB_FILE, bytes: statSync(file).size, sha256: sha256File(file) },
      migrations: applied, secretKey: { fingerprint: o.box.fingerprint, included: credentials }, kind: credentials ? 'credentials' : 'normal', encryptedValues,
    };
    // Written last: a directory without a manifest is an incomplete backup.
    writeFileSync(join(path, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    createAuditService(createSqliteAuditRepository(db), o.log).record({
      action: credentials ? 'CREDENTIAL_BACKUP_CREATED' : 'BACKUP_CREATED', result: 'SUCCESS', resource: 'system', resourceId: basename(path),
      actor: { id: null, name: label === 'manual' ? 'command line' : 'system' }, ip: null, requestId: null,
      metadata: { label, bytes: manifest.database.bytes, keyIncluded: manifest.secretKey.included },
    });
    o.log?.info('backup created', { component: 'backup', path, bytes: manifest.database.bytes, label });
    return { path, manifest };
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
}

export interface BackupInfo {
  path: string;
  manifest: BackupManifest | null;
}

/** True when a backup holds the secret key (a credential backup, or one made with the key before SEC-011). */
export const holdsSecretKey = (m: BackupManifest | null) => !!m && (m.kind === 'credentials' || m.secretKey.included);

/**
 * Normal backups in `dir`, newest first. Directories without a manifest are
 * incomplete. Credential backups are in `credentials/` and not listed here
 * (`listCredentialBackups`); one made with the key before they were separated
 * still shows up, and `holdsSecretKey` tells.
 */
export function listBackups(dir: string): BackupInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    // Only real directories with the backup naming: a symbolic link here is never followed or removed through.
    .filter((name) => NAME.test(name) && lstatSync(join(dir, name)).isDirectory())
    .sort()
    .reverse()
    .map((name) => {
      const path = join(dir, name);
      try {
        return { path, manifest: JSON.parse(readFileSync(join(path, MANIFEST), 'utf8')) as BackupManifest };
      } catch {
        return { path, manifest: null };
      }
    });
}

/** Credential backups (with the secret key) of a backup directory, newest first. Never pruned automatically. */
export function listCredentialBackups(dir: string): BackupInfo[] {
  const sub = credentialBackupDir(dir);
  if (!existsSync(sub) || !lstatSync(sub).isDirectory()) return [];
  return listBackups(sub);
}

/** Keeps the newest `keep` complete backups with this label; removes older ones. Returns the removed paths. */
export function pruneBackups(dir: string, label: string, keep: number): string[] {
  // Backups with the secret key are never removed automatically (SEC-011).
  const mine = listBackups(dir).filter((b) => b.manifest?.label === label && !holdsSecretKey(b.manifest));
  const removed = mine.slice(keep).map((b) => b.path);
  for (const path of removed) rmSync(path, { recursive: true, force: true });
  return removed;
}

export interface RestoreCheck {
  manifest: BackupManifest;
  /** Problems that stop a restore. */
  errors: string[];
  /** Encrypted values the configured key cannot open (a force restore loses them). */
  unreadableSecrets: number;
}

/** A manifest is read from a directory that may not be ours: it is capped and its shape checked. */
const MANIFEST_MAX_BYTES = 1024 * 1024;

function parseManifest(text: string, dir: string): BackupManifest {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    throw new AppError('VALIDATION_ERROR', `${dir} is not a complete ClawRouter backup (${MANIFEST} is not valid JSON).`);
  }
  const o = m as Partial<BackupManifest> | null;
  if (!o || typeof o !== 'object' || o.format !== 'clawrouter-backup') throw new AppError('VALIDATION_ERROR', `${dir} is not a ClawRouter backup.`);
  const valid = o.formatVersion === 1 && typeof o.createdAt === 'string' && typeof o.label === 'string' && typeof o.clawrouterVersion === 'string'
    && !!o.database && o.database.file === DB_FILE && Number.isSafeInteger(o.database.bytes) && o.database.bytes >= 0
    && typeof o.database.sha256 === 'string' && /^[0-9a-f]{64}$/.test(o.database.sha256)
    && Array.isArray(o.migrations) && o.migrations.every((id) => typeof id === 'string')
    && !!o.secretKey && typeof o.secretKey.fingerprint === 'string' && typeof o.secretKey.included === 'boolean'
    && (o.kind === undefined || o.kind === 'normal' || o.kind === 'credentials')
    && Number.isSafeInteger(o.encryptedValues);
  if (!valid) throw new AppError('VALIDATION_ERROR', `${dir} has a damaged ${MANIFEST}.`);
  return o as BackupManifest;
}

/**
 * Opens a file inside a backup without following symbolic links, and only if it
 * is a regular file: a backup directory is not trusted (SEC-003), so
 * "clawrouter.db -> /etc/shadow" must not be read.
 */
function openRegular(path: string): { fd: number; size: number } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ELOOP' || code === 'EMLINK') throw new AppError('VALIDATION_ERROR', `${basename(path)} in the backup is a symbolic link; refusing to follow it.`);
    if (code === 'ENOENT') throw new AppError('VALIDATION_ERROR', `${basename(path)} is missing.`);
    throw new AppError('VALIDATION_ERROR', `${basename(path)} cannot be read (${code ?? 'error'}).`);
  }
  const stat = fstatSync(fd);
  if (!stat.isFile()) {
    closeSync(fd);
    throw new AppError('VALIDATION_ERROR', `${basename(path)} in the backup is not a regular file.`);
  }
  return { fd, size: stat.size };
}

/** Copies an open file to a new file (never overwriting), hashing exactly the bytes written. */
function copyAndHash(fd: number, target: string): string {
  const hash = new Bun.CryptoHasher('sha256');
  const out = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (let n = readSync(fd, chunk); n > 0; n = readSync(fd, chunk)) {
      const piece = chunk.subarray(0, n);
      hash.update(piece);
      writeSync(out, piece);
    }
    fsyncSync(out);
  } finally {
    closeSync(out);
  }
  return hash.digest('hex');
}

/** What ClawRouter's migrations create, as (type, name, sql) rows; SQLite's own objects left out. */
function schemaOf(db: Database): Map<string, string> {
  const rows = db.all<{ type: string; name: string; sql: string | null }>("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'");
  return new Map(rows.map((r) => [`${r.type} ${r.name}`, (r.sql ?? '').replace(/\s+/g, ' ').trim()]));
}

/**
 * A backup's schema must be exactly what this version's migrations create for the
 * migrations it records: a crafted database with an extra trigger or view (one
 * that rewrites a password hash on every write, say) passes an integrity check,
 * but not this.
 */
function schemaProblems(file: string, applied: readonly string[]): string[] {
  const wanted = migrations.filter((m) => applied.includes(m.id));
  if (wanted.length !== applied.length || wanted.some((m, i) => m.id !== applied[i])) return []; // unknown or out of order: reported elsewhere
  const reference = openSqlite({ path: ':memory:' });
  const copy = openSqlite({ path: file, readonly: true });
  try {
    runMigrations(reference, wanted);
    const expected = schemaOf(reference);
    const actual = schemaOf(copy);
    const problems: string[] = [];
    for (const [key, sql] of actual) {
      if (!expected.has(key)) problems.push(`an unexpected ${key}`);
      else if (expected.get(key) !== sql) problems.push(`a changed ${key}`);
    }
    for (const key of expected.keys()) if (!actual.has(key)) problems.push(`a missing ${key}`);
    return problems.length ? [`${DB_FILE} does not have the schema ClawRouter creates (${problems.slice(0, 5).join(', ')}${problems.length > 5 ? ', …' : ''}).`] : [];
  } finally {
    copy.close();
    reference.close();
  }
}

interface Staged extends RestoreCheck {
  /** The verified copy: every check ran on it, and a restore installs exactly it. Null when the copy failed. */
  file: string | null;
}

/**
 * Copies the backup's database into `stageDir` once, then checks the copy:
 * checksum (of the bytes copied), integrity, migrations, schema and secrets.
 * Checking the copy, not the original, means nothing can change between the
 * check and the restore, and SQLite never reads files planted next to the
 * original (a `-wal`, say).
 */
async function stage(backupPath: string, box: SecretBox, stageDir: string): Promise<Staged> {
  const dir = resolve(backupPath);
  let dirStat;
  try {
    dirStat = lstatSync(dir);
  } catch {
    throw new AppError('VALIDATION_ERROR', `${dir} is not a complete ClawRouter backup (no readable ${MANIFEST}).`);
  }
  if (dirStat.isSymbolicLink()) throw new AppError('VALIDATION_ERROR', `${dir} is a symbolic link; give the backup directory itself.`);
  let manifestText: string;
  try {
    const { fd, size } = openRegular(join(dir, MANIFEST));
    try {
      if (size > MANIFEST_MAX_BYTES) throw new AppError('VALIDATION_ERROR', `${MANIFEST} is too large to be a ClawRouter manifest.`);
      manifestText = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof AppError && /symbolic link|too large|not a regular/.test(error.message)) throw error;
    throw new AppError('VALIDATION_ERROR', `${dir} is not a complete ClawRouter backup (no readable ${MANIFEST}).`);
  }
  const manifest = parseManifest(manifestText, dir);

  const errors: string[] = [];
  const known = new Set(migrations.map((m) => m.id));
  const newer = manifest.migrations.filter((id) => !known.has(id));
  if (newer.length) errors.push(`The backup comes from a newer ClawRouter (migrations ${newer.join(', ')}). Restore it with that version or later.`);

  let file: string | null = null;
  let opened: { fd: number; size: number } | null = null;
  try {
    opened = openRegular(join(dir, DB_FILE));
  } catch (error) {
    errors.push(error instanceof AppError ? error.message : `${DB_FILE} cannot be read.`);
  }
  if (opened) {
    try {
      if (opened.size !== manifest.database.bytes) errors.push(`${DB_FILE} is ${opened.size} bytes, not the ${manifest.database.bytes} its manifest records: the backup is damaged.`);
      else {
        const free = (() => {
          try {
            const fs = statfsSync(stageDir);
            return fs.bavail * fs.bsize;
          } catch {
            return Number.POSITIVE_INFINITY;
          }
        })();
        if (opened.size > free) errors.push(`${DB_FILE} (${opened.size} bytes) does not fit in the free space of ${stageDir}.`);
        else {
          file = join(stageDir, DB_FILE);
          if (copyAndHash(opened.fd, file) !== manifest.database.sha256) errors.push(`${DB_FILE} does not match its checksum: the backup is damaged.`);
        }
      }
    } finally {
      closeSync(opened.fd);
    }
  }

  let unreadableSecrets = 0;
  if (file && !errors.length) {
    const { ok, migrations: applied } = (() => {
      try {
        return inspect(file);
      } catch {
        return { ok: false, migrations: [] as string[] };
      }
    })();
    if (!ok) errors.push(`${DB_FILE} failed its integrity check.`);
    else if (applied.join() !== manifest.migrations.join()) errors.push(`${DB_FILE} records other migrations than its manifest: the backup is damaged.`);
    else errors.push(...schemaProblems(file, applied));
  }
  if (file && !errors.length) {
    const copy = openSqlite({ path: file, readonly: true });
    try {
      unreadableSecrets = (await checkSealedSecrets(sealedSecretStores(copy), box)).filter((c) => !c.ok).length;
    } finally {
      copy.close();
    }
  }
  return { manifest, errors, unreadableSecrets, file };
}

/**
 * Everything a restore checks, without changing anything. The copy is made in a
 * private directory inside `stageIn` (give the database's directory: a small /tmp
 * may not hold it), then removed.
 */
export async function checkBackup(backupPath: string, box: SecretBox, stageIn = tmpdir()): Promise<RestoreCheck> {
  const tmp = mkdtempSync(join(stageIn, ".clawrouter-restore-check-"));
  try {
    const { file: _file, ...check } = await stage(backupPath, box, tmp);
    return check;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The process that serves `dbPath`, if one is running (written next to the database at startup). */
export function runningServer(dbPath: string): number | null {
  const pidFile = `${resolve(dbPath)}.pid`;
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null; // a stale file from a crash
  }
}

/**
 * Replaces the database at `dbPath` with a backup. ClawRouter must be stopped. The
 * current database is kept as `<db>.before-restore-<time>`; the restored one is
 * migrated to this version. With `force`, a backup whose secrets the configured
 * key cannot open is restored anyway (those values must then be entered again).
 *
 * The backup is copied once into a private directory next to the database; every
 * check runs on that copy, and that same file is moved into place (SEC-003).
 */
export async function restoreBackup(backupPath: string, o: { dbPath: string; box: SecretBox; force?: boolean; now?: Date; log?: Logger }): Promise<{ previous: string | null; applied: string[] }> {
  const pid = runningServer(o.dbPath);
  if (pid !== null) throw new AppError('CONFLICT', `ClawRouter is running (process ${pid}). Stop it before restoring.`);
  const db = resolve(o.dbPath);
  mkdirSync(dirname(db), { recursive: true, mode: 0o700 });
  const stageDir = mkdtempSync(join(dirname(db), '.clawrouter-restore-'));
  try {
    const check = await stage(backupPath, o.box, stageDir);
    if (check.errors.length || !check.file) throw new AppError('VALIDATION_ERROR', check.errors.join(' ') || 'The backup could not be copied.');
    if (check.unreadableSecrets && !o.force) {
      throw new AppError('VALIDATION_ERROR',
        `${check.unreadableSecrets} encrypted value(s) in the backup cannot be opened with the configured secret key (it has fingerprint ${o.box.fingerprint}; the backup was made with ${check.manifest.secretKey.fingerprint}${check.manifest.secretKey.included ? `, whose key is in ${join(resolve(backupPath), KEY_FILE)}` : ''}). Configure that key, or restore with --force and enter those values again.`);
    }
    const now = o.now ?? new Date();
    let previous: string | null = null;
    if (existsSync(db)) {
      previous = `${db}.before-restore-${stamp(now)}`;
      renameSync(db, previous);
      for (const ext of ['-wal', '-shm']) if (existsSync(db + ext)) renameSync(db + ext, previous + ext);
    }
    renameSync(check.file, db);
    const restored = openSqlite({ path: db });
    try {
      const applied = runMigrations(restored, migrations, o.log);
      createAuditService(createSqliteAuditRepository(restored), o.log).record({
        action: 'BACKUP_RESTORED', result: 'SUCCESS', resource: 'system', resourceId: basename(resolve(backupPath)),
        actor: { id: null, name: 'command line' }, ip: null, requestId: null,
        metadata: { createdAt: check.manifest.createdAt, migrationsApplied: applied.length, forced: !!(o.force && check.unreadableSecrets), unreadableSecrets: check.unreadableSecrets },
      });
      return { previous, applied };
    } finally {
      restored.close();
    }
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}
