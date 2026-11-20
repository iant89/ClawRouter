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
 * Writes the authorization matrix (SEC-014): tests/security/authorization/matrix.json
 * and docs/security/authorization-matrix.md, from the router and the built-in roles.
 * `--check` only compares and exits 1 when either file is out of date.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHarness } from '../tests/support/harness.ts';
import { buildMatrix, renderJson, renderMarkdown } from '../tests/security/authorization/matrix.ts';

const root = join(import.meta.dir, '..');
export const MATRIX_FILES = {
  json: join(root, 'tests/security/authorization/matrix.json'),
  markdown: join(root, 'docs/security/authorization-matrix.md'),
};

const matrix = buildMatrix(createHarness().api.router.list());
const wanted = { json: renderJson(matrix), markdown: renderMarkdown(matrix) };
const read = (path: string) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

if (process.argv.includes('--check')) {
  const stale = (Object.keys(wanted) as (keyof typeof wanted)[]).filter((k) => read(MATRIX_FILES[k]) !== wanted[k]);
  if (stale.length) {
    console.error(`Authorization matrix out of date: ${stale.map((k) => MATRIX_FILES[k]).join(', ')}. Run: bun run security:matrix`);
    process.exit(1);
  }
  console.log(`Authorization matrix up to date (${matrix.routes.length} routes).`);
} else {
  for (const k of Object.keys(wanted) as (keyof typeof wanted)[]) {
    mkdirSync(dirname(MATRIX_FILES[k]), { recursive: true });
    writeFileSync(MATRIX_FILES[k], wanted[k]);
  }
  console.log(`Wrote the authorization matrix (${matrix.routes.length} routes).`);
}
