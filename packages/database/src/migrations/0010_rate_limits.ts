import type { Migration } from '../migrations.ts';

/**
 * Rate limits (spec §12). The configuration is one versioned JSON document, like
 * routing. A key's own limit lives on the key (JSON, NULL = the default limit).
 * Counters are not stored: they live in the counter store (memory for now).
 */
export const m0010RateLimits: Migration = {
  id: '0010_rate_limits',
  up: `
CREATE TABLE rate_limit_config (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  document   TEXT NOT NULL,
  version    INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
) STRICT;

ALTER TABLE api_keys ADD COLUMN rate_limit TEXT;
`,
};
