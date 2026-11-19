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

/** Security audit trail (spec §28). Metadata is JSON and never contains secrets. */
export const m0003AuditLog: Migration = {
  id: '0003_audit_log',
  up: `
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  timestamp   TEXT NOT NULL,
  actor_id    TEXT,
  actor_name  TEXT,
  action      TEXT NOT NULL,
  resource    TEXT,
  resource_id TEXT,
  result      TEXT NOT NULL CHECK (result IN ('SUCCESS', 'FAILURE')),
  ip          TEXT,
  request_id  TEXT,
  metadata    TEXT
) STRICT;

CREATE INDEX audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX audit_log_action ON audit_log(action, timestamp);
CREATE INDEX audit_log_actor ON audit_log(actor_id, timestamp);
`,
};
