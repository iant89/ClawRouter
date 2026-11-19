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
