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
 * Dependency security check (SEC-018), run in CI on every push and weekly:
 *
 *   bun run deps:check              lockfile, licenses, Bun pins and vulnerabilities
 *   bun run deps:check --offline    everything but the vulnerability audit (needs the registry)
 *
 * Fails on lockfile problems, disallowed licenses and high or critical advisories; lower
 * advisories are printed as warnings. The policy is scripts/supply-chain/policy.ts.
 */
import { resolve } from 'node:path';
import { judgeAudit, runAudit } from './supply-chain/audit.ts';
import { checkLicenses } from './supply-chain/licenses.ts';
import { checkBunPins, checkLockfile, readLockfile } from './supply-chain/lockfile.ts';

const root = resolve(import.meta.dir, '..');
const offline = process.argv.includes('--offline');
const annotate = process.env.GITHUB_ACTIONS === 'true';

const failures: string[] = [];
const warnings: string[] = [];
const section = (name: string, problems: string[]) => {
  console.log(`${problems.length ? '✗' : '✓'} ${name}`);
  failures.push(...problems);
};

const lock = readLockfile(root);
section(`lockfile (${lock.packages.filter((p) => p.source.kind !== 'workspace').length} packages, all pinned by sha512)`, checkLockfile(root, lock));
section('Bun version pins agree', checkBunPins(root));
section('licenses', checkLicenses(root, lock));
if (offline) {
  console.log('- vulnerability audit skipped (--offline)');
} else {
  try {
    const result = judgeAudit(runAudit(root), new Date());
    section(`vulnerabilities (high and critical fail)`, result.failures);
    warnings.push(...result.warnings);
  } catch (e) {
    section('vulnerabilities', [(e as Error).message]);
  }
}

for (const w of warnings) console.log(annotate ? `::warning title=Dependency advisory::${w}` : `  warning: ${w}`);
if (failures.length) {
  for (const f of failures) console.error(annotate ? `::error title=Dependency check::${f}` : `  ${f}`);
  console.error(`Dependency check failed (${failures.length} problem${failures.length === 1 ? '' : 's'}). See docs/supply-chain.md.`);
  process.exit(1);
}
console.log('Dependency check passed.');
