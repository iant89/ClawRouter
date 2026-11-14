import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
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
 *     secret.key        only with includeSecretKey (then the backup alone decrypts everything)
 *
 * The secret key is NOT included by default: whoever holds database and key can
 * read every provider API key. Store the key separately (see docs/deployment.md);
 * the manifest records its fingerprint so a restore can tell whether the right
 * key is configured.
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
  /** Values in the copy that are encrypted with that key. */
  encryptedValues: number;
}

const DB_FILE = 'clawrouter.db';
const MANIFEST = 'manifest.json';
const KEY_FILE = 'secret.key';
const NAME = /^clawrouter-\d{8}-\d{6}(-[a-z0-9-]+)?$/;

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
  /** The key text to copy into the backup (opt-in). */
  includeSecretKey?: string | null;
  now?: Date;
  log?: Logger;
}

/** Copies the live database into a new backup directory and verifies the copy. */
export async function createBackup(db: Database, o: CreateBackupOptions): Promise<{ path: string; manifest: BackupManifest }> {
  const now = o.now ?? new Date();
  const label = o.label ?? 'manual';
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  let path = join(o.dir, `clawrouter-${stamp(now)}${label === 'manual' ? '' : `-${label}`}`);
  for (let n = 2; existsSync(path); n++) path = join(o.dir, `clawrouter-${stamp(now)}-${label}-${n}`);
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
      migrations: applied, secretKey: { fingerprint: o.box.fingerprint, included: !!o.includeSecretKey }, encryptedValues,
    };
    // Written last: a directory without a manifest is an incomplete backup.
    writeFileSync(join(path, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    createAuditService(createSqliteAuditRepository(db), o.log).record({
      action: 'BACKUP_CREATED', result: 'SUCCESS', resource: 'system', resourceId: basename(path),
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

/** Backups in `dir`, newest first. Directories without a manifest are incomplete. */
export function listBackups(dir: string): BackupInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => NAME.test(name))
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

/** Keeps the newest `keep` complete backups with this label; removes older ones. Returns the removed paths. */
export function pruneBackups(dir: string, label: string, keep: number): string[] {
  const mine = listBackups(dir).filter((b) => b.manifest?.label === label);
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

/** Everything a restore checks, without changing anything. */
export async function checkBackup(backupPath: string, box: SecretBox): Promise<RestoreCheck> {
  const dir = resolve(backupPath);
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as BackupManifest;
  } catch {
    throw new AppError('VALIDATION_ERROR', `${dir} is not a complete ClawRouter backup (no readable ${MANIFEST}).`);
  }
  if (manifest.format !== 'clawrouter-backup') throw new AppError('VALIDATION_ERROR', `${dir} is not a ClawRouter backup.`);
  const errors: string[] = [];
  const file = join(dir, DB_FILE);
  if (!existsSync(file)) errors.push(`${DB_FILE} is missing.`);
  else if (sha256File(file) !== manifest.database.sha256) errors.push(`${DB_FILE} does not match its checksum: the backup is damaged.`);
  else if (!inspect(file).ok) errors.push(`${DB_FILE} failed its integrity check.`);
  const known = new Set(migrations.map((m) => m.id));
  const newer = manifest.migrations.filter((id) => !known.has(id));
  if (newer.length) errors.push(`The backup comes from a newer ClawRouter (migrations ${newer.join(', ')}). Restore it with that version or later.`);
  let unreadableSecrets = 0;
  if (!errors.length) {
    const copy = openSqlite({ path: file, readonly: true });
    try {
      unreadableSecrets = (await checkSealedSecrets(sealedSecretStores(copy), box)).filter((c) => !c.ok).length;
    } finally {
      copy.close();
    }
  }
  return { manifest, errors, unreadableSecrets };
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
 */
export async function restoreBackup(backupPath: string, o: { dbPath: string; box: SecretBox; force?: boolean; now?: Date; log?: Logger }): Promise<{ previous: string | null; applied: string[] }> {
  const pid = runningServer(o.dbPath);
  if (pid !== null) throw new AppError('CONFLICT', `ClawRouter is running (process ${pid}). Stop it before restoring.`);
  const check = await checkBackup(backupPath, o.box);
  if (check.errors.length) throw new AppError('VALIDATION_ERROR', check.errors.join(' '));
  if (check.unreadableSecrets && !o.force) {
    throw new AppError('VALIDATION_ERROR',
      `${check.unreadableSecrets} encrypted value(s) in the backup cannot be opened with the configured secret key (it has fingerprint ${o.box.fingerprint}; the backup was made with ${check.manifest.secretKey.fingerprint}${check.manifest.secretKey.included ? `, whose key is in ${join(resolve(backupPath), KEY_FILE)}` : ''}). Configure that key, or restore with --force and enter those values again.`);
  }
  const db = resolve(o.dbPath);
  const now = o.now ?? new Date();
  let previous: string | null = null;
  if (existsSync(db)) {
    previous = `${db}.before-restore-${stamp(now)}`;
    renameSync(db, previous);
    for (const ext of ['-wal', '-shm']) if (existsSync(db + ext)) renameSync(db + ext, previous + ext);
  }
  writeFileSync(db, readFileSync(join(resolve(backupPath), DB_FILE)), { mode: 0o600 });
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
}
