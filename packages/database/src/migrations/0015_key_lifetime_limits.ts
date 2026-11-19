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
 * Maximum API key lifetime per provider and per model (owner's request). NULL:
 * no limit. A model's effective limit is the stricter of its own and its
 * provider's. Keys for specific models must expire within it, and a key older
 * than the limit can no longer use the model.
 */
export const m0015KeyLifetimeLimits: Migration = {
  id: '0015_key_lifetime_limits',
  up: `
ALTER TABLE providers ADD COLUMN max_key_lifetime_hours INTEGER CHECK (max_key_lifetime_hours IS NULL OR max_key_lifetime_hours > 0);
ALTER TABLE models ADD COLUMN max_key_lifetime_hours INTEGER CHECK (max_key_lifetime_hours IS NULL OR max_key_lifetime_hours > 0);
`,
};
