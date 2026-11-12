import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '@clawapi/core';
import { migrationStatus, migrations, openSqlite, runMigrations, type Migration } from '../src/index.ts';

const fresh = () => openSqlite({ path: ':memory:' });

describe('migrations', () => {
  test('applies all migrations once and is idempotent', () => {
    const db = fresh();
    expect(runMigrations(db, migrations)).toEqual(migrations.map((m) => m.id));
    expect(runMigrations(db, migrations)).toEqual([]);
    expect(migrationStatus(db, migrations).every((s) => s.appliedAt !== null)).toBe(true);
  });

  test('a failing migration rolls back and is not recorded', () => {
    const db = fresh();
    const bad: Migration[] = [
      { id: '0001_ok', up: 'CREATE TABLE a (id INTEGER)' },
      { id: '0002_bad', up: 'CREATE TABLE b (id INTEGER); THIS IS NOT SQL;' },
    ];
    expect(() => runMigrations(db, bad)).toThrow(AppError);
    expect(migrationStatus(db, bad).map((s) => s.appliedAt !== null)).toEqual([true, false]);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'b'")).toBeUndefined();
  });

  test('detects a migration edited after it was applied', () => {
    const db = fresh();
    runMigrations(db, [{ id: '0001_a', up: 'CREATE TABLE a (id INTEGER)' }]);
    expect(() => runMigrations(db, [{ id: '0001_a', up: 'CREATE TABLE a (id TEXT)' }])).toThrow(/modified/);
  });

  test('refuses a database from a newer version', () => {
    const db = fresh();
    runMigrations(db, [{ id: '0001_a', up: 'SELECT 1' }, { id: '0002_b', up: 'SELECT 1' }]);
    expect(() => runMigrations(db, [{ id: '0001_a', up: 'SELECT 1' }])).toThrow(/does not know/);
  });

  test('rejects duplicate or out-of-order ids', () => {
    const db = fresh();
    expect(() => runMigrations(db, [{ id: '0002_a', up: 'SELECT 1' }, { id: '0001_b', up: 'SELECT 1' }])).toThrow(/out of order/);
    expect(() => runMigrations(db, [{ id: 'bad id', up: 'SELECT 1' }])).toThrow(/Invalid/);
  });
});

describe('sqlite adapter', () => {
  test('maps constraint violations to CONFLICT and other failures to DATABASE_ERROR', () => {
    const db = fresh();
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    db.run('INSERT INTO t VALUES (?)', ['x']);
    expect(() => db.run('INSERT INTO t VALUES (?)', ['x'])).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(() => db.all('SELECT * FROM missing')).toThrow(expect.objectContaining({ code: 'DATABASE_ERROR' }));
  });

  test('transactions roll back on error', () => {
    const db = fresh();
    db.exec('CREATE TABLE t (id INTEGER)');
    expect(() => db.transaction((tx) => { tx.run('INSERT INTO t VALUES (1)'); throw new Error('stop'); })).toThrow();
    expect(db.all('SELECT * FROM t')).toEqual([]);
  });

  test('persists to a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clawapi-'));
    const path = join(dir, 'nested', 'clawapi.db');
    const a = openSqlite({ path });
    runMigrations(a, migrations);
    a.run("INSERT INTO settings (key, value, updated_at) VALUES ('k', '1', 'now')");
    a.close();
    const b = openSqlite({ path });
    expect(b.get<{ value: string }>("SELECT value FROM settings WHERE key = 'k'")?.value).toBe('1');
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
