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

// SEC-027: the corpus keeps its shape: every class has a file and a case, every case exactly one
// test, every test here a case.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CASES, CLASSES } from './registry.ts';

const files = readdirSync(import.meta.dir).filter((f) => f.endsWith('.test.ts') && f !== 'corpus.test.ts');
const source = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8');
// Test titles that start with a case id: test('CASE-012: ...' or test.each(...)('CASE-012: ...
const titled = (f: string) => [...source(f).matchAll(/\btest(?:\.each\([\s\S]*?\))?\(\s*['"`](CASE-\d{3})\b/g)].map((m) => m[1]!);

describe('security regression corpus (SEC-027)', () => {
  test('ids are unique, in order, and never reused', () => {
    expect(CASES.map((c) => c.id)).toEqual(CASES.map((_, i) => `CASE-${String(i + 1).padStart(3, '0')}`));
  });

  test('every class the roadmap names has a file and at least one case', () => {
    expect(files.map((f) => f.replace('.test.ts', '')).sort()).toEqual([...CLASSES].sort());
    for (const c of CLASSES) expect([c, CASES.some((x) => x.class === c)]).toEqual([c, true]);
  });

  test('every case has exactly one test, in its class file', () => {
    for (const c of CASES) {
      const where = files.flatMap((f) => titled(f).filter((id) => id === c.id).map(() => f));
      expect([c.id, where]).toEqual([c.id, [`${c.class}.test.ts`]]);
    }
  });

  test('every test in the corpus belongs to a registered case', () => {
    const ids = new Set(CASES.map((c) => c.id));
    for (const f of files) {
      const tests = [...source(f).matchAll(/^\s*test(?:\.each\([\s\S]*?\))?\(\s*['"`]([^'"`]*)/gm)].map((m) => m[1]!);
      for (const t of tests) expect([f, t, ids.has(t.slice(0, 8))]).toEqual([f, t, true]);
    }
  });

  test('a found vulnerability says when, how it was found and what fixed it', () => {
    for (const c of CASES.filter((x) => x.origin.kind === 'found')) {
      const o = c.origin as { date: string; foundBy: string; fix: string };
      expect([c.id, /^\d{4}-\d{2}-\d{2}$/.test(o.date), o.foundBy.length > 5, o.fix.length > 15]).toEqual([c.id, true, true, true]);
    }
    expect(CASES.filter((c) => c.origin.kind === 'found').length).toBeGreaterThan(0);
  });
});
