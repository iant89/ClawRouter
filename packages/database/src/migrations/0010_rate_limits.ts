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
