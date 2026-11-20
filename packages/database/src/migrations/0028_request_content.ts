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
 * Request logging modes (SEC-009). With request logging set to Full, a request's
 * prompt and reply are kept here, apart from its metadata row, as one JSON document
 * (at most about 1 MB). Deleted with the request (request history retention).
 */
export const m0028RequestContent: Migration = {
  id: '0028_request_content',
  up: `
CREATE TABLE request_content (
  request_id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  stored_at TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  content TEXT NOT NULL
);
`,
};
