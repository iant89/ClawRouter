/**
 * Restores a backup made with `bun run backup` (or an automatic one).
 *
 *   bun run restore <backup directory>           check it, and say what would happen
 *   bun run restore <backup directory> --yes     restore (ClawRouter must be stopped)
 *   ... --yes --force                            even if the configured key cannot open its secrets
 *
 * The current database is kept next to it as <db>.before-restore-<time>.
 */
import { AppError, createLogger, loadConfig } from '@clawrouter/core';
import { checkBackup, restoreBackup, runningServer } from '../apps/server/src/backup.ts';
import { loadSecretBox } from '../apps/server/src/secret-key.ts';

const args = process.argv.slice(2);
const backup = args.find((a) => !a.startsWith('--'));
if (!backup || args.includes('--help')) {
  console.error('usage: bun run restore <backup directory> [--yes] [--force]');
  process.exit(backup ? 0 : 2);
}
const config = loadConfig();
const log = createLogger({ level: 'warn', format: 'pretty' });
try {
  const box = loadSecretBox(config, log);
  const check = await checkBackup(backup, box);
  const m = check.manifest;
  console.log(`Backup from ${m.createdAt} (${m.label}, ClawRouter ${m.clawrouterVersion}), ${(m.database.bytes / 1048576).toFixed(1)} MB, ${m.migrations.length} migrations.`);
  console.log(`Encrypted with key ${m.secretKey.fingerprint}; the configured key is ${box.fingerprint}${m.secretKey.fingerprint === box.fingerprint ? ' (the same)' : ''}.`);
  for (const e of check.errors) console.log(`PROBLEM: ${e}`);
  if (check.unreadableSecrets) console.log(`PROBLEM: ${check.unreadableSecrets} encrypted value(s) cannot be opened with the configured key.`);
  const pid = runningServer(config.database.path);
  if (pid !== null) console.log(`PROBLEM: ClawRouter is running (process ${pid}). Stop it first.`);
  if (!args.includes('--yes')) {
    console.log(`\nNothing changed. To replace ${config.database.path} with this backup, run again with --yes.`);
    process.exit(check.errors.length || pid !== null ? 1 : 0);
  }
  const { previous, applied } = await restoreBackup(backup, { dbPath: config.database.path, box, force: args.includes('--force'), log });
  console.log(`Restored. ${previous ? `The previous database is kept as ${previous}. ` : ''}${applied.length ? `Applied ${applied.length} migration(s) to bring it up to date.` : ''}`);
  console.log('Start ClawRouter again.');
} catch (error) {
  console.error(error instanceof AppError ? error.message : error);
  process.exitCode = 1;
}
