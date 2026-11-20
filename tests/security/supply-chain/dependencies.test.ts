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

// SEC-018: a tampered or loosened lockfile, a disallowed license, or a high or critical advisory
// must fail the dependency check.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { judgeAudit, parseAudit } from '../../../scripts/supply-chain/audit.ts';
import { checkLicenses, declaredLicense, licenseAllowed, parseLicenseExpression } from '../../../scripts/supply-chain/licenses.ts';
import { checkBunPins, checkLockfile, readLockfile, sha512Integrity } from '../../../scripts/supply-chain/lockfile.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;

// A small project with one registry package and one vendored tarball.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
  lock?: (lock: Record<string, any>) => void;
  pkg?: (pkg: Record<string, any>) => void;
  files?: Record<string, string>;
}
function project(change: Fixture = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'clawrouter-deps-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'vendor'));
  const tarball = new TextEncoder().encode('vendored package bytes');
  writeFileSync(join(dir, 'vendor', 'ui.tgz'), tarball);
  const pkg: Record<string, any> = { name: 'demo', dependencies: { react: '19.3.1', ui: 'file:./vendor/ui.tgz' } };
  const lock: Record<string, any> = {
    lockfileVersion: 1,
    workspaces: { '': { name: 'demo', dependencies: { react: '19.3.1', ui: 'file:./vendor/ui.tgz' } } },
    packages: {
      react: ['react@19.3.1', '', {}, INTEGRITY],
      ui: ['ui@./vendor/ui.tgz', {}, sha512Integrity(tarball)],
    },
  };
  change.pkg?.(pkg);
  change.lock?.(lock);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(dir, 'bun.lock'), JSON.stringify(lock));
  for (const [name, text] of Object.entries(change.files ?? {})) writeFileSync(join(dir, name), text);
  return dir;
}
const problems = (change?: Fixture) => checkLockfile(project(change));

describe('lockfile verification', () => {
  test('the repository itself passes', () => {
    expect(checkLockfile(ROOT)).toEqual([]);
    expect(checkBunPins(ROOT)).toEqual([]);
  });

  test('a sound project passes', () => {
    expect(problems()).toEqual([]);
  });

  test('a package without an integrity hash', () => {
    expect(problems({ lock: (l) => { l.packages.react = ['react@19.3.1', '', {}]; } })).toEqual(['react@19.3.1: no integrity hash in bun.lock']);
  });

  test('a weaker hash than sha512', () => {
    expect(problems({ lock: (l) => { l.packages.react[3] = 'sha1-abcdefabcdefabcdefabcdefabc='; } })[0]).toContain('integrity is not a sha512 hash');
  });

  test('another registry', () => {
    expect(problems({ lock: (l) => { l.packages.react[1] = 'https://evil.example/npm/'; } })[0]).toContain('only the npm registry is allowed');
  });

  test('git, GitHub and URL sources', () => {
    for (const spec of ['react@github:someone/react#main', 'react@git+https://example.com/react.git', 'react@https://example.com/react.tgz']) {
      const found = problems({ lock: (l) => { l.packages.react = [spec, {}, INTEGRITY]; } });
      expect(found.some((p) => p.includes('only the npm registry and vendored tarballs'))).toBe(true);
    }
  });

  test('a vendored tarball that changed after locking', () => {
    const dir = project();
    writeFileSync(join(dir, 'vendor', 'ui.tgz'), 'swapped bytes');
    expect(checkLockfile(dir)[0]).toContain('does not match the integrity hash');
  });

  test('a tarball outside vendor/', () => {
    const found = problems({
      pkg: (p) => { p.dependencies.ui = 'file:../elsewhere/ui.tgz'; },
      lock: (l) => { l.workspaces[''].dependencies.ui = 'file:../elsewhere/ui.tgz'; l.packages.ui[0] = 'ui@../elsewhere/ui.tgz'; },
    });
    expect(found.some((p) => p.includes('is outside vendor/'))).toBe(true);
  });

  test('package.json and bun.lock disagree', () => {
    expect(problems({ pkg: (p) => { p.dependencies.react = '19.3.2'; } })[0]).toContain('bun.lock has "19.3.1"');
  });

  test('version ranges', () => {
    const found = problems({ pkg: (p) => { p.dependencies.react = '^19.3.1'; }, lock: (l) => { l.workspaces[''].dependencies.react = '^19.3.1'; } });
    expect(found).toContain('./package.json dependencies.react: "^19.3.1" is a range; pin an exact version');
  });

  test('dependencies allowed to run install scripts', () => {
    expect(problems({ pkg: (p) => { p.trustedDependencies = ['react']; } })[0]).toContain('trustedDependencies: react may run install scripts');
  });

  test('a registry override', () => {
    expect(problems({ files: { '.npmrc': 'registry=https://evil.example/\n' } })).toContain('.npmrc sets a registry; packages must come from the npm registry');
    expect(problems({ files: { 'bunfig.toml': '[install]\nregistry = "https://evil.example/"\n' } })).toContain('bunfig.toml sets a registry; packages must come from the npm registry');
  });

  test('Bun pinned to different versions', () => {
    const dir = project({ files: { Dockerfile: 'FROM oven/bun:1.4.5-slim\n' } });
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'with:\n  bun-version: 1.4.4\n');
    expect(checkBunPins(dir)[0]).toContain('Bun versions disagree');
  });
});

describe('license scanning', () => {
  test('every installed dependency has an allowed license', () => {
    expect(checkLicenses(ROOT, readLockfile(ROOT))).toEqual([]);
  });

  test('SPDX expressions', () => {
    expect(licenseAllowed('MIT')).toBe(true);
    expect(licenseAllowed('(MIT OR GPL-3.0-only)')).toBe(true);
    expect(licenseAllowed('MIT AND GPL-3.0-only')).toBe(false);
    expect(licenseAllowed('(Apache-2.0 AND (MIT OR GPL-2.0-only))')).toBe(true);
    expect(licenseAllowed('GPL-2.0-only')).toBe(false);
    expect(licenseAllowed('Apache-2.0 WITH LLVM-exception')).toBe(false);
    expect(licenseAllowed('Apache-2.0 WITH LLVM-exception', ['Apache-2.0 WITH LLVM-exception'])).toBe(true);
    for (const bad of ['UNLICENSED', 'SEE LICENSE IN LICENSE.txt', '(MIT', 'MIT OR', '', 'AND MIT']) expect([bad, licenseAllowed(bad)]).toEqual([bad, false]);
    expect(() => parseLicenseExpression('MIT OR')).toThrow();
  });

  test('legacy license fields', () => {
    expect(declaredLicense({ license: { type: 'ISC' } })).toBe('ISC');
    expect(declaredLicense({ licenses: [{ type: 'MIT' }, { type: 'GPL-2.0-only' }] })).toBe('(MIT) AND (GPL-2.0-only)');
    expect(licenseAllowed(declaredLicense({ licenses: [{ type: 'MIT' }, { type: 'GPL-2.0-only' }] })!)).toBe(false);
    expect(declaredLicense({})).toBeNull();
  });

  test('a package with a disallowed or missing license fails', () => {
    const dir = project();
    const install = (name: string, json: object) => {
      mkdirSync(join(dir, 'node_modules', name), { recursive: true });
      writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify(json));
    };
    install('react', { name: 'react', version: '19.3.1', license: 'SSPL-1.0' });
    install('ui', { name: 'ui', version: '1.0.0' });
    expect(checkLicenses(dir, readLockfile(dir))).toEqual([
      'react@19.3.1: license "SSPL-1.0" is not in ALLOWED_LICENSES; review it first',
      'ui@1.0.0: no license stated; review it and add it to LICENSE_OVERRIDES',
    ]);
  });
});

describe('vulnerability audit', () => {
  // Real `bun audit --json` output for lodash 4.17.15 and minimist 1.2.0 (trimmed).
  const fixture = readFileSync(join(import.meta.dir, 'fixtures', 'bun-audit.json'), 'utf8');
  const now = new Date('2026-11-20T12:00:00Z');

  test('high and critical advisories fail, lower ones warn', () => {
    const result = judgeAudit(parseAudit(fixture), now, []);
    expect(result.failures.map((f) => f.split(' ').slice(0, 3).join(' '))).toEqual([
      'lodash: high GHSA-35jh-r3h4-6jhm', 'minimist: critical GHSA-xvch-5gv4-984h',
    ]);
    expect(result.warnings.map((f) => f.split(' ').slice(0, 3).join(' '))).toEqual(['lodash: moderate GHSA-29mw-wpgm-hmr9']);
  });

  test('nothing found passes', () => {
    expect(judgeAudit(parseAudit('{}'), now, [])).toEqual({ failures: [], warnings: [] });
  });

  test('an accepted advisory warns until its exception expires', () => {
    const exception = { id: 'GHSA-xvch-5gv4-984h', package: 'minimist', reason: 'not reachable', expires: '2026-12-01' };
    const active = judgeAudit(parseAudit(fixture), now, [exception]);
    expect(active.failures).toHaveLength(1);
    expect(active.warnings.some((w) => w.includes('accepted until 2026-12-01'))).toBe(true);
    const expired = judgeAudit(parseAudit(fixture), new Date('2026-12-02T00:00:00Z'), [exception]);
    expect(expired.failures.some((f) => f.includes('the exception expired on 2026-12-01'))).toBe(true);
  });

  test('an exception only covers its own package', () => {
    const wrong = { id: 'GHSA-xvch-5gv4-984h', package: 'lodash', reason: 'typo', expires: '2099-01-01' };
    expect(judgeAudit(parseAudit(fixture), now, [wrong]).failures).toHaveLength(2);
  });

  test('an unknown severity counts as critical', () => {
    const advisories = parseAudit(JSON.stringify({ x: [{ id: 1, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'severe' }] }));
    expect(advisories[0]!.severity).toBe('critical');
    expect(judgeAudit(advisories, now, []).failures).toHaveLength(1);
  });

  test('an unreadable answer fails closed', () => {
    for (const bad of ['', 'error: could not reach the registry', '[]', '{"x": "y"}']) expect(() => parseAudit(bad)).toThrow();
  });
});
