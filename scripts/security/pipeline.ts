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
 * The security CI pipeline (SEC-026): ten stages in a fixed order, each writing a report to
 * security-reports/. CI and the release workflow run the same stages (the reusable workflow
 * .github/workflows/security-pipeline.yml), and `summary` fails when a stage failed or left
 * no report, so no stage can be skipped silently.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult } from '../supply-chain/checks.ts';
import { loadPolicy } from '../supply-chain/packages.ts';
import { checkCompose, checkDockerfile, evaluateTrivy } from './container.ts';
import { runSast } from './sast.ts';

export const STAGES = [
  { id: 'typecheck', title: 'TypeScript typecheck' },
  { id: 'unit', title: 'Unit tests' },
  { id: 'integration', title: 'Integration tests' },
  { id: 'security', title: 'Security tests' },
  { id: 'dependencies', title: 'Dependency audit' },
  { id: 'secrets', title: 'Secret scanning' },
  { id: 'sast', title: 'SAST' },
  { id: 'container', title: 'Container scanning' },
  { id: 'sbom', title: 'SBOM generation' },
  { id: 'build', title: 'Build verification' },
] as const;

export type StageId = (typeof STAGES)[number]['id'];
export type StageStatus = 'passed' | 'failed' | 'not-run';

export interface StageReport {
  id: StageId;
  title: string;
  status: StageStatus;
  durationMs: number;
  problems: string[];
  notes: string[];
  /** Files under security-reports/ this stage wrote. */
  files: string[];
}

export interface PipelineOptions {
  root: string;
  reports: string;
  /** Running in CI (the CI environment variable): a stage that cannot run fails instead of being noted. */
  ci: boolean;
  /** scan-secrets: a commit range (a pull request's commits) or every commit. */
  secrets?: { range?: string; history?: boolean };
  /** A Trivy JSON report of the built image. */
  trivyReport?: string;
}

/** Test folders that are integration tests: the whole HTTP pipeline, or a real server. */
export const INTEGRATION_DIRS = ['packages/api/', 'apps/server/'];
export const SECURITY_DIR = 'tests/security/';

/**
 * Security tests that may be skipped where a tool is missing. Each is named with its reason;
 * in CI the tool is installed, so these must run there too. Any other skipped, todo or
 * conditional security test fails the stage.
 */
export const CONDITIONAL_SECURITY_TESTS: { file: string; test: string; reason: string }[] = [
  { file: 'tests/security/host/systemd-unit.test.ts', test: "systemd's analyzer rates the unit OK (exposure at most 2.0 of 10)", reason: 'needs systemd-analyze (installed on the CI runners)' },
];

/** Every test file in the repository, split into the three test stages (each file in exactly one). */
export function testPartition(root: string): Record<'unit' | 'integration' | 'security', string[]> {
  const files = Bun.spawnSync(['git', 'ls-files', '--', '*.test.ts', '*.test.tsx'], { cwd: root, stdout: 'pipe' }).stdout.toString().split('\n').filter(Boolean);
  const untracked = Bun.spawnSync(['git', 'ls-files', '--others', '--exclude-standard', '--', '*.test.ts', '*.test.tsx'], { cwd: root, stdout: 'pipe' }).stdout.toString().split('\n').filter(Boolean);
  const all = [...new Set([...files, ...untracked])].filter((f) => existsSync(join(root, f))).sort();
  const security = all.filter((f) => f.startsWith(SECURITY_DIR));
  const integration = all.filter((f) => INTEGRATION_DIRS.some((d) => f.startsWith(d)));
  const unit = all.filter((f) => !security.includes(f) && !integration.includes(f));
  return { unit, integration, security };
}

interface JunitCase { file: string; name: string; skipped: boolean; failed: boolean }

/** The test cases of a Bun JUnit report. */
export function parseJunit(xml: string): JunitCase[] {
  const cases: JunitCase[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  const attr = (attrs: string, name: string) => {
    const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
    return m ? m[1]!.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&') : '';
  };
  for (const m of xml.matchAll(re)) {
    const body = m[3] ?? '';
    cases.push({ file: attr(m[1]!, 'file'), name: attr(m[1]!, 'name'), skipped: /<skipped\b/.test(body), failed: /<(failure|error)\b/.test(body) });
  }
  return cases;
}

const SKIP_MARKERS = /\b(?:test|it|describe)\s*\.\s*(only|skip|todo|skipIf|todoIf|if|failing)\b/g;

/**
 * Security tests are never skipped silently: no `.only`/`.skip`/`.todo`/conditional marker in
 * the source (other than the declared conditional tests), every security test file appears in
 * the report, and nothing in the report was skipped unless declared, and in CI not even then.
 */
export function checkSecurityRun(root: string, files: string[], cases: JunitCase[], ci: boolean): CheckResult {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const file of files) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(SKIP_MARKERS)) {
        const declared = CONDITIONAL_SECURITY_TESTS.some((c) => c.file === file && (m[1] === 'if' || m[1] === 'skipIf') && (line.includes(c.test) || lines[i + 1]?.includes(c.test)));
        if (!declared) problems.push(`${file}:${i + 1}: ".${m[1]}" in a security test (security tests are never skipped, focused or left as todo).`);
      }
    });
  }
  const ran = new Set(cases.map((c) => c.file.replace(/^\.\//, '')));
  for (const file of files) if (![...ran].some((r) => file.endsWith(r) || r.endsWith(file))) problems.push(`${file}: no test of this file ran.`);
  if (!cases.length) problems.push('The security test report holds no tests.');
  for (const c of cases.filter((x) => x.skipped)) {
    const declared = CONDITIONAL_SECURITY_TESTS.find((d) => d.test === c.name && d.file.endsWith(c.file.replace(/^\.\//, '')));
    if (!declared) problems.push(`skipped: ${c.file} › ${c.name}`);
    else if (ci) problems.push(`skipped in CI: ${c.file} › ${c.name} (${declared.reason}): it must run here.`);
    else notes.push(`skipped here, runs in CI: ${c.file} › ${c.name} (${declared.reason})`);
  }
  notes.unshift(`${cases.length} security tests in ${files.length} files; ${cases.filter((c) => c.skipped).length} skipped.`);
  return { problems, notes };
}

type Run = { exitCode: number; output: string };

function run(cmd: string[], root: string, logFile: string, env: Record<string, string> = {}): Run {
  const p = Bun.spawnSync(cmd, { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
  const output = p.stdout.toString() + p.stderr.toString();
  writeFileSync(logFile, `$ ${cmd.join(' ')}\n${output}`);
  return { exitCode: p.exitCode ?? 1, output };
}

const tail = (text: string, lines = 25) => text.trimEnd().split('\n').slice(-lines).join('\n');

type Stage = (o: PipelineOptions, out: { log: (name: string) => string; file: (name: string) => string }) => CheckResult & { notRun?: boolean };

function testStage(which: 'unit' | 'integration'): Stage {
  return (o, out) => {
    const files = testPartition(o.root)[which];
    if (!files.length) return { problems: [`no ${which} test files found`], notes: [] };
    const junit = out.file(`${which}-tests.xml`);
    const r = run(['bun', 'test', '--reporter=junit', `--reporter-outfile=${junit}`, ...files.map((f) => `./${f}`)], o.root, out.log(which));
    const cases = existsSync(junit) ? parseJunit(readFileSync(junit, 'utf8')) : [];
    const failed = cases.filter((c) => c.failed);
    const notes = [`${cases.length} tests in ${files.length} files; ${failed.length} failed, ${cases.filter((c) => c.skipped).length} skipped.`];
    if (r.exitCode === 0) return { problems: [], notes };
    return { problems: [...failed.map((c) => `failed: ${c.file} › ${c.name}`), ...(failed.length ? [] : [`bun test exited with ${r.exitCode}:\n${tail(r.output)}`])], notes };
  };
}

const commandStage = (cmd: (o: PipelineOptions, out: { file: (name: string) => string }) => string[][], what: string): Stage => (o, out) => {
  const problems: string[] = [];
  const notes: string[] = [];
  const logs: string[] = [];
  for (const c of cmd(o, out)) {
    const r = run(c, o.root, out.log(`${what}-${logs.length}`));
    logs.push(r.output);
    if (r.exitCode !== 0) {
      problems.push(`${c.join(' ')} exited with ${r.exitCode}:\n${tail(r.output)}`);
      break;
    }
    notes.push(`${c.slice(0, 3).join(' ')}: ${tail(r.output, 1)}`);
  }
  return { problems, notes };
};

export const STAGE_RUNNERS: Record<StageId, Stage> = {
  typecheck: commandStage(() => [['bun', 'run', 'typecheck']], 'typecheck'),
  unit: testStage('unit'),
  integration: testStage('integration'),
  security(o, out) {
    const files = testPartition(o.root).security;
    const junit = out.file('security-tests.xml');
    const r = run(['bun', 'test', '--reporter=junit', `--reporter-outfile=${junit}`, './tests/security'], o.root, out.log('security'));
    const cases = existsSync(junit) ? parseJunit(readFileSync(junit, 'utf8')) : [];
    const check = checkSecurityRun(o.root, files, cases, o.ci);
    const failed = cases.filter((c) => c.failed).map((c) => `failed: ${c.file} › ${c.name}`);
    if (r.exitCode !== 0 && !failed.length) failed.push(`bun test exited with ${r.exitCode}:\n${tail(r.output)}`);
    return { problems: [...failed, ...check.problems], notes: check.notes };
  },
  dependencies(o, out) {
    const r = run(['bun', 'scripts/deps.ts'], o.root, out.log('dependencies'));
    // Every advisory, also those below the failing level, is kept as a report.
    const audit = Bun.spawnSync(['bun', 'audit', '--json'], { cwd: o.root, stdout: 'pipe', stderr: 'pipe' });
    writeFileSync(out.file('audit.json'), audit.stdout.toString().trim() || '{}');
    const lines = r.output.split('\n').filter((l) => l.trim());
    const problems = lines.filter((l) => l.trim().startsWith('✖ ') && l.startsWith('  ')).map((l) => l.trim().slice(2));
    if (r.exitCode !== 0 && !problems.length) problems.push(`deps:check exited with ${r.exitCode}:\n${tail(r.output)}`);
    return { problems, notes: lines.filter((l) => l.startsWith('    ')).map((l) => l.trim()) };
  },
  secrets: commandStage((o) => [
    ['bun', 'scripts/scan-secrets.ts'],
    ...(o.secrets?.range ? [['bun', 'scripts/scan-secrets.ts', '--range', o.secrets.range]] : o.secrets?.history ? [['bun', 'scripts/scan-secrets.ts', '--history']] : []),
  ], 'secrets'),
  sast(o, out) {
    const report = runSast(o.root);
    writeFileSync(out.file('sast.json'), `${JSON.stringify(report, null, 2)}\n`);
    const fmt = (f: (typeof report.findings)[number]) => `[${f.severity}] ${f.rule} ${f.file}:${f.line}: ${f.message}${f.waived ? ` (waived: ${f.waived})` : ''}`;
    const count = (s: string) => report.findings.filter((f) => f.severity === s).length;
    return {
      problems: [...report.blocking.map(fmt), ...report.unusedWaivers],
      notes: [`${report.files} files; ${count('critical')} critical, ${count('high')} high (${report.findings.filter((f) => f.waived).length} waived), ${count('medium')} medium.`, ...report.findings.filter((f) => !report.blocking.includes(f)).map(fmt)],
    };
  },
  container(o, out) {
    const docker = checkDockerfile(readFileSync(join(o.root, 'Dockerfile'), 'utf8'));
    const compose = checkCompose(Bun.YAML.parse(readFileSync(join(o.root, 'deploy', 'compose.yaml'), 'utf8')));
    const problems = [...docker.problems, ...compose.problems];
    const notes = [...docker.notes, ...compose.notes, 'Dockerfile and deploy/compose.yaml: hardening checked (SEC-004).'];
    if (!o.trivyReport || !existsSync(o.trivyReport)) {
      const why = o.trivyReport ? `the image scan report ${o.trivyReport} does not exist` : 'no image scan report (--trivy <file>)';
      if (o.ci) problems.push(`The built image was not scanned: ${why}.`);
      else notes.push(`NOT RUN: image vulnerability scan: ${why}. CI builds the image and scans it with Trivy.`);
      return { problems, notes, notRun: !o.ci && !problems.length };
    }
    const scan = evaluateTrivy(JSON.parse(readFileSync(o.trivyReport, 'utf8')), loadPolicy(o.root).container);
    writeFileSync(out.file('container-scan.json'), `${JSON.stringify(scan, null, 2)}\n`);
    return { problems: [...problems, ...scan.problems], notes: [...notes, ...scan.notes] };
  },
  sbom: commandStage((_o, out) => [['bun', 'scripts/sbom.ts', '--out', out.file('sbom')]], 'sbom'),
  build: commandStage(() => [
    ['bun', 'run', 'build'],
    ['bun', 'scripts/release.ts', 'package', '--skip-build', '--out', 'release'],
    ['bun', 'scripts/release.ts', 'verify', 'release'],
  ], 'build'),
};

const stageFile = (reports: string, id: StageId) => join(reports, 'stages', `${String(STAGES.findIndex((s) => s.id === id) + 1).padStart(2, '0')}-${id}.json`);

/** Runs one stage and writes its report. */
export function runStage(id: StageId, o: PipelineOptions): StageReport {
  const stage = STAGES.find((s) => s.id === id)!;
  for (const d of ['stages', 'logs']) mkdirSync(join(o.reports, d), { recursive: true });
  const files: string[] = [];
  const out = {
    log: (name: string) => { files.push(`logs/${name}.log`); return join(o.reports, 'logs', `${name}.log`); },
    file: (name: string) => { files.push(name); return join(o.reports, name); },
  };
  const started = performance.now();
  let result: CheckResult & { notRun?: boolean };
  try {
    result = STAGE_RUNNERS[id](o, out);
  } catch (e) {
    result = { problems: [`the stage crashed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`], notes: [] };
  }
  const report: StageReport = {
    id, title: stage.title,
    status: result.problems.length ? 'failed' : result.notRun ? 'not-run' : 'passed',
    durationMs: Math.round(performance.now() - started), problems: result.problems, notes: result.notes, files,
  };
  writeFileSync(stageFile(o.reports, id), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/** Clears earlier stage reports, so a summary only ever describes this run. */
export function resetReports(reports: string) {
  rmSync(join(reports, 'stages'), { recursive: true, force: true });
  mkdirSync(join(reports, 'stages'), { recursive: true });
}

export interface PipelineSummary {
  ok: boolean;
  stages: (StageReport | { id: StageId; title: string; status: 'missing' })[];
  markdown: string;
}

const ICON: Record<string, string> = { passed: '✅ passed', failed: '❌ failed', 'not-run': '⚠️ not run', missing: '❌ no report' };

/**
 * The pipeline's result from the stage reports. A stage without a report never ran (it was
 * skipped or removed): that fails like a failed stage. `not-run` (a local run without an image
 * scan) only passes outside CI.
 */
export function summarize(reports: string, ci: boolean): PipelineSummary {
  const stages = STAGES.map((s) => {
    const f = stageFile(reports, s.id);
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as StageReport) : { id: s.id, title: s.title, status: 'missing' as const };
  });
  const ok = stages.every((s) => s.status === 'passed' || (s.status === 'not-run' && !ci));
  const rows = stages.map((s, i) => `| ${i + 1} | ${s.title} | ${ICON[s.status]} | ${'durationMs' in s ? `${(s.durationMs / 1000).toFixed(1)} s` : ''} |`);
  const details = stages.flatMap((s) => ('problems' in s && s.problems.length ? [`### ${s.title}`, '', ...s.problems.map((p) => `- ${p.split('\n')[0]}`), ''] : []));
  const markdown = [
    `## Security pipeline: ${ok ? 'passed' : 'FAILED'}`, '',
    '| # | Stage | Result | Time |', '|---|---|---|---|', ...rows, '',
    ...(details.length ? ['Problems:', '', ...details] : []),
    'Reports: the `security-reports` artifact of this run.', '',
  ].join('\n');
  return { ok, stages, markdown };
}

export function writeSummary(reports: string, ci: boolean): PipelineSummary {
  const summary = summarize(reports, ci);
  writeFileSync(join(reports, 'summary.json'), `${JSON.stringify({ ok: summary.ok, stages: summary.stages.map((s) => ({ id: s.id, title: s.title, status: s.status })) }, null, 2)}\n`);
  writeFileSync(join(reports, 'summary.md'), summary.markdown);
  return summary;
}

export const listReports = (reports: string) => (existsSync(reports) ? readdirSync(reports, { recursive: true }).map(String).sort() : []);
