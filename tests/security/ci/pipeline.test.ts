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

// SEC-026: the security pipeline runs every stage in order, in CI and for releases; nothing is
// skipped silently; critical findings fail; vulnerabilities are reported; reports are kept.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCompose, checkDockerfile, evaluateTrivy } from '../../../scripts/security/container.ts';
import { checkSecurityRun, CONDITIONAL_SECURITY_TESTS, parseJunit, resetReports, STAGES, summarize, testPartition, type StageReport } from '../../../scripts/security/pipeline.ts';

const repo = join(import.meta.dir, '..', '..', '..');
const workflow = (f: string) => Bun.YAML.parse(readFileSync(join(repo, '.github', 'workflows', f), 'utf8')) as {
  on: Record<string, unknown>; permissions: unknown;
  jobs: Record<string, { uses?: string; needs?: string; permissions?: unknown; steps?: { name?: string; run?: string; uses?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> }[] }>;
};

describe('the workflows (SEC-026)', () => {
  const pipeline = workflow('security-pipeline.yml');
  const steps = pipeline.jobs.pipeline!.steps!;

  test('the pipeline is a reusable workflow with read-only permissions', () => {
    expect(Object.keys(pipeline.on)).toEqual(['workflow_call']);
    expect(pipeline.permissions).toEqual({ contents: 'read' });
  });

  test('pull requests, pushes to main and the weekly run call it; a release cannot be built before it passes', () => {
    const ci = workflow('ci.yml');
    expect(Object.keys(ci.on).sort()).toEqual(['pull_request', 'push', 'schedule', 'workflow_dispatch']);
    expect(Object.values(ci.jobs).map((j) => j.uses)).toEqual(['./.github/workflows/security-pipeline.yml']);
    const rel = workflow('release.yml');
    expect(rel.jobs.security!.uses).toBe('./.github/workflows/security-pipeline.yml');
    expect(rel.jobs.release!.needs).toBe('security');
    expect(rel.jobs.security!.permissions).toEqual({ contents: 'read' });
  });

  test('every stage is a step, in the roadmap order', () => {
    const stageSteps = steps.filter((s) => s.run?.includes('bun run security:ci ') && !s.run.includes('summary'));
    const ids = stageSteps.map((s) => /security:ci (\w+)/.exec(s.run!)![1]);
    expect(ids).toEqual(STAGES.map((s) => s.id));
    expect(stageSteps.map((s) => s.name)).toEqual(STAGES.map((s, i) => `${i + 1}. ${s.title}`));
  });

  test('a failed stage does not hide the others; the summary and the reports always run', () => {
    const first = steps.findIndex((s) => s.name === '1. TypeScript typecheck');
    for (const s of steps.slice(first + 1)) expect([s.name, s.if]).toEqual([s.name, expect.stringMatching(/!cancelled\(\)|always\(\)/)]);
    const summary = steps.find((s) => s.run === 'bun run security:ci summary')!;
    expect(summary.if).toContain('always()');
    const upload = steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'))!;
    expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(summary));
    expect(upload.if).toContain('always()');
    expect(upload.with).toMatchObject({ path: 'security-reports/', 'if-no-files-found': 'error' });
    expect(Number(upload.with!['retention-days'])).toBeGreaterThanOrEqual(90);
  });

  test('the image is built and scanned before container scanning judges the report', () => {
    const at = (p: (s: (typeof steps)[number]) => boolean) => steps.findIndex(p);
    const build = at((s) => !!s.run?.startsWith('docker build'));
    const trivy = at((s) => !!s.uses?.startsWith('aquasecurity/trivy-action@'));
    const judge = at((s) => s.run === 'bun run security:ci container --trivy security-reports/trivy-image.json');
    expect(build).toBeGreaterThan(-1);
    expect(trivy).toBeGreaterThan(build);
    expect(judge).toBeGreaterThan(trivy);
    expect(steps[trivy]!.with).toMatchObject({ format: 'json', output: 'security-reports/trivy-image.json', 'exit-code': '0' });
  });

  test("secret scanning reads a pull request's commits (full history fetched); expressions reach the shell through env", () => {
    expect(steps[0]!.with).toMatchObject({ 'fetch-depth': 0, 'persist-credentials': false });
    const secrets = steps.find((s) => s.name === '6. Secret scanning')!;
    expect(secrets.run).toContain('--range "$BASE..$HEAD"');
    expect(secrets.run).toContain('--history');
    for (const s of steps) if (s.run) expect([s.name, s.run]).not.toEqual([s.name, expect.stringContaining('${{')]);
  });
});

describe('test stages', () => {
  test('every test file in the repository is in exactly one test stage', () => {
    const p = testPartition(repo);
    const all = [...p.unit, ...p.integration, ...p.security];
    expect(new Set(all).size).toBe(all.length);
    const tracked = Bun.spawnSync(['git', 'ls-files', '--', '*.test.ts', '*.test.tsx'], { cwd: repo, stdout: 'pipe' }).stdout.toString().split('\n').filter(Boolean);
    for (const f of tracked) expect(all).toContain(f);
    expect(p.security.every((f) => f.startsWith('tests/security/'))).toBe(true);
    expect(p.integration.length).toBeGreaterThan(20);
    expect(p.unit.length).toBeGreaterThan(20);
  });

  test('reads Bun JUnit reports', () => {
    const cases = parseJunit(`<testsuites><testsuite name="a.test.ts" file="a.test.ts">
      <testcase name="ok" classname="d" file="a.test.ts" line="2" />
      <testcase name="&quot;x&quot; &amp; y" classname="d" file="a.test.ts"><skipped /></testcase>
      <testcase name="bad" classname="d" file="b.test.ts"><failure message="x" /></testcase>
    </testsuite></testsuites>`);
    expect(cases).toEqual([
      { file: 'a.test.ts', name: 'ok', skipped: false, failed: false },
      { file: 'a.test.ts', name: '"x" & y', skipped: true, failed: false },
      { file: 'b.test.ts', name: 'bad', skipped: false, failed: true },
    ]);
  });
});

describe('security tests are never skipped silently', () => {
  const dir = () => {
    const root = mkdtempSync(join(tmpdir(), 'clawrouter-skip-'));
    mkdirSync(join(root, 'tests', 'security', 'x'), { recursive: true });
    return root;
  };
  const ran = (file: string, skipped = false) => ({ file, name: 't', skipped, failed: false });

  test.each(['only', 'skip', 'todo', 'skipIf', 'todoIf', 'if', 'failing'])('test.%s in a security test fails the stage', (marker) => {
    const root = dir();
    const file = 'tests/security/x/a.test.ts';
    writeFileSync(join(root, file), `import { test } from 'bun:test';\ntest.${marker}('x', () => {});\n`);
    const r = checkSecurityRun(root, [file], [ran('tests/security/x/a.test.ts')], false);
    expect(r.problems).toEqual([expect.stringContaining(`".${marker}" in a security test`)]);
  });

  test('a security test file that did not run fails the stage, and so does a report without tests', () => {
    const root = dir();
    for (const f of ['a', 'b']) writeFileSync(join(root, `tests/security/x/${f}.test.ts`), "test('x', () => {});\n");
    const files = ['tests/security/x/a.test.ts', 'tests/security/x/b.test.ts'];
    expect(checkSecurityRun(root, files, [ran('tests/security/x/a.test.ts')], false).problems).toEqual(['tests/security/x/b.test.ts: no test of this file ran.']);
    expect(checkSecurityRun(root, [], [], false).problems).toContain('The security test report holds no tests.');
  });

  test('a skipped test fails the stage; a declared conditional one only outside CI', () => {
    const root = dir();
    writeFileSync(join(root, 'tests/security/x/a.test.ts'), "test('x', () => {});\n");
    const files = ['tests/security/x/a.test.ts'];
    expect(checkSecurityRun(root, files, [{ file: 'tests/security/x/a.test.ts', name: 'quiet', skipped: true, failed: false }], false).problems).toEqual(['skipped: tests/security/x/a.test.ts › quiet']);
    const declared = CONDITIONAL_SECURITY_TESTS[0]!;
    const c = { file: declared.file, name: declared.test, skipped: true, failed: false };
    expect(checkSecurityRun(root, [], [c], false).problems).toEqual([]);
    expect(checkSecurityRun(root, [], [c], true).problems).toEqual([expect.stringContaining('skipped in CI')]);
  });

  test('the repository has no skip markers beyond the declared conditional tests', () => {
    const files = testPartition(repo).security;
    const cases = files.map((f) => ran(f));
    expect(checkSecurityRun(repo, files, cases, true).problems).toEqual([]);
    for (const c of CONDITIONAL_SECURITY_TESTS) expect(readFileSync(join(repo, c.file), 'utf8')).toContain(c.test);
  });
});

describe('the summary', () => {
  const reports = () => {
    const r = mkdtempSync(join(tmpdir(), 'clawrouter-reports-'));
    resetReports(r);
    return r;
  };
  const write = (dir: string, i: number, status: StageReport['status']) => {
    const s = STAGES[i]!;
    writeFileSync(join(dir, 'stages', `${String(i + 1).padStart(2, '0')}-${s.id}.json`), JSON.stringify({ id: s.id, title: s.title, status, durationMs: 1, problems: status === 'failed' ? ['boom'] : [], notes: [], files: [] }));
  };

  test('passes only when every stage passed', () => {
    const dir = reports();
    STAGES.forEach((_, i) => write(dir, i, 'passed'));
    expect(summarize(dir, true).ok).toBe(true);
    write(dir, 3, 'failed');
    const s = summarize(dir, true);
    expect(s.ok).toBe(false);
    expect(s.markdown).toContain('| 4 | Security tests | ❌ failed |');
    expect(s.markdown).toContain('- boom');
  });

  test('a stage without a report (skipped, removed, crashed before writing) fails', () => {
    const dir = reports();
    STAGES.forEach((_, i) => i !== 6 && write(dir, i, 'passed'));
    const s = summarize(dir, false);
    expect(s.ok).toBe(false);
    expect(s.stages[6]!.status).toBe('missing');
    expect(s.markdown).toContain('| 7 | SAST | ❌ no report |');
  });

  test('"not run" (no image scan on a developer machine) passes locally, fails in CI', () => {
    const dir = reports();
    STAGES.forEach((_, i) => write(dir, i, i === 7 ? 'not-run' : 'passed'));
    expect(summarize(dir, false).ok).toBe(true);
    expect(summarize(dir, true).ok).toBe(false);
  });

  test('a new run starts without the reports of an old one', () => {
    const dir = reports();
    write(dir, 0, 'passed');
    resetReports(dir);
    expect(readdirSync(join(dir, 'stages'))).toEqual([]);
  });
});

describe('container scanning', () => {
  const dockerfile = readFileSync(join(repo, 'Dockerfile'), 'utf8');
  const compose = () => Bun.YAML.parse(readFileSync(join(repo, 'deploy', 'compose.yaml'), 'utf8')) as { services: Record<string, Record<string, unknown>> };

  test("the repository's Dockerfile and compose file pass", () => {
    expect(checkDockerfile(dockerfile).problems).toEqual([]);
    expect(checkCompose(compose()).problems).toEqual([]);
  });

  test.each([
    ['a root image', dockerfile.replace('USER bun', 'USER root'), 'runs as root'],
    ['no USER', dockerfile.replace('USER bun\n', ''), 'runs as root (no USER)'],
    ['an unpinned base image', dockerfile.replaceAll('oven/bun:1.4.4-slim', 'oven/bun:latest'), 'no exact version'],
    ['a moving tag', dockerfile.replaceAll('oven/bun:1.4.4-slim', 'oven/bun:1-slim'), 'not pinned'],
    ['ADD from a URL', `${dockerfile}\nADD https://example.com/tool /usr/local/bin/tool\n`, 'ADD downloads'],
    ['a secret in ENV', `${dockerfile}\nENV CLAWROUTER_SECRET_KEY=abc\n`, 'secret-looking'],
    ['curl into a shell', `${dockerfile}\nRUN curl -fsSL https://example.com/i.sh | sh\n`, 'pipes a download'],
  ])('Dockerfile: %s fails', (_name, text, problem) => {
    expect(checkDockerfile(text).problems.join('\n')).toContain(problem);
  });

  test.each([
    ['root user', (s: Record<string, unknown>) => { s.user = '0:0'; }, 'unprivileged user'],
    ['writable root', (s: Record<string, unknown>) => { delete s.read_only; }, 'writable root'],
    ['privileged', (s: Record<string, unknown>) => { s.privileged = true; }, 'privileged'],
    ['capabilities kept', (s: Record<string, unknown>) => { delete s.cap_drop; }, 'drop every capability'],
    ['a capability added', (s: Record<string, unknown>) => { s.cap_add = ['NET_ADMIN']; }, 'adds capabilities'],
    ['new privileges', (s: Record<string, unknown>) => { s.security_opt = []; }, 'new privileges'],
    ['seccomp off', (s: Record<string, unknown>) => { s.security_opt = ['no-new-privileges:true', 'seccomp=unconfined']; }, 'seccomp'],
    ['host network', (s: Record<string, unknown>) => { s.network_mode = 'host'; }, "host's network"],
    ['the Docker socket', (s: Record<string, unknown>) => { s.volumes = ['/var/run/docker.sock:/var/run/docker.sock']; }, 'Docker socket'],
    ['no limits', (s: Record<string, unknown>) => { delete s.pids_limit; delete s.mem_limit; }, 'pids_limit'],
    ['a port on every interface', (s: Record<string, unknown>) => { s.ports = ['8080:8080']; }, 'every interface'],
  ])('compose: %s fails', (_name, change, problem) => {
    const doc = compose();
    change(doc.services.clawrouter!);
    expect(checkCompose(doc).problems.join('\n')).toContain(problem);
  });

  const report = (vulns: Record<string, unknown>[]) => ({ ArtifactName: 'clawrouter:ci', Results: [{ Target: 'debian 12', Vulnerabilities: vulns }, { Target: 'node-pkg', Vulnerabilities: null }] });
  const policy = { failOn: ['critical'], fixedOnly: true, exceptions: [] as { vulnerability: string; package: string; reason: string; expires: string }[] };

  test('every vulnerability is reported; a fixable critical one fails', () => {
    const r = evaluateTrivy(report([
      { VulnerabilityID: 'CVE-1', PkgName: 'openssl', InstalledVersion: '1', FixedVersion: '2', Severity: 'CRITICAL', Title: 'bad' },
      { VulnerabilityID: 'CVE-2', PkgName: 'zlib', InstalledVersion: '1', Severity: 'CRITICAL' },
      { VulnerabilityID: 'CVE-3', PkgName: 'libc', InstalledVersion: '1', FixedVersion: '2', Severity: 'HIGH' },
      { VulnerabilityID: 'CVE-3', PkgName: 'libc', InstalledVersion: '1', FixedVersion: '2', Severity: 'HIGH' },
    ]), policy, '2026-11-20');
    expect(r.problems).toEqual(['CRITICAL CVE-1 in openssl 1 (fixed in 2): bad [debian 12]']);
    expect(r.counts).toMatchObject({ CRITICAL: 2, HIGH: 1 });
    expect(r.notes[0]).toBe('clawrouter:ci: 2 critical, 1 high, 0 medium, 0 low, 0 unknown.');
    expect(r.notes.join('\n')).toContain('CVE-2 in zlib 1 (no fix yet)');
    expect(r.notes.join('\n')).toContain('CVE-3');
    expect(evaluateTrivy(report([{ VulnerabilityID: 'CVE-2', PkgName: 'zlib', InstalledVersion: '1', Severity: 'CRITICAL' }]), { ...policy, fixedOnly: false }).problems).toHaveLength(1);
  });

  test('an exception needs to name the finding and expires', () => {
    const vuln = [{ VulnerabilityID: 'CVE-1', PkgName: 'openssl', InstalledVersion: '1', FixedVersion: '2', Severity: 'CRITICAL' }];
    const exception = { vulnerability: 'CVE-1', package: 'openssl', reason: 'not reachable: no TLS server in the image', expires: '2026-12-01' };
    expect(evaluateTrivy(report(vuln), { ...policy, exceptions: [exception] }, '2026-11-20').problems).toEqual([]);
    expect(evaluateTrivy(report(vuln), { ...policy, exceptions: [exception] }, '2026-12-02').problems[0]).toContain('expired on 2026-12-01');
    expect(evaluateTrivy(report([]), { ...policy, exceptions: [exception] }).notes.join('\n')).toContain('matches no finding');
  });

  test('something that is not a Trivy report fails', () => {
    expect(evaluateTrivy({ nope: 1 }, policy).problems).toEqual(['container scan: not a Trivy JSON report.']);
  });
});

describe('secret scanning reads commits (SEC-026)', () => {
  const git = (cwd: string, ...args: string[]) => Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const scan = (cwd: string, ...args: string[]) => Bun.spawnSync(['bun', join(repo, 'scripts', 'scan-secrets.ts'), ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });

  test('a credential added and removed again inside a pull request still fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clawrouter-secrets-'));
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    // Built at run time so this file holds no key-shaped text itself.
    const key = ['AKIA', 'QWERTYUIOPASDFGH'].join('');
    writeFileSync(join(dir, 'a.ts'), `export const k = '${key}';\n`);
    git(dir, 'commit', '-qam', 'add');
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    git(dir, 'commit', '-qam', 'remove');
    expect(scan(dir).exitCode).toBe(0);
    const r = scan(dir, '--range', 'HEAD~2..HEAD');
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('possible AWS access key');
    expect(scan(dir, '--range', 'HEAD~1..HEAD').exitCode).toBe(0);
    expect(scan(dir, '--range', 'nothing..HEAD').exitCode).toBe(2);
  });

  test('a PEM header in a template is not key material', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clawrouter-secrets-'));
    git(dir, 'init', '-q', '-b', 'main');
    // Built at run time, so this file holds no PEM header itself.
    const header = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    writeFileSync(join(dir, 'a.ts'), `const t = \`${header}\\n\${pem}\`;\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'x');
    expect(scan(dir, '--history').exitCode).toBe(0);
  });
});
