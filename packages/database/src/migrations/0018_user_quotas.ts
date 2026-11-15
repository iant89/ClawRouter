import type { Migration } from '../migrations.ts';

/**
 * Usage quotas per user (how much one user's keys may use per day, week or
 * month). Usage is read from `usage_records`, so it survives restarts and the
 * pruning of request detail; the index makes the per-request check cheap.
 */
export const m0018UserQuotas: Migration = {
  id: '0018_user_quotas',
  up: `
CREATE TABLE user_quotas (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  quota       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT
) STRICT;

CREATE INDEX usage_records_user ON usage_records(user_id, hour);
`,
};
