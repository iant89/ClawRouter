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
import { migrations, openSqlite, runMigrations } from '../src/index.ts';

describe('0017 performance indexes', () => {
  test('audit records written before the upgrade are searchable through the trigram index', () => {
    const db = openSqlite({ path: ':memory:' });
    const before = migrations.findIndex((m) => m.id === '0017_performance_indexes');
    runMigrations(db, migrations.slice(0, before));
    const insert = (id: string, actor: string, metadata: string) => db.run(
      `INSERT INTO audit_log (id, timestamp, actor_id, actor_name, action, result, metadata) VALUES (?, '2026-11-14T00:00:00.000Z', NULL, ?, 'SETTINGS_CHANGED', 'SUCCESS', ?)`,
      [id, actor, metadata],
    );
    insert('a1', 'ada', '{"note":"rotate the Backup key"}');
    insert('a2', 'sam', '{"note":"nothing"}');

    runMigrations(db, migrations);
    const match = (text: string) => db.all<{ id: string }>(
      'SELECT id FROM audit_log WHERE rowid IN (SELECT rowid FROM audit_fts WHERE audit_fts MATCH ?) ORDER BY id', [`"${text}"`]).map((r) => r.id);
    expect(match('backup KEY')).toEqual(['a1']);
    // New and deleted records keep the index in step.
    insert('a3', 'kim', '{"note":"backup restored"}');
    expect(match('backup')).toEqual(['a1', 'a3']);
    db.run("DELETE FROM audit_log WHERE id = 'a1'");
    expect(match('backup')).toEqual(['a3']);
    db.close();
  });
});
