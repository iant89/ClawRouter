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

/** The Logs page's vocabulary (spec §27). Records are redacted before they are stored. */
export const LOG_LEVEL_NAMES = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevelName = (typeof LOG_LEVEL_NAMES)[number];

/** One record from the server's recent-log buffer. */
export interface LogEntry {
  seq: number;
  time: string;
  level: LogLevelName;
  msg: string;
  component: string | null;
  requestId: string | null;
  providerId: string | null;
  userId: string | null;
  /** Every other field of the record. */
  fields: Record<string, unknown>;
}

/** GET /api/logs filters. */
export interface LogQuery {
  /** Minimum level. */
  level?: LogLevelName;
  component?: string;
  requestId?: string;
  providerId?: string;
  userId?: string;
  /** Case-insensitive text in the message or any field. */
  q?: string;
  /** Records older than this sequence number (load older). */
  before?: number;
  /** Records newer than this sequence number (follow). */
  after?: number;
  limit?: number;
}

/** GET /api/logs */
export interface LogPage {
  /** Newest first. */
  items: LogEntry[];
  /** Whether older matching records may exist (pass the last item's seq as `before`). */
  hasOlder: boolean;
  /** Newest sequence number in the buffer (follow from here). */
  latestSeq: number;
  /** Time of the oldest record still held. */
  oldestTime: string | null;
  /** How many records the buffer holds at most. */
  capacity: number;
  /** Components seen in the buffer, for the filter. */
  components: string[];
}
