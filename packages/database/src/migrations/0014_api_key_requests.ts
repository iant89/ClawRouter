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
 * API key requests: a user without permission to create keys asks for one; a
 * user with `api_keys.write` approves or denies; the requester then creates the
 * key themselves (the secret is never stored, and never seen by the approver).
 * `expiry` is the requested expiry as JSON (e.g. {"type":"after","hours":168}),
 * resolved when the key is created.
 */
export const m0014ApiKeyRequests: Migration = {
  id: '0014_api_key_requests',
  up: `
CREATE TABLE api_key_requests (
  id             TEXT PRIMARY KEY,
  requested_by   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  purpose        TEXT NOT NULL,
  allowed_models TEXT NOT NULL DEFAULT '[]',
  expiry         TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'DENIED', 'CANCELLED', 'FULFILLED')),
  created_at     TEXT NOT NULL,
  decided_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at     TEXT,
  decision_note  TEXT,
  api_key_id     TEXT REFERENCES api_keys(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX api_key_requests_status ON api_key_requests (status, created_at);
CREATE INDEX api_key_requests_requester ON api_key_requests (requested_by, created_at);
`,
};
