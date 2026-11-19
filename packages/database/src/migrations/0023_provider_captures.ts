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
 * Provider captures (owner request, 2026-11-17): the full exchange of a gateway
 * request with its providers, kept when something went wrong (or on request) so it
 * can be exported for a developer. Kept until deleted, capped by count (setting
 * capturesMaxCount). `data` holds the bodies and headers as JSON; credentials are
 * removed before anything is written.
 */
export const m0023ProviderCaptures: Migration = {
  id: '0023_provider_captures',
  up: `
    CREATE TABLE provider_captures (
      id              TEXT PRIMARY KEY,
      created_at      TEXT NOT NULL,
      trigger         TEXT NOT NULL CHECK (trigger IN ('error', 'parse_error', 'manual')),
      request_id      TEXT NOT NULL,
      endpoint        TEXT NOT NULL,
      stream          INTEGER NOT NULL DEFAULT 0,
      requested_model TEXT NOT NULL,
      model_ref       TEXT,
      provider_id     TEXT,
      provider_name   TEXT,
      status          TEXT NOT NULL,
      http_status     INTEGER NOT NULL,
      error_code      TEXT,
      error_message   TEXT,
      exchange_count  INTEGER NOT NULL,
      size_bytes      INTEGER NOT NULL,
      data            TEXT NOT NULL
    );
    CREATE INDEX provider_captures_created ON provider_captures (created_at DESC, id DESC);
  `,
};
