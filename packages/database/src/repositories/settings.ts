import { AppError } from '@clawapi/core';
import type { Database } from '../types.ts';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface Setting {
  key: string;
  value: JsonValue;
  updatedAt: string;
}

/** Repository contract: what domain services see. */
export interface SettingsRepository {
  get(key: string): Setting | undefined;
  list(): Setting[];
  set(key: string, value: JsonValue): Setting;
  delete(key: string): boolean;
}

interface Row {
  key: string;
  value: string;
  updated_at: string;
}

const toSetting = (row: Row): Setting => ({ key: row.key, value: JSON.parse(row.value) as JsonValue, updatedAt: row.updated_at });

export function createSqliteSettingsRepository(db: Database, now: () => Date = () => new Date()): SettingsRepository {
  return {
    get(key) {
      const row = db.get<Row>('SELECT key, value, updated_at FROM settings WHERE key = ?', [key]);
      return row ? toSetting(row) : undefined;
    },
    list() {
      return db.all<Row>('SELECT key, value, updated_at FROM settings ORDER BY key').map(toSetting);
    },
    set(key, value) {
      if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(key)) {
        throw new AppError('VALIDATION_ERROR', 'Invalid setting key.', { details: { issues: [{ path: 'key', message: 'must match ^[a-z][a-z0-9_.-]{0,127}$' }] } });
      }
      const updatedAt = now().toISOString();
      db.run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, JSON.stringify(value), updatedAt],
      );
      return { key, value, updatedAt };
    },
    delete(key) {
      return db.run('DELETE FROM settings WHERE key = ?', [key]).changes > 0;
    },
  };
}
