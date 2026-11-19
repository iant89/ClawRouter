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
 * Cost limits (SEC-005) read the money spent this hour, day and month per API key,
 * model and provider from `usage_records` before requests. These indexes keep those
 * sums fast (per user already has `usage_records_user`; the whole gateway uses the
 * primary key, which starts with the hour).
 */
export const m0027CostLimitIndexes: Migration = {
  id: '0027_cost_limit_indexes',
  up: `
CREATE INDEX usage_records_key ON usage_records(api_key_id, hour);
CREATE INDEX usage_records_model ON usage_records(model_ref, hour);
CREATE INDEX usage_records_provider ON usage_records(provider_id, hour);
`,
};
