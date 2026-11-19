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
 * Client notices (owner request, 2026-11-17): announcements written by administrators,
 * which users (key owners) received them and when, and whether each API key accepts
 * notices at the start of replies (on by default; off for scripts that parse replies).
 */
export const m0024ClientNotices: Migration = {
  id: '0024_client_notices',
  up: `
    ALTER TABLE api_keys ADD COLUMN reply_notices INTEGER NOT NULL DEFAULT 1 CHECK (reply_notices IN (0, 1));

    CREATE TABLE announcements (
      id          TEXT PRIMARY KEY,
      message     TEXT NOT NULL,
      frequency   TEXT NOT NULL CHECK (frequency IN ('every_request', 'once', 'daily', 'weekly')),
      channel     TEXT NOT NULL CHECK (channel IN ('both', 'header', 'reply')),
      starts_at   TEXT,
      expires_at  TEXT,
      time_zone   TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at  TEXT NOT NULL,
      created_by  TEXT,
      updated_at  TEXT NOT NULL
    );

    -- One row per announcement and recipient (the key's owner, or the key when it has none).
    CREATE TABLE announcement_deliveries (
      announcement_id TEXT NOT NULL REFERENCES announcements (id) ON DELETE CASCADE,
      recipient       TEXT NOT NULL,
      first_at        TEXT NOT NULL,
      last_at         TEXT NOT NULL,
      count           INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (announcement_id, recipient)
    );
  `,
};
