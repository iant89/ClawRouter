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
 * Software bill of materials (SEC-019), in SPDX 2.3 and CycloneDX 1.6 JSON, built from bun.lock
 * and the installed packages: the application and its version, every dependency with its
 * version, hash and license, whether it ships in the release (runtime) or is only used to build
 * and test it (development), and the runtime it needs (Bun, and the SQLite built into Bun).
 * The output is deterministic for a given commit: no random ids, no wall-clock time.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSqlite } from '@clawrouter/database';
import { readLicenses } from './licenses.ts';
import { resolveDependency, type Lockfile, type LockedPackage } from './lockfile.ts';

export const REPOSITORY = 'https://github.com/iant89/ClawRouter';

export interface SbomInput {
  root: string;
  lock: Lockfile;
  /** Application version (root package.json). */
  version: string;
  commit: string;
  /** Seconds since the epoch: the commit time, so the same commit gives the same SBOM. */
  timestamp: number;
  bunVersion: string;
  sqliteVersion: string;
}

export interface SbomComponent {
  name: string;
  version: string;
  scope: 'runtime' | 'development';
  license: string | null;
  /** Hex SHA-512 of the package tarball (from the lockfile's integrity). */
  sha512: string | null;
  purl: string;
  download: string | null;
  /** Lockfile key, for the dependency graph. */
  key: string;
  dependsOn: string[];
  /** Named by a workspace package.json (not only reached through another package). */
  direct: boolean;
  vendored: boolean;
}

export const purlOf = (name: string, version: string) =>
  `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;

const hexOfIntegrity = (integrity: string | null) =>
  integrity?.startsWith('sha512-') ? Buffer.from(integrity.slice(7), 'base64').toString('hex') : null;

/** Every third-party package, marked runtime when anything a workspace depends on (not dev) reaches it. */
export function components(input: SbomInput): SbomComponent[] {
  const { lock } = input;
  const third = lock.packages.filter((p) => p.source.kind !== 'workspace');
  const edges = (p: LockedPackage): LockedPackage[] => {
    const names = [
      ...Object.keys(p.dependencies), ...Object.keys(p.optionalDependencies),
      ...Object.keys(p.peerDependencies).filter((n) => !p.optionalPeers.includes(n)),
    ];
    return names.map((n) => resolveDependency(lock, p.key, n)).filter((x): x is LockedPackage => !!x);
  };
  const reach = (roots: string[]) => {
    const seen = new Set<string>();
    const stack = roots.map((n) => resolveDependency(lock, null, n)).filter((x): x is LockedPackage => !!x);
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p.key)) continue;
      seen.add(p.key);
      stack.push(...edges(p));
    }
    return seen;
  };
  const runtimeRoots = lock.workspaces.flatMap((w) => [...Object.keys(w.dependencies), ...Object.keys(w.optionalDependencies)]);
  const runtime = reach(runtimeRoots);
  const direct = new Set(lock.workspaces.flatMap((w) => [...runtimeRoots, ...Object.keys(w.devDependencies)]).map((n) => resolveDependency(lock, null, n)?.key));
  const licenses = new Map(readLicenses(input.root, lock).map((l) => [l.pkg.key, l]));
  return third.map((p) => {
    const info = licenses.get(p.key);
    const version = info?.version || p.version;
    return {
      name: p.name,
      version,
      scope: runtime.has(p.key) ? 'runtime' : 'development',
      license: info?.license ?? null,
      sha512: hexOfIntegrity(p.integrity),
      purl: purlOf(p.name, version),
      download: p.source.kind === 'registry' ? `https://registry.npmjs.org/${p.name}/-/${p.name.split('/').pop()}-${version}.tgz` : null,
      key: p.key,
      dependsOn: edges(p).filter((d) => d.source.kind !== 'workspace').map((d) => d.key),
      direct: direct.has(p.key),
      vendored: p.source.kind === 'tarball',
    } satisfies SbomComponent;
  }).sort((a, b) => a.purl.localeCompare(b.purl));
}

/** A UUID derived from the content, so the serial number is stable for one commit. */
function stableUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const isoSeconds = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const appPurl = (v: string) => `pkg:github/iant89/clawrouter@v${v}`;
const bunPurl = (v: string) => `pkg:github/oven-sh/bun@bun-v${v}`;
const sqlitePurl = (v: string) => `pkg:generic/sqlite@${v}`;

export function cycloneDx(input: SbomInput, comps: SbomComponent[] = components(input)): Record<string, unknown> {
  const app = appPurl(input.version);
  const byKey = new Map(comps.map((c) => [c.key, c.purl]));
  const license = (l: string | null) => (l ? [/\s(AND|OR|WITH)\s/.test(l) ? { expression: l } : { license: { id: l } }] : undefined);
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${stableUuid(`cyclonedx ${input.version} ${input.commit}`)}`,
    version: 1,
    metadata: {
      timestamp: isoSeconds(input.timestamp),
      tools: { components: [{ type: 'application', name: 'clawrouter-sbom', version: input.version }] },
      component: {
        type: 'application',
        'bom-ref': app,
        name: 'clawrouter',
        version: input.version,
        description: 'ClawRouter: self-hosted AI model gateway and control platform.',
        licenses: [{ license: { id: 'AGPL-3.0-or-later' } }],
        purl: app,
        externalReferences: [{ type: 'vcs', url: `${REPOSITORY}.git` }, { type: 'website', url: REPOSITORY }],
      },
      properties: [{ name: 'clawrouter:git-commit', value: input.commit }],
    },
    components: [
      ...comps.map((c) => ({
        type: 'library',
        'bom-ref': c.purl,
        ...(c.name.startsWith('@') ? { group: c.name.split('/')[0], name: c.name.split('/')[1] } : { name: c.name }),
        version: c.version,
        // Development packages are not in the release bundle.
        scope: c.scope === 'runtime' ? 'required' : 'excluded',
        ...(c.sha512 ? { hashes: [{ alg: 'SHA-512', content: c.sha512 }] } : {}),
        ...(license(c.license) ? { licenses: license(c.license) } : {}),
        purl: c.purl,
        ...(c.download ? { externalReferences: [{ type: 'distribution', url: c.download }] } : {}),
        properties: [
          { name: 'clawrouter:dependency-kind', value: c.scope },
          ...(c.vendored ? [{ name: 'clawrouter:source', value: 'vendored tarball in vendor/' }] : []),
        ],
      })),
      {
        type: 'platform',
        'bom-ref': bunPurl(input.bunVersion),
        name: 'bun',
        version: input.bunVersion,
        description: 'JavaScript runtime ClawRouter runs on (the version this release was built and tested with).',
        scope: 'required',
        licenses: [{ license: { id: 'MIT' } }],
        purl: bunPurl(input.bunVersion),
        externalReferences: [{ type: 'website', url: 'https://bun.sh' }],
        properties: [{ name: 'clawrouter:dependency-kind', value: 'runtime' }],
        components: [{
          type: 'library',
          'bom-ref': sqlitePurl(input.sqliteVersion),
          name: 'sqlite',
          version: input.sqliteVersion,
          description: 'SQLite built into Bun (bun:sqlite), ClawRouter\'s database.',
          scope: 'required',
          licenses: [{ license: { name: 'blessing' } }],
          purl: sqlitePurl(input.sqliteVersion),
          properties: [{ name: 'clawrouter:dependency-kind', value: 'runtime' }],
        }],
      },
    ],
    dependencies: [
      {
        ref: app,
        dependsOn: [...comps.filter((c) => c.scope === 'runtime' && c.direct).map((c) => c.purl), bunPurl(input.bunVersion)].sort(),
      },
      { ref: bunPurl(input.bunVersion), dependsOn: [sqlitePurl(input.sqliteVersion)] },
      { ref: sqlitePurl(input.sqliteVersion), dependsOn: [] },
      ...comps.map((c) => ({ ref: c.purl, dependsOn: c.dependsOn.map((k) => byKey.get(k)!).filter(Boolean).sort() })),
    ],
  };
}

const spdxId = (s: string) => `SPDXRef-${s.replace(/[^A-Za-z0-9.-]+/g, '-')}`;

export function spdx(input: SbomInput, comps: SbomComponent[] = components(input)): Record<string, unknown> {
  const appId = spdxId('Package-clawrouter');
  const bunId = spdxId('Package-bun');
  const sqliteId = spdxId('Package-sqlite');
  const idOf = (c: SbomComponent) => spdxId(`Package-npm-${c.name}-${c.version}`);
  const byKey = new Map(comps.map((c) => [c.key, idOf(c)]));
  const purlRef = (purl: string) => [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: purl }];
  const relationships: Record<string, string>[] = [{ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: appId }];
  for (const c of comps) {
    const id = idOf(c);
    if (c.scope === 'development' && c.direct) relationships.push({ spdxElementId: id, relationshipType: 'DEV_DEPENDENCY_OF', relatedSpdxElement: appId });
    else if (c.scope === 'runtime' && c.direct) relationships.push({ spdxElementId: appId, relationshipType: 'DEPENDS_ON', relatedSpdxElement: id });
    for (const d of c.dependsOn) relationships.push({ spdxElementId: id, relationshipType: 'DEPENDS_ON', relatedSpdxElement: byKey.get(d)! });
  }
  relationships.push({ spdxElementId: bunId, relationshipType: 'RUNTIME_DEPENDENCY_OF', relatedSpdxElement: appId });
  relationships.push({ spdxElementId: bunId, relationshipType: 'CONTAINS', relatedSpdxElement: sqliteId });
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `clawrouter-${input.version}`,
    documentNamespace: `${REPOSITORY}/sbom/clawrouter-${input.version}-${input.commit}`,
    creationInfo: { created: isoSeconds(input.timestamp), creators: [`Tool: clawrouter-sbom-${input.version}`, 'Person: Ian Thomas'] },
    documentDescribes: [appId],
    packages: [
      {
        name: 'clawrouter',
        SPDXID: appId,
        versionInfo: input.version,
        downloadLocation: `git+${REPOSITORY}.git@${input.commit}`,
        filesAnalyzed: false,
        licenseConcluded: 'AGPL-3.0-or-later',
        licenseDeclared: 'AGPL-3.0-or-later',
        copyrightText: 'Copyright (C) 2026 Ian Thomas',
        supplier: 'Person: Ian Thomas',
        homepage: REPOSITORY,
        primaryPackagePurpose: 'APPLICATION',
        externalRefs: purlRef(appPurl(input.version)),
      },
      ...comps.map((c) => ({
        name: c.name,
        SPDXID: idOf(c),
        versionInfo: c.version,
        downloadLocation: c.download ?? 'NOASSERTION',
        filesAnalyzed: false,
        ...(c.sha512 ? { checksums: [{ algorithm: 'SHA512', checksumValue: c.sha512 }] } : {}),
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: c.license ?? 'NOASSERTION',
        copyrightText: 'NOASSERTION',
        primaryPackagePurpose: 'LIBRARY',
        externalRefs: purlRef(c.purl),
        comment: c.scope === 'runtime' ? 'Runtime dependency: bundled into the release.' : 'Development dependency: used to build and test, not in the release.',
      })),
      {
        name: 'bun',
        SPDXID: bunId,
        versionInfo: input.bunVersion,
        downloadLocation: `https://github.com/oven-sh/bun/releases/tag/bun-v${input.bunVersion}`,
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: 'MIT',
        copyrightText: 'NOASSERTION',
        primaryPackagePurpose: 'APPLICATION',
        externalRefs: purlRef(bunPurl(input.bunVersion)),
        comment: 'Runtime dependency: the JavaScript runtime ClawRouter runs on (the version this release was built and tested with).',
      },
      {
        name: 'sqlite',
        SPDXID: sqliteId,
        versionInfo: input.sqliteVersion,
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: 'LicenseRef-SQLite-blessing',
        copyrightText: 'NONE',
        primaryPackagePurpose: 'LIBRARY',
        externalRefs: purlRef(sqlitePurl(input.sqliteVersion)),
        comment: 'Runtime dependency: SQLite built into Bun (bun:sqlite), ClawRouter\'s database.',
      },
    ],
    hasExtractedLicensingInfos: [{
      licenseId: 'LicenseRef-SQLite-blessing',
      name: 'SQLite blessing (public domain)',
      extractedText: 'The author disclaims copyright to this source code. In place of a legal notice, here is a blessing.',
    }],
    relationships,
  };
}

/** Reads the inputs from the repository and the running Bun. */
export function sbomInput(root: string, lock: Lockfile, commit: string, timestamp: number): SbomInput {
  const db = openSqlite({ path: ':memory:' });
  const sqliteVersion = db.get<{ v: string }>('select sqlite_version() as v')!.v;
  db.close();
  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  return { root, lock, version, commit, timestamp, bunVersion: Bun.version, sqliteVersion };
}
