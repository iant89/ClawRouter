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
