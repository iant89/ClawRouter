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

import { AppError } from '@clawrouter/core';
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
