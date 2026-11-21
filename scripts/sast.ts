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
 * Static analysis (SEC-026). Exits 1 on a critical finding, an unwaived high one or a stale
 * waiver; medium findings are printed only.
 *
 *   bun run sast                 the shipped source (apps, packages, scripts; not tests)
 *   bun run sast --json <file>   also write the report as JSON
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RULES, runSast } from './security/sast.ts';

const root = join(import.meta.dir, '..');
const args = process.argv.slice(2);
const report = runSast(root);
if (args.includes('--json')) writeFileSync(args[args.indexOf('--json') + 1]!, `${JSON.stringify({ rules: RULES.map(({ id, severity, description }) => ({ id, severity, description })), ...report }, null, 2)}\n`);

const counts = (s: string) => report.findings.filter((f) => f.severity === s).length;
console.log(`SAST: ${report.files} files, ${RULES.length} rules; ${counts('critical')} critical, ${counts('high')} high, ${counts('medium')} medium.`);
for (const f of report.findings) {
  const mark = report.blocking.includes(f) ? '✖' : f.waived ? '~' : '·';
  console.log(`  ${mark} [${f.severity}] ${f.rule} ${f.file}:${f.line}: ${f.message}${f.waived ? ` (waived: ${f.waived})` : ''}`);
}
for (const w of report.unusedWaivers) console.log(`  ✖ ${w}`);
if (report.blocking.length || report.unusedWaivers.length) {
  console.error(`SAST failed: ${report.blocking.length} blocking finding(s), ${report.unusedWaivers.length} stale waiver(s). Fix them, or waive a high finding with "// security-waiver: <rule> -- <reason>".`);
  process.exit(1);
}
console.log('SAST passed.');
