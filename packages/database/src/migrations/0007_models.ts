import type { Migration } from '../migrations.ts';

/**
 * Model registry (spec §9, §30 MODELS). Models belong to a provider and are
 * removed with it. `availability` is the model's own state (offered by the
 * provider or not), separate from the provider's status.
 */
export const m0007Models: Migration = {
  id: '0007_models',
  up: `
CREATE TABLE models (
  id                      TEXT PRIMARY KEY,
  provider_id             TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  provider_model_id       TEXT NOT NULL,
  display_name            TEXT NOT NULL,
  capabilities            TEXT NOT NULL DEFAULT '[]',
  context_length          INTEGER,
  max_output_tokens       INTEGER,
  enabled                 INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  availability            TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (availability IN ('AVAILABLE', 'UNAVAILABLE', 'UNKNOWN')),
  availability_checked_at TEXT,
  source                  TEXT NOT NULL CHECK (source IN ('DISCOVERED', 'MANUAL')),
  cost_input_per_mtok     REAL,
  cost_output_per_mtok    REAL,
  cost_currency           TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE (provider_id, provider_model_id)
) STRICT;

CREATE INDEX models_provider ON models(provider_id);
CREATE INDEX models_display_name ON models(display_name COLLATE NOCASE);
`,
};
