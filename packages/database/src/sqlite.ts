import { Database as BunSqlite } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from '@clawapi/core';
import type { Database, RunResult, SqlParams } from './types.ts';

export interface SqliteOptions {
  /** File path or `:memory:`. Parent directories are created. */
  path: string;
  readonly?: boolean;
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
  if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
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
