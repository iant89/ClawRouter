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
 * Whether an API key may use ClawRouter's MCP server (/v1/mcp), which answers
 * with its owner's permissions. Off for every existing key: a key made for the
 * gateway must not start reading administration data.
 */
export const m0021ApiKeyMcpAccess: Migration = {
  id: '0021_api_key_mcp_access',
  up: `ALTER TABLE api_keys ADD COLUMN mcp_access INTEGER NOT NULL DEFAULT 0 CHECK (mcp_access IN (0, 1));`,
};
