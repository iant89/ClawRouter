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
 * Console notifications. A notification goes to one user (`user_id`) or to
 * every holder of a permission (`audience_permission`), evaluated when read so
 * role changes apply. Read/dismissed state is per user.
 */
export const m0005Notifications: Migration = {
  id: '0005_notifications',
  up: `
CREATE TABLE notifications (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT REFERENCES users(id) ON DELETE CASCADE,
  audience_permission TEXT,
  severity            TEXT NOT NULL CHECK (severity IN ('INFO', 'SUCCESS', 'WARNING', 'ERROR')),
  title               TEXT NOT NULL,
  body                TEXT,
  link                TEXT,
  source              TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  CHECK ((user_id IS NULL) <> (audience_permission IS NULL))
) STRICT;

CREATE INDEX notifications_user ON notifications(user_id, created_at);
CREATE INDEX notifications_audience ON notifications(audience_permission, created_at);
CREATE INDEX notifications_created ON notifications(created_at);

CREATE TABLE notification_receipts (
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         TEXT,
  dismissed_at    TEXT,
  PRIMARY KEY (notification_id, user_id)
) STRICT;
`,
};
