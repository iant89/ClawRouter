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
 * Each user's console theme (owner request, 2026-11-17): light, dark or system
 * (follow the device). Null means the default, dark (spec §18).
 */
export const m0022UserTheme: Migration = {
  id: '0022_user_theme',
  up: `ALTER TABLE users ADD COLUMN theme TEXT CHECK (theme IN ('light', 'dark', 'system'));`,
};
