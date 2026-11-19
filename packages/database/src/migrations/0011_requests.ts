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
 * Request history and usage records (spec §22, §23, §30 REQUESTS, USAGE_RECORDS).
 *
 * `requests` holds one row per gateway request: metadata only, never prompts or
 * completions. Rows are pruned after the request retention period.
 * `usage_records` holds hourly totals per API key and model, kept much longer, so
 * usage reports survive the pruning of request detail.
 * No foreign keys: history must outlive deleted keys, users, models and providers;
 * names are joined when present.
 */
export const m0011Requests: Migration = {
  id: '0011_requests',
  up: `
CREATE TABLE requests (
  id              TEXT PRIMARY KEY,
  received_at     TEXT NOT NULL,
  completed_at    TEXT,
  status          TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  stream          INTEGER NOT NULL,
  api_key_id      TEXT,
  user_id         TEXT,
  requested_model TEXT NOT NULL,
  model_ref       TEXT,
  provider_id     TEXT,
  duration_ms     INTEGER,
  http_status     INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,
  retries         INTEGER NOT NULL DEFAULT 0,
  failovers       INTEGER NOT NULL DEFAULT 0,
  attempt_log     TEXT NOT NULL DEFAULT '[]',
  error_code      TEXT,
  error_message   TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  usage_source    TEXT NOT NULL DEFAULT 'none',
  cost_usd        REAL
) STRICT;

CREATE INDEX requests_received_at ON requests(received_at);
CREATE INDEX requests_status ON requests(status, received_at);
CREATE INDEX requests_api_key ON requests(api_key_id, received_at);
CREATE INDEX requests_model ON requests(model_ref, received_at);

CREATE TABLE usage_records (
  hour              TEXT NOT NULL,
  api_key_id        TEXT NOT NULL,
  user_id           TEXT,
  model_ref         TEXT NOT NULL,
  provider_id       TEXT NOT NULL,
  requests          INTEGER NOT NULL DEFAULT 0,
  errors            INTEGER NOT NULL DEFAULT 0,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  estimated_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  unpriced_requests INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, api_key_id, model_ref, provider_id)
) STRICT;

CREATE INDEX usage_records_hour ON usage_records(hour);
`,
};
