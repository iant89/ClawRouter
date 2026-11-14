/**
 * Backs up the database while ClawRouter runs (a consistent copy), and lists backups.
 *
 *   bun run backup                        new backup in CLAWROUTER_BACKUP_DIR (default data/backups)
 *   bun run backup --dir /mnt/backups     somewhere else
 *   bun run backup --include-secret-key   also copy the secret key (the backup then decrypts everything alone)
 *   bun run backup --keep 14              then keep only the 14 newest manual backups
 *   bun run backup --list                 list backups, newest first
 *
 * The secret key is not included by default: keep it somewhere else (a password
 * manager, a secrets store). Without it, the provider API keys in a backup are lost.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AppError, createLogger, loadConfig } from '@clawrouter/core';
import { migrationStatus, migrations, openSqlite } from '@clawrouter/database';
import { createBackup, listBackups, pruneBackups } from '../apps/server/src/backup.ts';
import { loadSecretBox } from '../apps/server/src/secret-key.ts';
import { VERSION } from '../apps/server/src/version.ts';

const args = process.argv.slice(2);
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const config = loadConfig();
const dir = value('--dir') ?? config.database.backupDir;

if (args.includes('--list')) {
  const all = listBackups(dir);
  if (!all.length) console.log(`No backups in ${dir}.`);
  for (const b of all) {
    const m = b.manifest;
    console.log(m ? `${b.path}  ${m.createdAt}  ${m.label}  ${(m.database.bytes / 1048576).toFixed(1)} MB  key ${m.secretKey.fingerprint}${m.secretKey.included ? ' (included)' : ''}` : `${b.path}  INCOMPLETE (no manifest)`);
  }
  process.exit(0);
}

const log = createLogger({ level: 'warn', format: 'pretty' });
const db = openSqlite({ path: config.database.path });
try {
  if (migrationStatus(db, migrations).every((m) => !m.appliedAt)) throw new AppError('VALIDATION_ERROR', `There is no ClawRouter database at ${config.database.path}.`);
  const box = loadSecretBox(config, log);
  const keyText = !args.includes('--include-secret-key') ? null
    : config.secrets.key ?? readFileSync(config.secrets.keyFile ?? join(dirname(resolve(config.database.path)), 'secret.key'), 'utf8');
  const { path, manifest } = await createBackup(db, { dir, box, version: VERSION, includeSecretKey: keyText, log });
  console.log(`Backup written to ${path} (${(manifest.database.bytes / 1048576).toFixed(1)} MB, ${manifest.encryptedValues} encrypted value(s), key ${manifest.secretKey.fingerprint}).`);
  if (!manifest.secretKey.included) console.log('The secret key is not in the backup. Make sure a copy of it is kept somewhere safe.');
  else console.log('WARNING: the backup contains the secret key. Anyone with it can read every stored provider API key. Store it accordingly.');
  const keep = value('--keep');
  if (keep) for (const removed of pruneBackups(dir, 'manual', Number(keep))) console.log(`Removed old backup ${removed}`);
} catch (error) {
  console.error(error instanceof AppError ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}
