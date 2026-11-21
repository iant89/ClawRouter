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
 * Software bill of materials (SEC-019): SPDX 2.3 and CycloneDX 1.6, both JSON.
 * The same inputs always give the same bytes (sorted, the time from
 * SOURCE_DATE_EPOCH or the commit), so a release's SBOM can be rebuilt and compared.
 */
// security-waiver: sqlite-outside-database -- reads only sqlite_version() for the SBOM, no ClawRouter data
import { Database } from 'bun:sqlite';
import { integrityHex, type ThirdPartyPackage } from './packages.ts';

export interface SbomInput {
  /** ClawRouter's version (package.json). */
  version: string;
  /** The commit the release is built from, if known. */
  commit?: string;
  /** ISO time the SBOM describes (the commit time for a release). */
  created: string;
  packages: ThirdPartyPackage[];
  /** The runtime the build runs on: Bun, and the SQLite it embeds. */
  runtime: { bun: string; sqlite: string };
}

const REPO = 'https://github.com/iant89/ClawRouter';
const APP_LICENSE = 'AGPL-3.0-or-later';

/** The runtime this process runs on (the release workflow pins it). */
export function currentRuntime(): { bun: string; sqlite: string } {
  const db = new Database(':memory:');
  try {
    return { bun: Bun.version, sqlite: (db.query('SELECT sqlite_version() AS v').get() as { v: string }).v };
  } finally {
    db.close();
  }
}

/** A package URL (purl): pkg:npm/%40scope/name@version. */
export const npmPurl = (name: string, version: string) => `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;

/** The registry download of a package, for SPDX's downloadLocation. */
const downloadLocation = (p: ThirdPartyPackage) => {
  if (p.kind === 'tarball') return 'NOASSERTION';
  const base = p.name.split('/').pop()!;
  return `https://registry.npmjs.org/${p.name}/-/${base}-${p.version}.tgz`;
};

/** Deterministic UUID-shaped text from content (for CycloneDX's serialNumber). */
function contentUuid(text: string): string {
  const h = new Bun.CryptoHasher('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const spdxId = (p: ThirdPartyPackage) => `SPDXRef-npm-${`${p.name}-${p.version}`.replace(/[^A-Za-z0-9.-]/g, '-')}`;
const bomRef = (p: ThirdPartyPackage) => npmPurl(p.name, p.version);
const sortedPackages = (input: SbomInput) => [...input.packages].sort((a, b) => (bomRef(a) < bomRef(b) ? -1 : bomRef(a) > bomRef(b) ? 1 : 0));

/** An SPDX 2.3 document (JSON). */
export function spdx(input: SbomInput): Record<string, unknown> {
  const packages = sortedPackages(input);
  const byKey = new Map(packages.map((p) => [p.key, p]));
  const fingerprint = new Bun.CryptoHasher('sha256').update(JSON.stringify([input.version, input.commit, packages.map(bomRef)])).digest('hex').slice(0, 16);
  const app = {
    name: 'clawrouter', SPDXID: 'SPDXRef-ClawRouter', versionInfo: input.version,
    downloadLocation: input.commit ? `git+${REPO}.git@${input.commit}` : `git+${REPO}.git`,
    filesAnalyzed: false, licenseConcluded: APP_LICENSE, licenseDeclared: APP_LICENSE, copyrightText: 'Copyright (C) 2026 Ian Thomas',
    supplier: 'Person: Ian Thomas', homepage: REPO, primaryPackagePurpose: 'APPLICATION',
    externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:github/iant89/ClawRouter@v${input.version}` }],
  };
  const runtime = [
    { name: 'bun', SPDXID: 'SPDXRef-runtime-bun', versionInfo: input.runtime.bun, downloadLocation: `https://github.com/oven-sh/bun/releases/tag/bun-v${input.runtime.bun}`, filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: 'MIT', copyrightText: 'NOASSERTION', primaryPackagePurpose: 'APPLICATION', comment: 'The runtime ClawRouter runs on.', externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:github/oven-sh/bun@bun-v${input.runtime.bun}` }] },
    { name: 'sqlite', SPDXID: 'SPDXRef-runtime-sqlite', versionInfo: input.runtime.sqlite, downloadLocation: 'https://www.sqlite.org/download.html', filesAnalyzed: false, licenseConcluded: 'NOASSERTION', licenseDeclared: 'blessing', copyrightText: 'NOASSERTION', primaryPackagePurpose: 'LIBRARY', comment: 'Embedded in Bun (bun:sqlite); stores all of ClawRouter\'s data.' },
  ];
  const doc = {
    spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name: `clawrouter-${input.version}`,
    documentNamespace: `${REPO}/sbom/spdx/clawrouter-${input.version}-${fingerprint}`,
    creationInfo: { created: input.created, creators: [`Tool: clawrouter-sbom-${input.version}`, 'Organization: ClawRouter'] },
    documentDescribes: ['SPDXRef-ClawRouter'],
    packages: [app, ...runtime, ...packages.map((p) => {
      const hash = p.integrity ? integrityHex(p.integrity) : null;
      return {
        name: p.name, SPDXID: spdxId(p), versionInfo: p.version, downloadLocation: downloadLocation(p), filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION', licenseDeclared: p.license ?? 'NOASSERTION', copyrightText: 'NOASSERTION',
        ...(p.homepage ? { homepage: p.homepage } : {}), ...(p.description ? { summary: p.description.slice(0, 500) } : {}),
        ...(hash ? { checksums: [{ algorithm: hash.algorithm.toUpperCase(), checksumValue: hash.hex }] } : {}),
        primaryPackagePurpose: 'LIBRARY',
        comment: p.scope === 'runtime' ? 'Runtime dependency (in the release bundle).' : 'Development dependency (build and tests only; not in the release bundle).',
        externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: npmPurl(p.name, p.version) }],
      };
    })],
    relationships: [
      { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: 'SPDXRef-ClawRouter' },
      { spdxElementId: 'SPDXRef-ClawRouter', relationshipType: 'DEPENDS_ON', relatedSpdxElement: 'SPDXRef-runtime-bun' },
      { spdxElementId: 'SPDXRef-runtime-bun', relationshipType: 'CONTAINS', relatedSpdxElement: 'SPDXRef-runtime-sqlite' },
      // ClawRouter's direct dependencies; the rest follow from each package's own DEPENDS_ON.
      ...packages.filter((p) => p.direct).map((p) => p.scope === 'runtime'
        ? { spdxElementId: 'SPDXRef-ClawRouter', relationshipType: 'DEPENDS_ON', relatedSpdxElement: spdxId(p) }
        : { spdxElementId: spdxId(p), relationshipType: 'DEV_DEPENDENCY_OF', relatedSpdxElement: 'SPDXRef-ClawRouter' }),
      ...packages.flatMap((p) => p.dependsOn.map((k) => byKey.get(k)).filter((d): d is ThirdPartyPackage => !!d).map((d) => ({ spdxElementId: spdxId(p), relationshipType: 'DEPENDS_ON', relatedSpdxElement: spdxId(d) }))),
    ],
  };
  return doc;
}

/** A CycloneDX 1.6 BOM (JSON). */
export function cyclonedx(input: SbomInput): Record<string, unknown> {
  const packages = sortedPackages(input);
  const byKey = new Map(packages.map((p) => [p.key, p]));
  const appRef = `pkg:github/iant89/ClawRouter@v${input.version}`;
  const bunRef = `pkg:github/oven-sh/bun@bun-v${input.runtime.bun}`;
  const serial = contentUuid(JSON.stringify([input.version, input.commit, input.created, packages.map(bomRef), input.runtime]));
  return {
    $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: `urn:uuid:${serial}`, version: 1,
    metadata: {
      timestamp: input.created,
      tools: { components: [{ type: 'application', name: 'clawrouter-sbom', version: input.version }] },
      component: {
        type: 'application', 'bom-ref': appRef, name: 'clawrouter', version: input.version, purl: appRef,
        description: 'Self-hosted AI gateway and control platform', licenses: [{ license: { id: APP_LICENSE } }],
        supplier: { name: 'Ian Thomas', url: [REPO] }, copyright: 'Copyright (C) 2026 Ian Thomas',
        externalReferences: [{ type: 'vcs', url: `${REPO}.git` }, { type: 'website', url: REPO }],
        ...(input.commit ? { properties: [{ name: 'clawrouter:commit', value: input.commit }] } : {}),
      },
    },
    components: [
      {
        type: 'platform', 'bom-ref': bunRef, name: 'bun', version: input.runtime.bun, purl: bunRef, scope: 'required',
        description: 'The runtime ClawRouter runs on', licenses: [{ license: { id: 'MIT' } }],
        externalReferences: [{ type: 'website', url: 'https://bun.sh' }],
        components: [{ type: 'library', 'bom-ref': 'runtime:sqlite', name: 'sqlite', version: input.runtime.sqlite, scope: 'required', description: 'Embedded in Bun (bun:sqlite)', licenses: [{ license: { name: 'blessing (public domain)' } }] }],
      },
      ...packages.map((p) => {
        const hash = p.integrity ? integrityHex(p.integrity) : null;
        return {
          type: 'library', 'bom-ref': bomRef(p), name: p.name, version: p.version, purl: npmPurl(p.name, p.version),
          scope: p.scope === 'runtime' ? 'required' : 'excluded',
          ...(p.description ? { description: p.description.slice(0, 500) } : {}),
          ...(p.license ? { licenses: /\s(OR|AND|WITH)\s/.test(p.license) ? [{ expression: p.license }] : [{ license: { id: p.license } }] } : {}),
          ...(hash ? { hashes: [{ alg: hash.algorithm.toUpperCase().replace('SHA', 'SHA-'), content: hash.hex }] } : {}),
          ...(p.repository || p.homepage ? { externalReferences: [...(p.repository ? [{ type: 'vcs', url: p.repository }] : []), ...(p.homepage ? [{ type: 'website', url: p.homepage }] : [])] } : {}),
          properties: [{ name: 'clawrouter:scope', value: p.scope }, ...(p.tarball ? [{ name: 'clawrouter:source', value: 'vendored tarball' }] : [])],
        };
      }),
    ],
    dependencies: [
      { ref: appRef, dependsOn: [bunRef, ...packages.filter((p) => p.direct).map(bomRef)].sort() },
      { ref: bunRef, dependsOn: ['runtime:sqlite'] },
      { ref: 'runtime:sqlite', dependsOn: [] },
      ...packages.map((p) => ({ ref: bomRef(p), dependsOn: p.dependsOn.map((k) => byKey.get(k)).filter((d): d is ThirdPartyPackage => !!d).map(bomRef).sort() })),
    ],
  };
}

/** Pretty JSON with a final newline: what is written to disk and hashed. */
export const sbomText = (doc: Record<string, unknown>) => `${JSON.stringify(doc, null, 2)}\n`;
