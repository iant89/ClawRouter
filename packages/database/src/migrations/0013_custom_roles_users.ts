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
 * Custom roles and user management (phase 14).
 *
 * `role_permissions` holds the permissions of custom roles only: built-in roles
 * (ADMIN, OPERATOR, VIEWER) keep theirs in code, so new permissions reach them
 * without a data migration and they cannot be edited.
 * `users.must_change_password` is set when an administrator gives a user a
 * temporary password; the user must choose a new one at their next sign-in.
 */
export const m0013CustomRolesUsers: Migration = {
  id: '0013_custom_roles_users',
  up: `
CREATE TABLE role_permissions (
  role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
) STRICT;

ALTER TABLE roles ADD COLUMN updated_at TEXT;

ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1));
`,
};
