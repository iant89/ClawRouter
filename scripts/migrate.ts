/**
 * Applies pending database migrations and prints their status.
 *   bun run migrate            apply pending migrations
 *   bun run migrate --status   show status only
 */
import { createLogger, loadConfig } from '@clawapi/core';
import { migrationStatus, migrations, openSqlite, runMigrations } from '@clawapi/database';

const config = loadConfig();
const log = createLogger({ level: 'info', format: 'pretty' });
const db = openSqlite({ path: config.database.path });
try {
  if (!process.argv.includes('--status')) {
    const ran = runMigrations(db, migrations, log);
    log.info(ran.length ? `applied ${ran.length} migration(s)` : 'database is up to date', { database: config.database.path });
  }
  for (const m of migrationStatus(db, migrations)) {
    console.log(`${m.appliedAt ? '✔' : '·'} ${m.id}${m.appliedAt ? `  (${m.appliedAt})` : '  pending'}`);
  }
} finally {
  db.close();
}
