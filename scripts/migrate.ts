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
