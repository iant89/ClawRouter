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
/**
 * Backs up the database while ClawRouter runs (a consistent copy), and lists backups.
 *
 *   bun run backup                        new backup in CLAWROUTER_BACKUP_DIR (default data/backups)
 *   bun run backup --dir /mnt/backups     somewhere else
 *   bun run backup --keep 14              then keep only the 14 newest manual backups
 *   bun run backup --list                 list backups, newest first (never shows a key)
 *   bun run backup --include-secret-key   a CREDENTIAL backup: also the secret key, in <dir>/credentials/
 *        [--yes]                          (asks for confirmation; --yes confirms without a terminal)
 *   bun run backup --list --credentials   list credential backups
 *
 * A normal backup is the database: the configuration and the operational data,
 * with stored credentials only in encrypted form. The secret key that opens them
 * is not included: keep it somewhere else (a password manager, a secrets store).
 * Without it, the provider API keys in a backup are lost. A credential backup
 * (SEC-011) also holds the key and opens every credential on its own.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AppError, createLogger, loadConfig } from '@clawrouter/core';
import { migrationStatus, migrations, openSqlite } from '@clawrouter/database';
import { createBackup, credentialBackupDir, holdsSecretKey, listBackups, listCredentialBackups, pruneBackups, type BackupInfo } from '../apps/server/src/backup.ts';
import { loadSecretBox } from '../apps/server/src/secret-key.ts';
import { VERSION } from '../apps/server/src/version.ts';

const args = process.argv.slice(2);
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const config = loadConfig();
const dir = value('--dir') ?? config.database.backupDir;
const withKey = args.includes('--include-secret-key') || (args.includes('--credentials') && !args.includes('--list'));

const WARNING = [
  'WARNING: a credential backup contains the secret key. With it, anyone who gets the',
  'backup can read every stored provider API key, the mail password and the two-factor',
  'secrets. Keep it offline or in a secrets store, never next to normal backups, and',
  'delete it when it is no longer needed. It is written to',
  `  ${credentialBackupDir(resolve(dir))}`,
  '(directory 0700, files 0600) and is never listed, pruned or deleted with normal backups.',
].join('\n');

const describe = (b: BackupInfo) => {
  const m = b.manifest;
  if (!m) return `${b.path}  INCOMPLETE (no manifest)`;
  const line = `${b.path}  ${m.createdAt}  ${m.label}  ${(m.database.bytes / 1048576).toFixed(1)} MB  key ${m.secretKey.fingerprint}`;
  return holdsSecretKey(m) ? `${line}  CONTAINS THE SECRET KEY` : line;
};

if (args.includes('--list')) {
  const all = args.includes('--credentials') ? listCredentialBackups(dir) : listBackups(dir);
  if (!all.length) console.log(args.includes('--credentials') ? `No credential backups in ${credentialBackupDir(dir)}.` : `No backups in ${dir}.`);
  for (const b of all) console.log(describe(b));
  // Made with the key before credential backups were kept apart: say so, without showing anything of the key.
  const legacy = args.includes('--credentials') ? [] : all.filter((b) => holdsSecretKey(b.manifest));
  if (legacy.length) console.log(`\n${legacy.length} backup(s) above contain the secret key. Move them to ${credentialBackupDir(dir)} or somewhere safer.`);
  const credentials = args.includes('--credentials') ? 0 : listCredentialBackups(dir).length;
  if (credentials) console.log(`\n${credentials} credential backup(s) are not shown: bun run backup --list --credentials`);
  process.exit(0);
}

/** Explicit confirmation before the key goes into a backup: typed on a terminal, or --yes. */
function confirmed(): boolean {
  console.error(WARNING);
  if (args.includes('--yes')) return true;
  if (!process.stdin.isTTY) {
    console.error('\nRefused: add --yes to confirm a credential backup when no terminal is attached.');
    return false;
  }
  const answer = prompt('\nType "include the secret key" to continue:');
  if (answer?.trim().toLowerCase() === 'include the secret key') return true;
  console.error('Not confirmed; nothing was written.');
  return false;
}

const log = createLogger({ level: 'warn', format: 'pretty' });
if (withKey && !confirmed()) process.exit(1);
const db = openSqlite({ path: config.database.path });
try {
  if (migrationStatus(db, migrations).every((m) => !m.appliedAt)) throw new AppError('VALIDATION_ERROR', `There is no ClawRouter database at ${config.database.path}.`);
  const box = loadSecretBox(config, log);
  const keyText = !withKey ? null
    : config.secrets.key ?? readFileSync(config.secrets.keyFile ?? join(dirname(resolve(config.database.path)), 'secret.key'), 'utf8');
  const { path, manifest } = await createBackup(db, { dir, box, version: VERSION, includeSecretKey: keyText, confirmSecretKey: withKey, log });
  console.log(`${withKey ? 'Credential backup' : 'Backup'} written to ${path} (${(manifest.database.bytes / 1048576).toFixed(1)} MB, ${manifest.encryptedValues} encrypted value(s), key ${manifest.secretKey.fingerprint}).`);
  if (!manifest.secretKey.included) console.log('The secret key is not in the backup. Make sure a copy of it is kept somewhere safe.');
  else console.log('WARNING: this backup contains the secret key and opens every stored credential. Store it accordingly.');
  const keep = value('--keep');
  if (keep && !withKey) for (const removed of pruneBackups(dir, 'manual', Number(keep))) console.log(`Removed old backup ${removed}`);
} catch (error) {
  console.error(error instanceof AppError ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}
