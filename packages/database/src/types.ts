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
