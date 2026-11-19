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
 * The playground became a permission, `playground.use` (owner request, 2026-11-19).
 * Everyone could open it before, so every existing custom role gets the permission and
 * nobody loses the playground on upgrade. Built-in roles keep theirs in code.
 */
export const m0026PlaygroundPermission: Migration = {
  id: '0026_playground_permission',
  up: `INSERT OR IGNORE INTO role_permissions (role_id, permission) SELECT id, 'playground.use' FROM roles WHERE built_in = 0;`,
};
