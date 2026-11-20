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

// SEC-012: the security regression suite keeps its shape. Every category in the roadmap has a
// folder with at least one test file, and nothing is left loose at the top level.

import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const CATEGORIES = [
  'authentication', 'authorization', 'sessions', 'csrf', 'api-keys', 'rate-limits', 'mcp',
  'ssrf', 'backup', 'restore', 'logging', 'websocket', 'provider', 'configuration', 'fuzz', 'filesystem',
] as const;

describe('security regression suite layout (SEC-012)', () => {
  test('every category has tests', () => {
    for (const c of CATEGORIES) {
      const files = readdirSync(join(import.meta.dir, c)).filter((f) => f.endsWith('.test.ts'));
      expect([c, files.length > 0]).toEqual([c, true]);
    }
  });

  test('no other folders, and no tests outside a category', () => {
    const entries = readdirSync(import.meta.dir);
    const dirs = entries.filter((e) => statSync(join(import.meta.dir, e)).isDirectory()).sort();
    expect(dirs).toEqual([...CATEGORIES].sort());
    expect(entries.filter((e) => e.endsWith('.test.ts'))).toEqual(['suite.test.ts']);
  });
});
