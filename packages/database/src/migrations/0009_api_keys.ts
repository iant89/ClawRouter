import type { Migration } from '../migrations.ts';

/**
 * API keys for external AI clients (spec §14, §30 API_KEYS). Only a SHA-256 hash
 * of the full key is stored; the key is shown once, when it is created.
 */
export const m0009ApiKeys: Migration = {
  id: '0009_api_keys',
  up: `
CREATE TABLE api_keys (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  prefix         TEXT NOT NULL UNIQUE,
  secret_hash    TEXT NOT NULL,
  allowed_models TEXT NOT NULL DEFAULT '[]',
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT,
  last_used_at   TEXT,
  revoked_at     TEXT,
  revoked_by     TEXT
) STRICT;

CREATE INDEX api_keys_created_at ON api_keys(created_at);
`,
};
