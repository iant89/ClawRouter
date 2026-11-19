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
