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

/**
 * Data-access abstraction. Domain code depends on repository interfaces, and
 * repository implementations depend on this interface, never on `bun:sqlite`
 * directly. A PostgreSQL implementation can be added later behind the same
 * contract (with async variants where needed).
 */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array;
export type SqlParams = readonly SqlValue[] | Record<string, SqlValue>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Database {
  /** Engine name, for diagnostics (e.g. "sqlite"). */
  readonly dialect: 'sqlite';
  all<T>(sql: string, params?: SqlParams): T[];
  get<T>(sql: string, params?: SqlParams): T | undefined;
  run(sql: string, params?: SqlParams): RunResult;
  /** Executes one or more statements without parameters (migrations). */
  exec(sql: string): void;
  /** Runs `fn` in a transaction; rolls back if it throws. */
  transaction<T>(fn: (db: Database) => T): T;
  /** Cheap liveness probe; throws if the database is unusable. */
  ping(): void;
  close(): void;
}
