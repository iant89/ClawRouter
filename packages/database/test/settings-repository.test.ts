import { describe, expect, test } from 'bun:test';
import { createSqliteSettingsRepository, migrations, openSqlite, runMigrations } from '../src/index.ts';

function repo() {
  const db = openSqlite({ path: ':memory:' });
  runMigrations(db, migrations);
  return createSqliteSettingsRepository(db, () => new Date('2026-01-01T00:00:00Z'));
}

describe('settings repository', () => {
  test('stores and reads JSON values', () => {
    const r = repo();
    r.set('payload.retention_days', 7);
    r.set('ui.banner', { text: 'hi', on: true });
    expect(r.get('payload.retention_days')).toEqual({ key: 'payload.retention_days', value: 7, updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(r.list().map((s) => s.key)).toEqual(['payload.retention_days', 'ui.banner']);
  });

  test('upserts', () => {
    const r = repo();
    r.set('a', 1);
    r.set('a', 2);
    expect(r.get('a')?.value).toBe(2);
  });

  test('deletes', () => {
    const r = repo();
    r.set('a', 1);
    expect(r.delete('a')).toBe(true);
    expect(r.delete('a')).toBe(false);
    expect(r.get('a')).toBeUndefined();
  });

  test('validates keys', () => {
    expect(() => repo().set('Bad Key', 1)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});
