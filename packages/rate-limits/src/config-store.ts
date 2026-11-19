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

import type { Database } from '@clawrouter/database';
import type { RateLimitConfig, RateLimitSettings } from '@clawrouter/shared';
import { defaultConfig, normalizeSettings, upgradeSettings } from './config.ts';

/** Persistence for the rate-limit configuration: one versioned JSON document. */
export interface RateLimitConfigStore {
  load(): RateLimitConfig;
  /** Saves only if the stored version still equals `expectedVersion`; null on conflict. */
  save(settings: RateLimitSettings, expectedVersion: number, at: string, by: string | null): RateLimitConfig | null;
}

interface Row {
  document: string;
  version: number;
  updated_at: string;
  updated_by: string | null;
}

export function createSqliteRateLimitConfigStore(db: Database): RateLimitConfigStore {
  return {
    load() {
      const row = db.get<Row>('SELECT document, version, updated_at, updated_by FROM rate_limit_config WHERE id = 1');
      if (!row) return defaultConfig();
      // Documents saved before windows and buckets existed are upgraded as they are read.
      const settings = normalizeSettings({ ...defaultConfig(), ...(upgradeSettings(JSON.parse(row.document)) as RateLimitSettings) });
      return { ...settings, version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by };
    },
    save(settings, expectedVersion, at, by) {
      return db.transaction((tx) => {
        const current = tx.get<{ version: number }>('SELECT version FROM rate_limit_config WHERE id = 1')?.version ?? 0;
        if (current !== expectedVersion) return null;
        const version = current + 1;
        tx.run(
          `INSERT INTO rate_limit_config (id, document, version, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET document = excluded.document, version = excluded.version,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          [JSON.stringify(settings), version, at, by],
        );
        return { ...settings, version, updatedAt: at, updatedBy: by };
      });
    },
  };
}
