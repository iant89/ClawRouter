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
 * Routing configuration (spec §10, §30 ROUTING_RULES): one versioned JSON
 * document holding the default policy and the model aliases. A single row keeps
 * saves atomic and makes optimistic concurrency (the version) trivial.
 */
export const m0008Routing: Migration = {
  id: '0008_routing',
  up: `
CREATE TABLE routing_config (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  document   TEXT NOT NULL,
  version    INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
) STRICT;
`,
};
