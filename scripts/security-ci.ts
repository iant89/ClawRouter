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
 * The security CI pipeline (SEC-026). Every pull request, every push to main and every release
 * runs it (.github/workflows/security-pipeline.yml); run it locally before a pull request.
 *
 *   bun run security:ci                    every stage in order, then the summary
 *   bun run security:ci <stage>...         only these stages (CI runs one per step)
 *   bun run security:ci summary            the result of the stages run so far: fails when one
 *                                          failed or has no report
 *   --reports <dir>       where reports go (default security-reports/)
 *   --range <a>..<b>      secret scanning also reads these commits (a pull request's)
 *   --history             secret scanning also reads every commit
 *   --trivy <file>        a Trivy JSON report of the built image (container scanning)
 *
 * Stages: typecheck, unit, integration, security, dependencies, secrets, sast, container,
 * sbom, build. Exits 1 when a stage fails.
 */
import { appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resetReports, runStage, STAGES, writeSummary, type StageId } from './security/pipeline.ts';

const root = join(import.meta.dir, '..');
const args = process.argv.slice(2);
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const valued = new Set(['--reports', '--range', '--trivy']);
const words = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? ''));
const reports = resolve(root, value('--reports') ?? 'security-reports');
const ci = !!process.env.CI && process.env.CI !== 'false';
const options = {
  root, reports, ci,
  secrets: { range: value('--range'), history: args.includes('--history') },
  trivyReport: value('--trivy') ? resolve(value('--trivy')!) : undefined,
};

const ids = STAGES.map((s) => s.id) as string[];
const unknown = words.filter((w) => w !== 'summary' && !ids.includes(w));
if (unknown.length) {
  console.error(`Unknown stage ${unknown.join(', ')}. Stages: ${ids.join(', ')}, summary.`);
  process.exit(2);
}

function summary(): boolean {
  const s = writeSummary(reports, ci);
  console.log(`\n${s.markdown}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, s.markdown);
  return s.ok;
}

const stages = (words.length ? words.filter((w) => w !== 'summary') : ids) as StageId[];
if (!words.length) resetReports(reports);
let failed = false;
for (const id of stages) {
  const title = STAGES.find((s) => s.id === id)!.title;
  console.log(`▶ ${title}`);
  const r = runStage(id, options);
  const mark = r.status === 'passed' ? '✔' : r.status === 'failed' ? '✖' : '⚠';
  console.log(`${mark} ${title}: ${r.status} (${(r.durationMs / 1000).toFixed(1)} s)`);
  for (const n of r.notes.slice(0, 40)) console.log(`    ${n}`);
  if (r.notes.length > 40) console.log(`    … ${r.notes.length - 40} more in ${join(reports, 'stages')}`);
  for (const p of r.problems) console.log(`  ✖ ${p.replaceAll('\n', '\n    ')}`);
  failed ||= r.status === 'failed';
}
if (!words.length || words.includes('summary')) failed = !summary() || failed;
process.exit(failed ? 1 : 0);
