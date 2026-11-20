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
 * Dependency security (SEC-018). CI runs all three; each can run alone.
 *
 *   bun run deps:check              lockfile, licenses and known vulnerabilities
 *   bun run deps:check lockfile     sources and integrity hashes in bun.lock, exact versions, no install scripts
 *   bun run deps:check licenses     every package's license is allowed by supply-chain.json
 *   bun run deps:check audit        bun audit: high and critical advisories fail (supply-chain.json "audit")
 *   bun run deps:check audit --report <file>   evaluate a saved "bun audit --json" report instead
 *
 * The policy is supply-chain.json. Exits 1 when a check fails.
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { checkLicenses, checkLockfile, evaluateAudit, type CheckResult } from './supply-chain/checks.ts';
import { loadLockfile, loadPolicy, thirdPartyPackages } from './supply-chain/packages.ts';

const root = join(import.meta.dir, '..');
const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--report');
const report = args.includes('--report') ? args[args.indexOf('--report') + 1] : undefined;
const policy = loadPolicy(root);
const lock = loadLockfile(root);

function audit(): CheckResult {
  if (report) return evaluateAudit(JSON.parse(readFileSync(report, 'utf8')), policy);
  const r = Bun.spawnSync(['bun', 'audit', '--json'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const out = r.stdout.toString().trim();
  // No advisories: exit 0 and an empty object (or nothing). Advisories: exit 1 and the report.
  if (r.exitCode === 0 && (!out || out === '{}')) return { problems: [], notes: ['bun audit: no advisories.'] };
  try {
    return evaluateAudit(JSON.parse(out), policy);
  } catch {
    return { problems: [`bun audit failed (${r.exitCode}): ${(r.stderr.toString() || out).trim().slice(0, 500)}`], notes: [] };
  }
}

const checks: Record<string, () => CheckResult> = {
  lockfile: () => checkLockfile(root, lock, policy),
  licenses: () => checkLicenses(thirdPartyPackages(root, lock, policy), policy),
  audit,
};
if (only && !checks[only]) {
  console.error(`Unknown check "${only}". Use: ${Object.keys(checks).join(', ')}.`);
  process.exit(2);
}
let failed = false;
for (const [name, check] of Object.entries(checks)) {
  if (only && name !== only) continue;
  const { problems, notes } = check();
  console.log(`${problems.length ? '✖' : '✔'} ${name}`);
  for (const n of notes) console.log(`    ${n}`);
  for (const p of problems) console.log(`  ✖ ${p}`);
  failed ||= problems.length > 0;
}
process.exit(failed ? 1 : 0);
