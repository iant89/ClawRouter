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
 * Software bill of materials (SEC-019): writes clawrouter-<version>.spdx.json (SPDX 2.3)
 * and clawrouter-<version>.cdx.json (CycloneDX 1.6) from bun.lock and the installed
 * packages. Every release carries both (bun run release:package writes them).
 *
 *   bun run sbom                  into release/
 *   bun run sbom --out <dir>      somewhere else
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadLockfile, loadPolicy, thirdPartyPackages } from './supply-chain/packages.ts';
import { artifactNames, currentCommit, sourceDateEpoch } from './supply-chain/release.ts';
import { currentRuntime, cyclonedx, sbomText, spdx, type SbomInput } from './supply-chain/sbom.ts';

const root = join(import.meta.dir, '..');

export function writeSboms(out: string): string[] {
  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  const commit = currentCommit(root);
  const input: SbomInput = {
    version, ...(commit ? { commit } : {}),
    created: new Date(sourceDateEpoch(root) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    packages: thirdPartyPackages(root, loadLockfile(root), loadPolicy(root)),
    runtime: currentRuntime(),
  };
  mkdirSync(out, { recursive: true });
  const names = artifactNames(version);
  writeFileSync(join(out, names.spdx), sbomText(spdx(input)));
  writeFileSync(join(out, names.cyclonedx), sbomText(cyclonedx(input)));
  return [join(out, names.spdx), join(out, names.cyclonedx)];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1]! : join(root, 'release');
  for (const f of writeSboms(out)) console.log(`Wrote ${f}`);
}
