/**
 * Applies pending database migrations and prints their status.
 *   bun run migrate            back up (CLAWROUTER_BACKUP_BEFORE_MIGRATE), then apply pending migrations
 *   bun run migrate --status   show status only
 */
import { createLogger, loadConfig } from '@clawrouter/core';
import { migrationStatus, migrations, openSqlite, runMigrations } from '@clawrouter/database';
import { createBackup, pruneBackups } from '../apps/server/src/backup.ts';
import { loadSecretBox } from '../apps/server/src/secret-key.ts';
import { VERSION } from '../apps/server/src/version.ts';

const config = loadConfig();
const log = createLogger({ level: 'info', format: 'pretty' });
const db = openSqlite({ path: config.database.path });
try {
  if (!process.argv.includes('--status')) {
    const status = migrationStatus(db, migrations);
    const existing = status.some((m) => m.appliedAt);
    if (existing && status.some((m) => !m.appliedAt) && config.database.backupBeforeMigrate && config.database.path !== ':memory:') {
      const { path } = await createBackup(db, { dir: config.database.backupDir, box: loadSecretBox(config, log), version: VERSION, label: 'pre-migrate', log });
      pruneBackups(config.database.backupDir, 'pre-migrate', config.database.backupKeep);
      log.info('backed up before migrating', { backup: path });
    }
    const ran = runMigrations(db, migrations, log);
    log.info(ran.length ? `applied ${ran.length} migration(s)` : 'database is up to date', { database: config.database.path });
  }
  for (const m of migrationStatus(db, migrations)) {
    console.log(`${m.appliedAt ? '✔' : '·'} ${m.id}${m.appliedAt ? `  (${m.appliedAt})` : '  pending'}`);
  }
} finally {
  db.close();
}
