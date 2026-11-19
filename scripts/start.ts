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
 * Runs the production bundle built by `bun run build`.
 *
 * Bun resolves the bundled console assets relative to the working directory,
 * so the server runs from dist/. Relative paths in the environment (e.g.
 * CLAWROUTER_DATABASE_PATH) are resolved against the project root first so they
 * mean the same thing as in development.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'main.js'))) {
  console.error('dist/main.js not found. Run `bun run build` first.');
  process.exit(1);
}

const dbPath = process.env.CLAWROUTER_DATABASE_PATH ?? './data/clawrouter.db';
const env = {
  ...process.env,
  CLAWROUTER_ENV: process.env.CLAWROUTER_ENV ?? 'production',
  CLAWROUTER_DATABASE_PATH: dbPath === ':memory:' || isAbsolute(dbPath) ? dbPath : resolve(root, dbPath),
};

const child = Bun.spawn(['bun', 'main.js'], { cwd: dist, env, stdio: ['inherit', 'inherit', 'inherit'] });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
