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

// Phase 6, supply chain security: dependency checks (SEC-018), the SBOM (SEC-019) and
// release artifacts with their verification (SEC-020). The attacker here changes what
// ClawRouter is built from (a lockfile entry, a vendored tarball, a dependency's license)
// or what users download (a release file).

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLicenses, checkLockfile, evaluateAudit, licenseAllowed } from '../../../scripts/supply-chain/checks.ts';
import { loadLockfile, loadPolicy, parseJsonc, thirdPartyPackages, type SupplyChainPolicy, type ThirdPartyPackage } from '../../../scripts/supply-chain/packages.ts';
import { cyclonedx, npmPurl, sbomText, spdx, type SbomInput } from '../../../scripts/supply-chain/sbom.ts';
import { artifactNames, parseChecksums, releaseIdentity, SUMS, verifyRelease, writeChecksums } from '../../../scripts/supply-chain/release.ts';

const repo = join(import.meta.dir, '..', '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'clawrouter-supply-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(tmp, `case-${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const policy = (): SupplyChainPolicy => JSON.parse(JSON.stringify(loadPolicy(repo))) as SupplyChainPolicy;
const SRI = (seed: string) => `sha512-${new Bun.CryptoHasher('sha512').update(seed).digest('base64')}`;

/** A small project: a root workspace and one app with a vendored tarball, written as Bun writes bun.lock. */
function project(o: { packages?: Record<string, unknown[]>; deps?: Record<string, string>; trusted?: string[]; tarball?: string } = {}) {
  const root = fresh();
  mkdirSync(join(root, 'vendor'));
  writeFileSync(join(root, 'vendor', 'ui.tgz'), o.tarball ?? 'the real tarball');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'p', ...(o.trusted ? { trustedDependencies: o.trusted } : {}) }));
  const lock = {
    lockfileVersion: 1,
    workspaces: {
      '': { name: 'p', dependencies: { react: '19.3.1', ...o.deps } },
      'apps/console': { name: '@p/console', dependencies: { ui: 'file:../../vendor/ui.tgz' } },
    },
    packages: {
      '@p/console': ['@p/console@workspace:apps/console'],
      react: ['react@19.3.1', '', {}, SRI('react')],
      ui: ['ui@../../vendor/ui.tgz', { dependencies: { react: '^19' } }, `sha512-${new Bun.CryptoHasher('sha512').update('the real tarball').digest('base64')}`],
      ...o.packages,
    },
  };
  // Trailing commas, as in a real bun.lock.
  writeFileSync(join(root, 'bun.lock'), JSON.stringify(lock, null, 2).replace(/(\]|\}|"|\d)\n(\s*)(\}|\])/g, '$1,\n$2$3'));
  const p = policy();
  p.lockfile.tarballs = { '../../vendor/ui.tgz': 'vendor/ui.tgz' };
  return { root, lock: loadLockfile(root), policy: p };
}

describe('lockfile verification (SEC-018)', () => {
  test('the repository passes', () => {
    expect(checkLockfile(repo, loadLockfile(repo), loadPolicy(repo)).problems).toEqual([]);
  });

  test('bun.lock with trailing commas parses, and commas inside strings stay', () => {
    expect(parseJsonc('{"a": [1, 2,], "b": "x,}",\n}')).toEqual({ a: [1, 2], b: 'x,}' });
    const { lock } = project();
    expect([...lock.entries.keys()].sort()).toEqual(['@p/console', 'react', 'ui']);
  });

  test('a clean project passes', () => {
    const p = project();
    expect(checkLockfile(p.root, p.lock, p.policy).problems).toEqual([]);
  });

  test.each([
    ['a git source', { packages: { evil: ['evil@git+https://example.com/evil.git#abc', {}, 'deadbeef'] } }, 'only registry packages, workspaces and committed tarballs'],
    ['a GitHub shorthand', { packages: { evil: ['evil@github:someone/evil#main', {}, 'x'] } }, 'only registry packages'],
    ['a tarball URL', { packages: { evil: ['evil@https://example.com/evil-1.0.0.tgz', {}, SRI('e')] } }, 'only registry packages'],
    ['another registry', { packages: { evil: ['evil@1.0.0', 'https://registry.example.com/', {}, SRI('e')] } }, 'which the policy does not allow'],
    ['a registry package without a hash', { packages: { evil: ['evil@1.0.0', '', {}] } }, 'has no sha512 integrity hash'],
    ['a weak hash', { packages: { evil: ['evil@1.0.0', '', {}, 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA='] } }, 'has no sha512 integrity hash'],
    ['an unlisted tarball', { packages: { evil: ['evil@../../vendor/other.tgz', {}, SRI('o')] } }, 'which the policy does not list'],
    ['a changed vendored tarball', { tarball: 'a replaced tarball' }, 'does not match the integrity hash'],
    ['a version range', { deps: { lodash: '^4.17.21' } }, 'must be exact versions'],
    ['a dist-tag', { deps: { lodash: 'latest' } }, 'must be exact versions'],
    ['an install script allowed', { trusted: ['react'] }, 'to run install scripts'],
    ['a workspace that does not exist', { packages: { '@p/x': ['@p/x@workspace:packages/x'] } }, 'which is not a workspace'],
  ] as const)('refuses %s', (_name, o, message) => {
    const p = project(o as Parameters<typeof project>[0]);
    const { problems } = checkLockfile(p.root, p.lock, p.policy);
    expect(problems.join('\n')).toContain(message);
  });
});

describe('license scanning (SEC-018)', () => {
  const allowed = loadPolicy(repo).licenses.allowed;

  test('the repository passes, with every package licensed', () => {
    const packages = thirdPartyPackages(repo, loadLockfile(repo), loadPolicy(repo));
    expect(packages.length).toBeGreaterThan(5);
    expect(checkLicenses(packages, loadPolicy(repo)).problems).toEqual([]);
    // ENTERPRISE-UI has no license field; its LICENSE file says MIT.
    expect(packages.find((p) => p.name === '@enterprise-ui/react')).toMatchObject({ license: 'MIT', licenseSource: 'LICENSE file', scope: 'runtime', kind: 'tarball' });
  });

  test.each([
    ['MIT', true], ['(MIT OR Apache-2.0)', true], ['MIT OR GPL-2.0-only', true], ['MIT AND ISC', true],
    ['Apache-2.0 WITH LLVM-exception', true], ['GPL-2.0-only', false], ['SSPL-1.0', false], ['BUSL-1.1', false],
    ['GPL-3.0-only', true], ['GPL-3.0-or-later', true], ['GPL-3.0', true], ['GPL-2.0-or-later', true], ['GPL-2.0+', true],
    ['GPL-2.0', false], ['LGPL-2.1', true], ['LGPL-3.0-or-later', true], ['AGPL-3.0-only', true], ['LGPL-2.0-only', false],
    ['UNLICENSED', false], ['MIT AND SSPL-1.0', false], ['SEE LICENSE IN LICENSE.txt', false], ['', false], ['(MIT', false],
  ] as const)('%s allowed: %p', (expression, ok) => {
    expect(licenseAllowed(expression, allowed)).toBe(ok);
  });

  const pkg = (o: Partial<ThirdPartyPackage>): ThirdPartyPackage => ({ key: 'x', name: 'x', version: '1.0.0', kind: 'registry', scope: 'runtime', direct: true, dependsOn: [], license: 'MIT', licenseSource: 'package.json', ...o });
  test('refuses a disallowed license, a missing one, and a package that is not installed', () => {
    const { problems } = checkLicenses([pkg({ name: 'a', license: 'SSPL-1.0' }), pkg({ name: 'b', license: null, licenseSource: null }), pkg({ name: 'c', version: '' })], loadPolicy(repo));
    expect(problems).toEqual([
      'a@1.0.0 (runtime) is licensed "SSPL-1.0", which supply-chain.json does not allow.',
      'b@1.0.0 (runtime) has no license field or recognisable LICENSE file. Check it by hand and add it to supply-chain.json "licenses.packages".',
      'c: not installed, so its license cannot be read (run "bun install").',
    ]);
  });
});

describe('vulnerability audit policy (SEC-018)', () => {
  // The shape of "bun audit --json" (taken from a real report for lodash 4.17.15 and minimist 1.2.0).
  const report = {
    lodash: [
      { id: 1106913, url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm', title: 'Command Injection in lodash', severity: 'high', vulnerable_versions: '<4.17.21' },
      { id: 1108258, url: 'https://github.com/advisories/GHSA-29mw-wpgm-hmr9', title: 'ReDoS in lodash', severity: 'moderate', vulnerable_versions: '>=4.0.0 <4.17.21' },
    ],
    minimist: [{ id: 1, url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h', title: 'Prototype Pollution in minimist', severity: 'critical', vulnerable_versions: '<1.2.6' }],
  };

  test('high and critical fail; moderate is a note', () => {
    const r = evaluateAudit(report, policy());
    expect(r.problems).toEqual([
      'advisory: lodash: high GHSA-35jh-r3h4-6jhm Command Injection in lodash (<4.17.21)',
      'advisory: minimist: critical GHSA-xvch-5gv4-984h Prototype Pollution in minimist (<1.2.6)',
    ]);
    expect(r.notes).toEqual(['advisory below the failing level: lodash: moderate GHSA-29mw-wpgm-hmr9 ReDoS in lodash (>=4.0.0 <4.17.21)']);
  });

  test('an exception accepts an advisory until it expires; an unknown severity counts as critical', () => {
    const p = policy();
    p.audit.exceptions = [{ advisory: 'GHSA-35jh-r3h4-6jhm', package: 'lodash', reason: 'not reachable', expires: '2026-12-31' }];
    expect(evaluateAudit({ lodash: [report.lodash[0]] }, p, '2026-11-20')).toMatchObject({ problems: [], notes: [expect.stringContaining('accepted until 2026-12-31')] });
    expect(evaluateAudit({ lodash: [report.lodash[0]] }, p, '2027-01-01').problems).toEqual([expect.stringContaining('its exception expired on 2026-12-31')]);
    // The exception names a package: the same advisory elsewhere is not covered.
    expect(evaluateAudit({ other: [report.lodash[0]] }, p, '2026-11-20').problems).toHaveLength(1);
    expect(evaluateAudit({ x: [{ id: 9, severity: 'weird' }] }, policy()).problems).toEqual([expect.stringContaining('x: critical')]);
  });

  test('fails closed on anything but a report', () => {
    for (const bad of [null, [], 'error', 42, { lodash: 'x' }]) expect(evaluateAudit(bad, policy()).problems).toHaveLength(1);
    expect(evaluateAudit({}, policy()).problems).toEqual([]);
  });
});

describe('software bill of materials (SEC-019)', () => {
  const input = (): SbomInput => ({
    version: '1.0.0', commit: 'a'.repeat(40), created: '2026-11-20T00:00:00Z',
    packages: thirdPartyPackages(repo, loadLockfile(repo), loadPolicy(repo)), runtime: { bun: '1.4.4', sqlite: '3.53.0' },
  });

  test('both formats list every package with its version, purl, hash and scope, the application and the runtime', () => {
    const i = input();
    const s = spdx(i) as { packages: { name: string; versionInfo: string; checksums?: unknown[]; externalRefs?: { referenceLocator: string }[] }[]; relationships: { relationshipType: string }[] };
    const c = cyclonedx(i) as { metadata: { component: { version: string; licenses: unknown[] } }; components: { name: string; version: string; purl?: string; scope?: string; hashes?: unknown[] }[]; dependencies: { ref: string }[] };
    expect(s.packages.find((p) => p.name === 'clawrouter')?.versionInfo).toBe('1.0.0');
    expect(c.metadata.component).toMatchObject({ version: '1.0.0', licenses: [{ license: { id: 'AGPL-3.0-or-later' } }] });
    for (const p of i.packages) {
      const sp = s.packages.find((x) => x.name === p.name && x.versionInfo === p.version);
      expect(sp?.externalRefs?.[0]?.referenceLocator).toBe(npmPurl(p.name, p.version));
      expect(sp?.checksums).toHaveLength(1);
      const cp = c.components.find((x) => x.purl === npmPurl(p.name, p.version));
      expect(cp).toMatchObject({ version: p.version, scope: p.scope === 'runtime' ? 'required' : 'excluded' });
      expect(cp?.hashes).toHaveLength(1);
      expect(c.dependencies.some((d) => d.ref === npmPurl(p.name, p.version))).toBe(true);
    }
    expect(c.components.find((x) => x.name === 'bun')).toMatchObject({ type: 'platform', version: '1.4.4', scope: 'required' });
    expect(s.packages.find((x) => x.name === 'sqlite')?.versionInfo).toBe('3.53.0');
    expect(c.components.find((x) => x.name === 'react')?.scope).toBe('required');
    expect(c.components.find((x) => x.name === 'typescript')?.scope).toBe('excluded');
    expect(s.relationships.some((r) => r.relationshipType === 'DEV_DEPENDENCY_OF')).toBe(true);
  });

  test('the same input gives the same bytes; another version changes the identifiers', () => {
    expect(sbomText(spdx(input()))).toBe(sbomText(spdx(input())));
    expect(sbomText(cyclonedx(input()))).toBe(sbomText(cyclonedx(input())));
    const other = { ...input(), version: '1.0.1' };
    expect((cyclonedx(other) as { serialNumber: string }).serialNumber).not.toBe((cyclonedx(input()) as { serialNumber: string }).serialNumber);
    expect((spdx(other) as { documentNamespace: string }).documentNamespace).not.toBe((spdx(input()) as { documentNamespace: string }).documentNamespace);
    expect((cyclonedx(input()) as { serialNumber: string }).serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('release verification (SEC-020)', () => {
  /** A release directory: the three artifacts and SHA256SUMS. */
  function release() {
    const dir = fresh();
    const names = artifactNames('1.0.0');
    writeFileSync(join(dir, names.tarball), 'tarball bytes');
    writeFileSync(join(dir, names.spdx), JSON.stringify({ packages: [{ SPDXID: 'SPDXRef-ClawRouter', versionInfo: '1.0.0' }] }));
    writeFileSync(join(dir, names.cyclonedx), JSON.stringify({ metadata: { component: { version: '1.0.0' } } }));
    writeChecksums(dir);
    return { dir, names };
  }

  test('an untouched release verifies; SHA256SUMS is in the format sha256sum reads', () => {
    const { dir, names } = release();
    expect(verifyRelease(dir, { version: '1.0.0' }).problems).toEqual([]);
    const sums = readFileSync(join(dir, SUMS), 'utf8');
    expect(sums.split('\n').filter(Boolean).map((l) => l.split('  ')[1])).toEqual([names.cyclonedx, names.spdx, names.tarball].sort());
    const r = Bun.spawnSync(['sha256sum', '-c', SUMS], { cwd: dir });
    expect(r.exitCode).toBe(0);
  });

  test('a changed, missing, extra or renamed file fails', () => {
    const cases: [string, (dir: string, names: ReturnType<typeof artifactNames>) => void, string][] = [
      ['changed', (d, n) => writeFileSync(join(d, n.tarball), 'tarball bytes, with a backdoor'), 'does not match its SHA-256'],
      ['missing', (d, n) => rmSync(join(d, n.spdx)), 'listed in SHA256SUMS but missing'],
      ['extra', (d) => writeFileSync(join(d, 'install.sh'), 'curl | sh'), 'install.sh is not listed in SHA256SUMS'],
      ['SBOM of another version', (d, n) => { writeFileSync(join(d, n.cyclonedx), JSON.stringify({ metadata: { component: { version: '0.9.0' } } })); writeChecksums(d); }, 'describes version 0.9.0'],
      ['SHA256SUMS removed', (d) => rmSync(join(d, SUMS)), 'SHA256SUMS is missing'],
      ['SHA256SUMS garbled', (d) => writeFileSync(join(d, SUMS), 'not a checksum\n'), 'is not "<sha256>  <file>"'],
    ];
    for (const [what, damage, message] of cases) {
      const { dir, names } = release();
      damage(dir, names);
      expect([what, verifyRelease(dir, { version: '1.0.0' }).problems.join('\n')]).toEqual([what, expect.stringContaining(message)]);
    }
  });

  test('a path in SHA256SUMS is refused (no ../ outside the release)', () => {
    expect(() => parseChecksums(`${'0'.repeat(64)}  ../../etc/passwd\n`)).toThrow('is not');
    expect(() => parseChecksums(`${'0'.repeat(64)}  a\n${'1'.repeat(64)}  a\n`)).toThrow('twice');
  });

  test('--signed needs a signature for every artifact and SHA256SUMS, checked with cosign against the release workflow', () => {
    const { dir, names } = release();
    expect(verifyRelease(dir, { version: '1.0.0', signed: true }).problems).toEqual([names.cyclonedx, names.spdx, names.tarball, SUMS].map((f) => `${f} has no signature (${f}.sigstore.json).`));
    // A stand-in for cosign that records its arguments and refuses: what it is asked to check matters.
    for (const f of readdirSync(dir)) writeFileSync(join(dir, `${f}.sigstore.json`), '{}');
    const fake = join(fresh(), 'cosign');
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${fake}.log"\necho "error: none of the expected identities matched" >&2\nexit 1\n`, { mode: 0o755 });
    const problems = verifyRelease(dir, { version: '1.0.0', signed: true, cosign: fake }).problems;
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain('none of the expected identities matched');
    const calls = readFileSync(`${fake}.log`, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(4);
    expect(calls[0]).toContain(`--certificate-identity ${releaseIdentity('1.0.0')} --certificate-oidc-issuer https://token.actions.githubusercontent.com`);
    expect(releaseIdentity('1.0.0')).toBe('https://github.com/iant89/ClawRouter/.github/workflows/release.yml@refs/tags/v1.0.0');
  });
});

describe('workflows (SEC-018, SEC-020)', () => {
  const workflows = readdirSync(join(repo, '.github', 'workflows')).filter((f) => f.endsWith('.yml'));
  const text = (f: string) => readFileSync(join(repo, '.github', 'workflows', f), 'utf8');
  const dockerBun = /oven\/bun:(\d+\.\d+\.\d+)/.exec(readFileSync(join(repo, 'Dockerfile'), 'utf8'))![1]!;

  test('every action is pinned to a full commit SHA, and Bun to the Dockerfile version', () => {
    for (const f of workflows) {
      const doc = Bun.YAML.parse(text(f)) as { jobs: Record<string, { uses?: string; steps?: { uses?: string; with?: { 'bun-version'?: string } }[] }> };
      for (const job of Object.values(doc.jobs)) {
        // A job that calls a workflow of this repository runs that file's steps, checked here too.
        if (job.uses) expect([f, job.uses]).toEqual([f, expect.stringMatching(/^\.\/\.github\/workflows\/[\w.-]+\.yml$/)]);
        for (const step of job.steps ?? []) {
          if (step.uses) expect([f, step.uses]).toEqual([f, expect.stringMatching(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)]);
          if (step.with?.['bun-version']) expect([f, step.with['bun-version']]).toEqual([f, dockerBun]);
        }
      }
    }
  });

  test('CI runs the dependency checks and the release dry run; the release signs, verifies, then publishes', () => {
    // CI runs the security pipeline (SEC-026), whose stages run the dependency checks and the release dry run.
    expect(text('ci.yml')).toContain('schedule:');
    expect(text('ci.yml')).toContain('uses: ./.github/workflows/security-pipeline.yml');
    expect(text('security-pipeline.yml')).toContain('bun install --frozen-lockfile');
    const stages = readFileSync(join(repo, 'scripts', 'security', 'pipeline.ts'), 'utf8');
    for (const s of ['scripts/deps.ts', "'package', '--skip-build'", "'verify', 'release'"]) expect(stages).toContain(s);
    const rel = Bun.YAML.parse(text('release.yml')) as { permissions: unknown; jobs: Record<string, { permissions: Record<string, string>; steps: { run?: string; uses?: string }[] }> };
    expect(rel.permissions).toEqual({});
    expect(rel.jobs.release!.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
    expect(rel.jobs['verify-published']!.permissions).toEqual({ contents: 'read' });
    const runs = rel.jobs.release!.steps.map((s) => s.run ?? s.uses ?? '');
    const at = (s: string) => runs.findIndex((r) => r.includes(s));
    expect((rel.jobs.release as unknown as { needs: string }).needs).toBe('security');
    expect(at('cosign sign-blob')).toBeGreaterThan(at('release:package'));
    expect(at('release:verify release --version "$VERSION" --signed')).toBeGreaterThan(at('cosign sign-blob'));
    expect(at('gh release create')).toBeGreaterThan(at('release:verify'));
    // No ${{ }} expression inside a script: values reach shells through env (no injection from tag names).
    for (const s of rel.jobs.release!.steps) if (s.run) expect(s.run).not.toContain('${{');
  });
});
