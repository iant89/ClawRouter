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
 * Phase 16 (spec §35): indexes for the filters the console offers, found with
 * `bun run bench:db` (500k requests, 300k audit records).
 *
 * - Requests by model compare case-insensitively, which the old `requests_model`
 *   index (default collation) could not serve: both model columns get NOCASE
 *   indexes. Requests by provider had no index.
 * - Audit by resource id or request id had no index; the resource filter's options
 *   (`SELECT DISTINCT resource`) read the whole table on every page load.
 * - Audit free text (`LIKE '%…%'` over actor, resource id, IP, request id and
 *   metadata) read every row to count matches. `audit_fts` is a trigram full-text
 *   index of those columns (external content: the text stays in `audit_log` only),
 *   kept in step by triggers and filled from existing records here.
 * - API keys by owner (My API keys, a disabled owner's keys).
 */
export const m0017PerformanceIndexes: Migration = {
  id: '0017_performance_indexes',
  up: `
DROP INDEX requests_model;
CREATE INDEX requests_model ON requests(model_ref COLLATE NOCASE, received_at);
CREATE INDEX requests_requested_model ON requests(requested_model COLLATE NOCASE, received_at);
CREATE INDEX requests_provider ON requests(provider_id, received_at);

CREATE INDEX audit_log_resource ON audit_log(resource, timestamp);
CREATE INDEX audit_log_resource_id ON audit_log(resource_id, timestamp);
CREATE INDEX audit_log_request_id ON audit_log(request_id);

CREATE INDEX api_keys_created_by ON api_keys(created_by);

CREATE VIRTUAL TABLE audit_fts USING fts5(
  actor_name, resource_id, ip, request_id, metadata,
  content = 'audit_log', content_rowid = 'rowid', tokenize = 'trigram'
);
CREATE TRIGGER audit_fts_insert AFTER INSERT ON audit_log BEGIN
  INSERT INTO audit_fts(rowid, actor_name, resource_id, ip, request_id, metadata)
  VALUES (new.rowid, new.actor_name, new.resource_id, new.ip, new.request_id, new.metadata);
END;
CREATE TRIGGER audit_fts_delete AFTER DELETE ON audit_log BEGIN
  INSERT INTO audit_fts(audit_fts, rowid, actor_name, resource_id, ip, request_id, metadata)
  VALUES ('delete', old.rowid, old.actor_name, old.resource_id, old.ip, old.request_id, old.metadata);
END;
INSERT INTO audit_fts(audit_fts) VALUES ('rebuild');
`,
};
