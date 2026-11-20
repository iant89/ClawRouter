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
 * Reads bun.lock and checks it (SEC-018, lockfile verification): every package pinned by an
 * integrity hash, from the npm registry or a vendored tarball whose hash matches, the
 * lockfile agreeing with every package.json, exact versions, no install scripts.
 * `bun install --frozen-lockfile` (CI) refuses a lockfile that does not match package.json;
 * this check also covers where packages come from and how they are pinned.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative as relativePath } from 'node:path';
import { ALLOWED_LIFECYCLE_SCRIPTS, ALLOWED_REGISTRIES, ALLOWED_TARBALL_DIR } from './policy.ts';

export type PackageSource =
  | { kind: 'workspace'; path: string }
  | { kind: 'registry'; registry: string }
  | { kind: 'tarball'; path: string }
  | { kind: 'other'; spec: string };

export interface LockedPackage {
  /** The key in bun.lock ("react", or "parent/react" for a nested copy). */
  key: string;
  name: string;
  version: string;
  source: PackageSource;
  integrity: string | null;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  optionalPeers: string[];
}

export interface Workspace {
  /** "" for the root. */
  path: string;
  name: string;
  version?: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}

export interface Lockfile {
  lockfileVersion: number;
  workspaces: Workspace[];
  packages: LockedPackage[];
  /** Root package.json `trustedDependencies` as recorded in the lockfile, if any. */
  trustedDependencies: string[];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const strings = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(obj(v)).filter(([, s]) => typeof s === 'string')) as Record<string, string>;

/** "name@spec" -> [name, spec]; scoped names keep their leading "@". */
export function splitSpec(id: string): [string, string] {
  const at = id.indexOf('@', 1);
  return at < 0 ? [id, ''] : [id.slice(0, at), id.slice(at + 1)];
}

export function parseLockfile(text: string): Lockfile {
  const raw = obj(Bun.JSONC.parse(text));
  const lockfileVersion = Number(raw.lockfileVersion);
  const workspaces = Object.entries(obj(raw.workspaces)).map(([path, w]) => {
    const ws = obj(w);
    return {
      path,
      name: String(ws.name ?? ''),
      ...(typeof ws.version === 'string' ? { version: ws.version } : {}),
      dependencies: strings(ws.dependencies),
      devDependencies: strings(ws.devDependencies),
      optionalDependencies: strings(ws.optionalDependencies),
      peerDependencies: strings(ws.peerDependencies),
    };
  });
  const packages: LockedPackage[] = [];
  for (const [key, entry] of Object.entries(obj(raw.packages))) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') throw new Error(`bun.lock: unreadable entry for ${key}`);
    const [name, spec] = splitSpec(entry[0]);
    let source: PackageSource;
    let meta: Json = {};
    let integrity: string | null = null;
    let version = spec;
    if (spec.startsWith('workspace:')) {
      source = { kind: 'workspace', path: spec.slice('workspace:'.length) };
      version = '';
    } else if (typeof entry[1] === 'string') {
      // Registry package: [id, registry, meta, integrity].
      source = { kind: 'registry', registry: entry[1] };
      meta = obj(entry[2]);
      integrity = typeof entry[3] === 'string' ? entry[3] : null;
    } else if (/\.t(ar\.)?gz$/.test(spec) && !/^[a-z+]+:\/\//.test(spec)) {
      // Local tarball: [id, meta, integrity]. The path is relative to the workspace that named it.
      source = { kind: 'tarball', path: spec };
      meta = obj(entry[1]);
      integrity = typeof entry[2] === 'string' ? entry[2] : null;
      version = '';
    } else {
      source = { kind: 'other', spec };
      meta = obj(entry[1]);
      version = '';
    }
    packages.push({
      key, name, version, source, integrity,
      dependencies: strings(meta.dependencies),
      optionalDependencies: strings(meta.optionalDependencies),
      peerDependencies: strings(meta.peerDependencies),
      optionalPeers: Array.isArray(meta.optionalPeers) ? meta.optionalPeers.filter((p): p is string => typeof p === 'string') : [],
    });
  }
  const trusted = Array.isArray(raw.trustedDependencies) ? raw.trustedDependencies.filter((t): t is string => typeof t === 'string') : [];
  return { lockfileVersion, workspaces, packages, trustedDependencies: trusted };
}

export function readLockfile(root: string): Lockfile {
  return parseLockfile(readFileSync(join(root, 'bun.lock'), 'utf8'));
}

/** The lockfile entry a dependency of `from` resolves to: a nested copy first, then the hoisted one. */
export function resolveDependency(lock: Lockfile, from: string | null, name: string): LockedPackage | undefined {
  const byKey = new Map(lock.packages.map((p) => [p.key, p]));
  if (from) {
    const parts = from.split('/');
    // Scoped keys have two segments per package; walk up "a/b/c" -> "a/b/c/name", "a/b/name", ...
    for (let i = parts.length; i > 0; i--) {
      const hit = byKey.get(`${parts.slice(0, i).join('/')}/${name}`);
      if (hit) return hit;
    }
  }
  return byKey.get(name);
}

export function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** Every problem found in the lockfile and package.json files; empty when all is well. */
export function checkLockfile(root: string, lock: Lockfile = readLockfile(root)): string[] {
  const problems: string[] = [];
  if (lock.lockfileVersion !== 1 && lock.lockfileVersion !== 2) problems.push(`bun.lock: unknown lockfileVersion ${lock.lockfileVersion}`);

  for (const p of lock.packages) {
    const id = `${p.name}${p.version ? `@${p.version}` : ''}`;
    switch (p.source.kind) {
      case 'workspace':
        continue;
      case 'other':
        problems.push(`${id}: comes from "${p.source.spec}"; only the npm registry and vendored tarballs are allowed`);
        continue;
      case 'registry':
        if (!ALLOWED_REGISTRIES.includes(p.source.registry)) problems.push(`${id}: comes from the registry ${p.source.registry}; only the npm registry is allowed`);
        if (!EXACT_VERSION.test(p.version)) problems.push(`${id}: locked to "${p.version}", not an exact version`);
        break;
      case 'tarball': {
        const ws = lock.workspaces.find((w) => Object.values({ ...w.dependencies, ...w.devDependencies }).some((s) => s === `file:${(p.source as { path: string }).path}`));
        const file = join(root, ws?.path ?? '', p.source.path);
        const relative = relativePath(root, file);
        if (!relative.startsWith(ALLOWED_TARBALL_DIR) || relative.split(/[\\/]/).includes('..')) {
          problems.push(`${p.name}: tarball ${p.source.path} is outside ${ALLOWED_TARBALL_DIR}`);
        } else if (!existsSync(file)) {
          problems.push(`${p.name}: tarball ${relative} is missing`);
        } else if (p.integrity && sha512Integrity(readFileSync(file)) !== p.integrity) {
          problems.push(`${p.name}: ${relative} does not match the integrity hash in bun.lock (the tarball changed: run bun install and review)`);
        }
        break;
      }
    }
    if (!p.integrity) problems.push(`${id}: no integrity hash in bun.lock`);
    else if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(p.integrity)) problems.push(`${id}: integrity is not a sha512 hash`);
  }

  // Every package.json agrees with the lockfile, and names exact versions (bunfig.toml: exact = true).
  for (const ws of lock.workspaces) {
    const file = join(root, ws.path, 'package.json');
    if (!existsSync(file)) {
      problems.push(`bun.lock lists the workspace "${ws.path}", which has no package.json`);
      continue;
    }
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as Json;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      const declared = strings(pkg[field]);
      const locked = ws[field];
      const names = new Set([...Object.keys(declared), ...Object.keys(locked)]);
      for (const name of names) {
        if (declared[name] !== locked[name]) {
          problems.push(`${ws.path || '.'}/package.json ${field}.${name}: "${declared[name] ?? '(none)'}" but bun.lock has "${locked[name] ?? '(none)'}" (run bun install)`);
        }
        const spec = declared[name];
        if (spec && field !== 'peerDependencies' && !spec.startsWith('workspace:') && !spec.startsWith('file:') && !EXACT_VERSION.test(spec)) {
          problems.push(`${ws.path || '.'}/package.json ${field}.${name}: "${spec}" is a range; pin an exact version`);
        }
      }
    }
    if (ws.path === '') {
      const trusted = Array.isArray(pkg.trustedDependencies) ? (pkg.trustedDependencies as unknown[]).map(String) : [];
      for (const t of new Set([...trusted, ...lock.trustedDependencies])) {
        if (!ALLOWED_LIFECYCLE_SCRIPTS.includes(t)) problems.push(`trustedDependencies: ${t} may run install scripts; review it and add it to ALLOWED_LIFECYCLE_SCRIPTS first`);
      }
    }
  }

  // No configuration that sends installs to another registry.
  const npmrc = join(root, '.npmrc');
  if (existsSync(npmrc) && /registry\s*=/.test(readFileSync(npmrc, 'utf8'))) problems.push('.npmrc sets a registry; packages must come from the npm registry');
  const bunfig = join(root, 'bunfig.toml');
  if (existsSync(bunfig) && /^\s*registry\s*=/m.test(readFileSync(bunfig, 'utf8'))) problems.push('bunfig.toml sets a registry; packages must come from the npm registry');
  return problems;
}

/** The Bun version pinned in CI, the release workflow and the Dockerfile; all must agree. */
export function checkBunPins(root: string): string[] {
  const pins: [string, string][] = [];
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/release.yml', '.github/workflows/dependencies.yml']) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const m of readFileSync(path, 'utf8').matchAll(/bun-version:\s*['"]?([0-9.]+)/g)) pins.push([file, m[1]!]);
  }
  const docker = join(root, 'Dockerfile');
  if (existsSync(docker)) for (const m of readFileSync(docker, 'utf8').matchAll(/FROM\s+oven\/bun:([0-9.]+)/g)) pins.push(['Dockerfile', m[1]!]);
  const types = readLockfile(root).packages.find((p) => p.name === '@types/bun');
  if (types) pins.push(['@types/bun', types.version]);
  const versions = new Set(pins.map(([, v]) => v));
  return versions.size > 1 ? [`Bun versions disagree: ${pins.map(([f, v]) => `${f} ${v}`).join(', ')}`] : [];
}
