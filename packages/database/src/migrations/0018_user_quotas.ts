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
