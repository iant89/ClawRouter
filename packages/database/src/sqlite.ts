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

import { Database as BunSqlite } from 'bun:sqlite';
import { dirname } from 'node:path';
import { AppError, createPrivateFile, makePrivateDir, tightenMode } from '@clawrouter/core';
import type { Database, RunResult, SqlParams } from './types.ts';

export interface SqliteOptions {
  /** File path or `:memory:`. Parent directories are created. */
  path: string;
  readonly?: boolean;
  /**
   * Called with the files whose group/other permissions were removed on open (SEC-023):
   * a database left readable by other users, e.g. one created by an older version.
   */
  onTightened?: (files: string[]) => void;
}

function bind(params: SqlParams | undefined): never[] {
  if (params === undefined) return [];
  // bun:sqlite accepts either positional values or a single named-parameter object.
  return (Array.isArray(params) ? params : [params]) as never[];
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = (error as { code?: string }).code ?? '';
    if (code.startsWith('SQLITE_CONSTRAINT')) throw new AppError('CONFLICT', undefined, { cause: error });
    throw new AppError('DATABASE_ERROR', undefined, { cause: error });
  }
}

export function openSqlite(options: SqliteOptions): Database {
  if (options.path !== ':memory:' && !options.readonly) {
    // SEC-023: the database (and so its -wal and -shm files, which SQLite creates with the
    // database's mode) is private to this account. A new directory is 0700; an existing one is
    // the operator's choice (`bun run doctor` reports it).
    makePrivateDir(dirname(options.path));
    if (!createPrivateFile(options.path)) {
      const tightened = ['', '-wal', '-shm'].map((ext) => options.path + ext).filter((file) => tightenMode(file));
      if (tightened.length) options.onTightened?.(tightened);
    }
  }
  const raw = new BunSqlite(options.path, { create: !options.readonly, readonly: options.readonly ?? false, strict: true });

  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');
  if (options.path !== ':memory:' && !options.readonly) {
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA synchronous = NORMAL');
  }

  const db: Database = {
    dialect: 'sqlite',
    all: <T>(sql: string, params?: SqlParams) => wrap(() => raw.query(sql).all(...bind(params)) as T[]),
    get: <T>(sql: string, params?: SqlParams) => wrap(() => (raw.query(sql).get(...bind(params)) ?? undefined) as T | undefined),
    run: (sql, params): RunResult =>
      wrap(() => {
        const result = raw.query(sql).run(...bind(params));
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
      }),
    exec: (sql) => wrap(() => raw.exec(sql)),
    transaction: <T>(fn: (tx: Database) => T): T => wrap(() => raw.transaction(() => fn(db))()),
    ping: () => {
      wrap(() => raw.query('SELECT 1').get());
    },
    close: () => raw.close(),
  };
  return db;
}
