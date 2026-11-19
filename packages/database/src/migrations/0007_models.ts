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
