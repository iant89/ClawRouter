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
 * One view of ClawRouter's third-party packages (phase 6, SEC-018/019), read from
 * `bun.lock`, the workspace package.json files and the installed packages. The
 * lockfile check, the license scan and the SBOM all start here.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SupplyChainPolicy {
  lockfile: {
    /** Registries packages may come from ("" in bun.lock is the default, registry.npmjs.org). */
    registries: string[];
    /** Tarballs committed to the repository, as written in bun.lock, mapped to their path in the repository. */
    tarballs: Record<string, string>;
    /** Packages allowed to run install scripts (package.json `trustedDependencies`). */
    trustedDependencies: string[];
  };
  audit: {
    /** Severities that fail the check. */
    failOn: Severity[];
    exceptions: AuditException[];
  };
  licenses: {
    /** SPDX identifiers allowed in ClawRouter (AGPL-3.0-or-later): permissive licenses compatible with it. */
    allowed: string[];
    /** Packages whose license is set here, after checking by hand (no license field, or a wrong one). */
    packages: Record<string, { license: string; reason: string }>;
  };
}

export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

export interface AuditException {
  /** The advisory, e.g. GHSA-xxxx-xxxx-xxxx. */
  advisory: string;
  package: string;
  /** Why it does not affect ClawRouter, or why it cannot be fixed yet. */
  reason: string;
  /** YYYY-MM-DD: after this day the exception no longer applies. */
  expires: string;
}

export interface Workspace {
  path: string;
  name: string;
  version?: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}

/** A bun.lock `packages` entry, decoded. */
export interface LockEntry {
  /** The key in bun.lock: a name, or "parent/name" for a nested copy. */
  key: string;
  name: string;
  /** What follows the name: a version, "workspace:path", a tarball path, a git URL... */
  resolution: string;
  kind: 'registry' | 'workspace' | 'tarball' | 'other';
  /** Registry URL for registry packages ("" = the default registry). */
  registry?: string;
  integrity?: string;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  optionalPeers: string[];
}

export interface Lockfile {
  lockfileVersion: number;
  workspaces: Workspace[];
  entries: Map<string, LockEntry>;
}

/** bun.lock is JSON with trailing commas: drop the commas before } and ], outside strings. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return JSON.parse(out);
}

const record = (v: unknown): Record<string, string> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {});

/** Splits "name@resolution", where the name may be scoped (@scope/name@...). */
export function splitSpec(spec: string): { name: string; resolution: string } {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at < 0 ? { name: spec, resolution: '' } : { name: spec.slice(0, at), resolution: spec.slice(at + 1) };
}

export function parseLockfile(text: string): Lockfile {
  const raw = parseJsonc(text) as { lockfileVersion?: number; workspaces?: Record<string, Record<string, unknown>>; packages?: Record<string, unknown[]> };
  const workspaces: Workspace[] = Object.entries(raw.workspaces ?? {}).map(([path, w]) => ({
    path, name: String(w.name ?? ''), ...(typeof w.version === 'string' ? { version: w.version } : {}),
    dependencies: record(w.dependencies), devDependencies: record(w.devDependencies),
    optionalDependencies: record(w.optionalDependencies), peerDependencies: record(w.peerDependencies),
  }));
  const entries = new Map<string, LockEntry>();
  for (const [key, value] of Object.entries(raw.packages ?? {})) {
    if (!Array.isArray(value) || typeof value[0] !== 'string') throw new Error(`bun.lock: the entry "${key}" is not a package entry.`);
    const { name, resolution } = splitSpec(value[0]);
    const kind: LockEntry['kind'] = resolution.startsWith('workspace:') ? 'workspace'
      : /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(resolution) ? 'registry'
        : /\.(tgz|tar\.gz)$/.test(resolution) && !/^[a-z+]+:/.test(resolution) ? 'tarball' : 'other';
    // Registry entries: [spec, registry, info, integrity]; others: [spec, info, integrity].
    const info = record(kind === 'registry' ? value[2] : value[1]) as Record<string, unknown>;
    const integrity = value[value.length - 1];
    entries.set(key, {
      key, name, resolution, kind,
      ...(kind === 'registry' ? { registry: String(value[1] ?? '') } : {}),
      ...(typeof integrity === 'string' && integrity.startsWith('sha') ? { integrity } : {}),
      dependencies: record(info.dependencies), peerDependencies: record(info.peerDependencies),
      optionalDependencies: record(info.optionalDependencies),
      optionalPeers: Array.isArray(info.optionalPeers) ? (info.optionalPeers as string[]) : [],
    });
  }
  return { lockfileVersion: Number(raw.lockfileVersion ?? 0), workspaces, entries };
}

/** The entry a dependency of `from` resolves to: a nested copy ("from/name") first, then the hoisted one. */
export function resolveDependency(lock: Lockfile, from: string | null, name: string): LockEntry | undefined {
  if (from) {
    // bun.lock nests by path: "a/b/c" is c as seen from a/b.
    const parts = from.split('/');
    for (let i = parts.length; i > 0; i--) {
      const hit = lock.entries.get(`${parts.slice(0, i).join('/')}/${name}`);
      if (hit && hit.name === name) return hit;
    }
  }
  return lock.entries.get(name);
}

export interface ThirdPartyPackage {
  /** bun.lock key. */
  key: string;
  name: string;
  version: string;
  kind: 'registry' | 'tarball';
  registry?: string;
  /** The tarball path as written in bun.lock. */
  tarball?: string;
  integrity?: string;
  /** Needed at run time (reached from a workspace's dependencies), or only to build and test. */
  scope: 'runtime' | 'development';
  /** A dependency a workspace's package.json names (not only reached through another package). */
  direct: boolean;
  /** bun.lock keys of the packages this one depends on. */
  dependsOn: string[];
  license: string | null;
  licenseSource: 'package.json' | 'LICENSE file' | 'policy' | null;
  description?: string;
  homepage?: string;
  repository?: string;
}

const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'license', 'license.md'];
/** The license a LICENSE file's first lines name, for packages without a license field. */
export function licenseFromText(text: string): string | null {
  const head = text.slice(0, 400);
  if (/^\s*MIT License|Permission is hereby granted, free of charge/m.test(head) || /Permission is hereby granted, free of charge/.test(text.slice(0, 1200))) return 'MIT';
  if (/Apache License\s+Version 2\.0/.test(head)) return 'Apache-2.0';
  if (/^\s*ISC License/m.test(head)) return 'ISC';
  return null;
}

/** Finds an installed package (Bun's isolated layout first, then the hoisted one). */
export function installedPackageDir(root: string, name: string, version: string): string | null {
  const store = join(root, 'node_modules', '.bun');
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      const dir = join(store, entry, 'node_modules', name);
      const file = join(dir, 'package.json');
      if (existsSync(file)) {
        try {
          if ((JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version === version) return dir;
        } catch {
          // Not a package; keep looking.
        }
      }
    }
  }
  const hoisted = join(root, 'node_modules', name);
  if (existsSync(join(hoisted, 'package.json'))) {
    const v = (JSON.parse(readFileSync(join(hoisted, 'package.json'), 'utf8')) as { version?: string }).version;
    if (v === version) return hoisted;
  }
  return null;
}

const repoUrl = (r: unknown) => (typeof r === 'string' ? r : r && typeof r === 'object' && typeof (r as { url?: unknown }).url === 'string' ? (r as { url: string }).url : undefined);
const licenseOf = (l: unknown): string | null => {
  if (typeof l === 'string' && l.trim()) return l.trim();
  // Old style: { type: "MIT" } or [{ type }, ...].
  if (Array.isArray(l)) return l.map(licenseOf).filter(Boolean).join(' OR ') || null;
  if (l && typeof l === 'object' && typeof (l as { type?: unknown }).type === 'string') return (l as { type: string }).type;
  return null;
};

/**
 * Every third-party package in the lockfile, with its scope (runtime or development),
 * dependencies and license. `root` is the repository; installed packages are read for
 * licenses and versions of tarballs (run `bun install` first).
 */
export function thirdPartyPackages(root: string, lock: Lockfile, policy: SupplyChainPolicy): ThirdPartyPackage[] {
  const external = [...lock.entries.values()].filter((e) => e.kind === 'registry' || e.kind === 'tarball');
  const edges = new Map<string, string[]>();
  for (const e of lock.entries.values()) {
    const names = [...Object.keys(e.dependencies), ...Object.keys(e.optionalDependencies), ...Object.keys(e.peerDependencies).filter((p) => !e.optionalPeers.includes(p))];
    edges.set(e.key, [...new Set(names.map((n) => resolveDependency(lock, e.key, n)?.key).filter((k): k is string => !!k))]);
  }
  // Runtime: reached from any workspace's dependencies (not devDependencies), through any package.
  const reach = (starts: string[]) => {
    const seen = new Set<string>();
    const todo = [...starts];
    while (todo.length) {
      const k = todo.pop()!;
      if (seen.has(k)) continue;
      seen.add(k);
      todo.push(...(edges.get(k) ?? []));
    }
    return seen;
  };
  const rootsOf = (field: 'dependencies' | 'devDependencies') => lock.workspaces.flatMap((w) => [
    ...Object.keys(w[field]), ...(field === 'dependencies' ? [...Object.keys(w.optionalDependencies), ...Object.keys(w.peerDependencies)] : []),
  ]).map((n) => resolveDependency(lock, null, n)?.key).filter((k): k is string => !!k);
  const runtime = reach(rootsOf('dependencies'));
  const direct = new Set([...rootsOf('dependencies'), ...rootsOf('devDependencies')]);

  return external.map((e): ThirdPartyPackage => {
    let version = e.kind === 'registry' ? e.resolution : '';
    let dir: string | null = null;
    if (e.kind === 'tarball') {
      // The version of a tarball is only in its package.json.
      const store = join(root, 'node_modules', '.bun');
      if (existsSync(store)) {
        for (const entry of readdirSync(store)) {
          const file = join(store, entry, 'node_modules', e.name, 'package.json');
          if (entry.startsWith(e.name.replace('/', '+') + '@') && existsSync(file)) {
            dir = join(store, entry, 'node_modules', e.name);
            version = String((JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? '');
            break;
          }
        }
      }
    } else dir = installedPackageDir(root, e.name, version);
    const manifest = dir ? (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>) : {};
    let license = licenseOf(manifest.license ?? manifest.licenses);
    let licenseSource: ThirdPartyPackage['licenseSource'] = license ? 'package.json' : null;
    if (!license && dir) {
      const file = LICENSE_FILES.map((f) => join(dir!, f)).find((f) => existsSync(f));
      const found = file ? licenseFromText(readFileSync(file, 'utf8')) : null;
      if (found) [license, licenseSource] = [found, 'LICENSE file'];
    }
    const override = policy.licenses.packages[e.name];
    if (override) [license, licenseSource] = [override.license, 'policy'];
    return {
      key: e.key, name: e.name, version, kind: e.kind as 'registry' | 'tarball',
      ...(e.registry !== undefined ? { registry: e.registry } : {}),
      ...(e.kind === 'tarball' ? { tarball: e.resolution } : {}),
      ...(e.integrity ? { integrity: e.integrity } : {}),
      scope: runtime.has(e.key) ? 'runtime' : 'development',
      direct: direct.has(e.key),
      dependsOn: edges.get(e.key) ?? [],
      license, licenseSource,
      ...(typeof manifest.description === 'string' ? { description: manifest.description } : {}),
      ...(typeof manifest.homepage === 'string' ? { homepage: manifest.homepage } : {}),
      ...(repoUrl(manifest.repository) ? { repository: repoUrl(manifest.repository) } : {}),
    };
  }).sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name < b.name ? -1 : 1));
}

export function loadPolicy(root: string): SupplyChainPolicy {
  return JSON.parse(readFileSync(join(root, 'supply-chain.json'), 'utf8')) as SupplyChainPolicy;
}

export const loadLockfile = (root: string) => parseLockfile(readFileSync(join(root, 'bun.lock'), 'utf8'));

/** Hex digest of an SRI integrity value ("sha512-<base64>"). */
export function integrityHex(integrity: string): { algorithm: string; hex: string } | null {
  const m = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+=*)$/.exec(integrity);
  return m ? { algorithm: m[1]!, hex: Buffer.from(m[2]!, 'base64').toString('hex') } : null;
}
