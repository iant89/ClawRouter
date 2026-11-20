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
 * Writes the software bill of materials (SEC-019) for the current checkout:
 *
 *   bun run sbom              clawrouter-<version>.spdx.json and .cdx.json in sbom/
 *   bun run sbom --out <dir>
 *
 * Releases include both (bun run release).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readLockfile } from './supply-chain/lockfile.ts';
import { artifactNames } from './supply-chain/release.ts';
import { components, cycloneDx, sbomInput, spdx } from './supply-chain/sbom.ts';

const root = resolve(import.meta.dir, '..');
const i = process.argv.indexOf('--out');
const out = resolve(root, i >= 0 ? process.argv[i + 1] ?? 'sbom' : 'sbom');
const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: root, stdout: 'pipe' }).stdout.toString().trim();
const commit = process.env.GITHUB_SHA || git('rev-parse', 'HEAD');
const timestamp = Number(process.env.SOURCE_DATE_EPOCH || git('log', '-1', '--format=%ct', commit));

const input = sbomInput(root, readLockfile(root), commit, timestamp);
const comps = components(input);
const names = artifactNames(input.version);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, names.spdx), `${JSON.stringify(spdx(input, comps), null, 2)}\n`);
writeFileSync(join(out, names.cyclonedx), `${JSON.stringify(cycloneDx(input, comps), null, 2)}\n`);
const runtime = comps.filter((c) => c.scope === 'runtime');
console.log(`ClawRouter ${input.version}: ${runtime.length} runtime and ${comps.length - runtime.length} development dependencies, Bun ${input.bunVersion}, SQLite ${input.sqliteVersion}.`);
for (const c of runtime) console.log(`  runtime  ${c.name}@${c.version} (${c.license})`);
console.log(`Written to ${join(out, names.spdx)} and ${names.cyclonedx}.`);
