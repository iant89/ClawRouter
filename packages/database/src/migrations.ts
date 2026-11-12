import { AppError, type Logger } from '@clawapi/core';
import type { Database } from './types.ts';

export interface Migration {
  /** Sortable unique id, e.g. `0001_settings`. Never rename after release. */
  id: string;
  /** SQL applied once, inside a transaction. Never edit after release; add a new migration. */
  up: string;
}

export interface MigrationStatus {
  id: string;
  appliedAt: string | null;
}

const LEDGER = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

function checksum(sql: string): string {
  return new Bun.CryptoHasher('sha256').update(sql.trim()).digest('hex');
}

function validate(migrations: readonly Migration[]): void {
  const seen = new Set<string>();
  let previous = '';
  for (const m of migrations) {
    if (!/^\d{4}_[a-z0-9_]+$/.test(m.id)) throw new AppError('INTERNAL_ERROR', `Invalid migration id "${m.id}"`);
    if (seen.has(m.id)) throw new AppError('INTERNAL_ERROR', `Duplicate migration id "${m.id}"`);
    if (m.id <= previous) throw new AppError('INTERNAL_ERROR', `Migration "${m.id}" is out of order`);
    seen.add(m.id);
    previous = m.id;
  }
}

/**
 * Applies pending migrations in order, each in its own transaction, and records
 * a checksum so an edited migration is detected instead of silently skipped.
 * Returns the ids applied by this call.
 */
export function runMigrations(db: Database, migrations: readonly Migration[], log?: Logger): string[] {
  validate(migrations);
  db.exec(LEDGER);

  const applied = new Map(
    db.all<{ id: string; checksum: string }>('SELECT id, checksum FROM schema_migrations').map((r) => [r.id, r.checksum]),
  );
  const known = new Set(migrations.map((m) => m.id));
  for (const id of applied.keys()) {
    if (!known.has(id)) {
      throw new AppError('INTERNAL_ERROR', `Database has migration "${id}" that this version does not know. Refusing to start (downgrade?).`);
    }
  }

  const ran: string[] = [];
  for (const migration of migrations) {
    const sum = checksum(migration.up);
    const existing = applied.get(migration.id);
    if (existing !== undefined) {
      if (existing !== sum) throw new AppError('INTERNAL_ERROR', `Migration "${migration.id}" was modified after it was applied.`);
      continue;
    }
    db.transaction((tx) => {
      tx.exec(migration.up);
      tx.run('INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)', [migration.id, sum, new Date().toISOString()]);
    });
    log?.info('migration applied', { component: 'database', migration: migration.id });
    ran.push(migration.id);
  }
  return ran;
}

export function migrationStatus(db: Database, migrations: readonly Migration[]): MigrationStatus[] {
  db.exec(LEDGER);
  const applied = new Map(
    db.all<{ id: string; applied_at: string }>('SELECT id, applied_at FROM schema_migrations').map((r) => [r.id, r.applied_at]),
  );
  return migrations.map((m) => ({ id: m.id, appliedAt: applied.get(m.id) ?? null }));
}
