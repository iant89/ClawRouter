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
 * RBAC (spec §16, §30 ROLES / USER_ROLES). Built-in role permissions are defined
 * in code (packages/authorization) so new permissions reach them without a data
 * migration; this table records which roles exist and who holds them.
 *
 * Existing installations: the initial administrator (the actor of
 * SETUP_COMPLETED, else the oldest user) becomes ADMIN. Every other existing
 * user starts with no role, which grants nothing (fail closed).
 */
export const m0004Roles: Migration = {
  id: '0004_roles',
  up: `
CREATE TABLE roles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  built_in    INTEGER NOT NULL DEFAULT 0 CHECK (built_in IN (0, 1)),
  created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE user_roles (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL,
  assigned_by TEXT,
  PRIMARY KEY (user_id, role_id)
) STRICT;

CREATE INDEX user_roles_role_id ON user_roles(role_id);

INSERT INTO roles (id, name, description, built_in, created_at) VALUES
  ('ADMIN', 'Administrator', 'Full access to every part of ClawRouter.', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('OPERATOR', 'Operator', 'Runs the gateway: providers, models, routing, health, logs, audit, requests and usage.', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('VIEWER', 'Viewer', 'Read-only access to gateway configuration and activity.', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO user_roles (user_id, role_id, assigned_at, assigned_by)
SELECT id, 'ADMIN', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
FROM users
WHERE id = COALESCE(
  (SELECT actor_id FROM audit_log WHERE action = 'SETUP_COMPLETED' AND actor_id IS NOT NULL ORDER BY timestamp LIMIT 1),
  (SELECT id FROM users ORDER BY created_at, id LIMIT 1)
);
`,
};
