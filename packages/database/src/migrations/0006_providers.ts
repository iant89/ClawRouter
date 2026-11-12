import type { Migration } from '../migrations.ts';

/**
 * Provider engine (spec §8, §29, §30 PROVIDERS / PROVIDER_CREDENTIALS /
 * PROVIDER_HEALTH_HISTORY). Credentials are AES-256-GCM ciphertext; the key is
 * never in the database, only its fingerprint.
 */
export const m0006Providers: Migration = {
  id: '0006_providers',
  up: `
CREATE TABLE providers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL COLLATE NOCASE UNIQUE,
  identifier        TEXT NOT NULL UNIQUE,
  kind              TEXT NOT NULL,
  endpoint          TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  priority          INTEGER NOT NULL DEFAULT 100,
  timeout_ms        INTEGER NOT NULL DEFAULT 60000,
  status            TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'OFFLINE', 'DISABLED')),
  status_detail     TEXT,
  status_checked_at TEXT,
  latency_ms        INTEGER,
  metadata          TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;

CREATE TABLE provider_credentials (
  provider_id     TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  ciphertext      TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  hint            TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  updated_by      TEXT,
  PRIMARY KEY (provider_id, name)
) STRICT;

CREATE TABLE provider_health_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  checked_at  TEXT NOT NULL,
  check_kind  TEXT NOT NULL CHECK (check_kind IN ('TEST', 'HEALTH')),
  status      TEXT NOT NULL,
  latency_ms  INTEGER,
  detail      TEXT
) STRICT;

CREATE INDEX provider_health_history_provider ON provider_health_history(provider_id, checked_at);
CREATE INDEX provider_health_history_checked ON provider_health_history(checked_at);
`,
};
