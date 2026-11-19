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
 * Where a model's price came from: PROVIDER (published by the provider, kept up
 * to date automatically) or MANUAL (entered by an administrator, never overwritten).
 * Prices entered before this migration were typed in by hand.
 */
export const m0019ModelCostSource: Migration = {
  id: '0019_model_cost_source',
  up: `
ALTER TABLE models ADD COLUMN cost_source TEXT CHECK (cost_source IN ('PROVIDER', 'MANUAL'));
UPDATE models SET cost_source = 'MANUAL' WHERE cost_input_per_mtok IS NOT NULL OR cost_output_per_mtok IS NOT NULL;
`,
};
