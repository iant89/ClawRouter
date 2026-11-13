import type { Migration } from '../migrations.ts';

/**
 * Health history and operations (spec §24, §26, §30 OPERATIONS).
 *
 * `health_history`: one row per component per scheduled health check (every 30 s
 * by default), pruned after the retention period. Details are stored as shown to
 * administrators; they never contain secrets.
 * `operations`: long-running work (connection tests, provider checks, health
 * checks) with status, progress and result. No foreign keys: history must outlive
 * the users and providers it mentions.
 */
export const m0012HealthOperations: Migration = {
  id: '0012_health_operations',
  up: `
CREATE TABLE health_history (
  id          INTEGER PRIMARY KEY,
  checked_at  TEXT NOT NULL,
  component   TEXT NOT NULL,
  status      TEXT NOT NULL,
  latency_ms  INTEGER NOT NULL,
  detail      TEXT
) STRICT;

CREATE INDEX health_history_component ON health_history(component, checked_at);
CREATE INDEX health_history_checked_at ON health_history(checked_at);

CREATE TABLE operations (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  target_id     TEXT,
  status        TEXT NOT NULL,
  progress      INTEGER NOT NULL DEFAULT 0,
  message       TEXT,
  result        TEXT,
  error         TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  completed_at  TEXT
) STRICT;

CREATE INDEX operations_created_at ON operations(created_at);
CREATE INDEX operations_status ON operations(status, created_at);
`,
};
