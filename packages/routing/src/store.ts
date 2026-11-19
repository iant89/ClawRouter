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
import type { RoutingConfig } from '@clawrouter/shared';
import { emptyConfig } from './config.ts';

/**
 * Persistence for the routing configuration: one versioned JSON document. The
 * engine never touches this; it only sees the loaded configuration (spec §2.4).
 */
export interface RoutingStore {
  load(): RoutingConfig;
  /** Saves only if the stored version still equals `expectedVersion`. Returns the saved config, or null on conflict. */
  save(config: Pick<RoutingConfig, 'defaultPolicy' | 'aliases'>, expectedVersion: number, at: string, by: string | null): RoutingConfig | null;
}

interface Row {
  document: string;
  version: number;
  updated_at: string;
  updated_by: string | null;
}

export function createSqliteRoutingStore(db: Database): RoutingStore {
  return {
    load() {
      const row = db.get<Row>('SELECT document, version, updated_at, updated_by FROM routing_config WHERE id = 1');
      if (!row) return emptyConfig();
      const doc = JSON.parse(row.document) as Pick<RoutingConfig, 'defaultPolicy' | 'aliases'>;
      return { ...emptyConfig(), ...doc, version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by };
    },
    save(config, expectedVersion, at, by) {
      return db.transaction((tx) => {
        const current = tx.get<{ version: number }>('SELECT version FROM routing_config WHERE id = 1')?.version ?? 0;
        if (current !== expectedVersion) return null;
        const version = current + 1;
        const document = JSON.stringify({ defaultPolicy: config.defaultPolicy, aliases: config.aliases });
        tx.run(
          `INSERT INTO routing_config (id, document, version, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET document = excluded.document, version = excluded.version,
             updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          [document, version, at, by],
        );
        return { defaultPolicy: config.defaultPolicy, aliases: config.aliases, version, updatedAt: at, updatedBy: by };
      });
    },
  };
}
