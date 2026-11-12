import type { Database } from '@clawrouter/database';
import type { RateLimitConfig, RateLimitSettings } from '@clawrouter/shared';
import { defaultConfig } from './config.ts';

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
      return { ...defaultConfig(), ...(JSON.parse(row.document) as RateLimitSettings), version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by };
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
