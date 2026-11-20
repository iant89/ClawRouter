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
 * The dependency checks (SEC-018): the lockfile, licenses and known vulnerabilities.
 * Each returns problems (fail the check) and notes (printed, never fail it).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { AuditException, Lockfile, Severity, SupplyChainPolicy, ThirdPartyPackage } from './packages.ts';

export interface CheckResult {
  problems: string[];
  notes: string[];
}

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SRI = /^sha512-[A-Za-z0-9+/]{86}==$/;

const sha512 = (file: string) => `sha512-${new Bun.CryptoHasher('sha512').update(readFileSync(file)).digest('base64')}`;

/**
 * Lockfile verification: every package comes from an allowed registry with a sha512
 * integrity hash, or is a committed tarball whose hash matches; no git, URL or link
 * sources; direct dependencies are exact versions; no install scripts beyond the
 * policy's `trustedDependencies`. (`bun install --frozen-lockfile` checks that the
 * lockfile matches package.json, and Bun checks every download against its hash.)
 */
export function checkLockfile(root: string, lock: Lockfile, policy: SupplyChainPolicy): CheckResult {
  const problems: string[] = [];
  const notes: string[] = [];
  if (lock.lockfileVersion < 1) problems.push(`bun.lock: unknown lockfile version ${lock.lockfileVersion}.`);
  const workspacePaths = new Set(lock.workspaces.map((w) => w.path));

  for (const e of lock.entries.values()) {
    const where = `bun.lock: ${e.key}`;
    switch (e.kind) {
      case 'workspace': {
        const path = e.resolution.slice('workspace:'.length);
        if (!workspacePaths.has(path)) problems.push(`${where} points to "${path}", which is not a workspace.`);
        break;
      }
      case 'registry':
        if (!policy.lockfile.registries.includes(e.registry ?? '')) problems.push(`${where} comes from the registry "${e.registry}", which the policy does not allow.`);
        if (!e.integrity || !SRI.test(e.integrity)) problems.push(`${where} has no sha512 integrity hash.`);
        break;
      case 'tarball': {
        const file = policy.lockfile.tarballs[e.resolution];
        if (!file) problems.push(`${where} is the tarball "${e.resolution}", which the policy does not list.`);
        else if (!existsSync(join(root, file))) problems.push(`${where}: ${file} does not exist.`);
        else if (e.integrity !== sha512(join(root, file))) problems.push(`${where}: ${file} does not match the integrity hash in bun.lock (changed without "bun install"?).`);
        break;
      }
      default:
        problems.push(`${where} comes from "${e.resolution}": only registry packages, workspaces and committed tarballs are allowed (no git, URL or link sources).`);
    }
  }

  for (const w of lock.workspaces) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      for (const [name, spec] of Object.entries(w[field])) {
        const where = `${w.path || '.'}/package.json ${field} "${name}"`;
        if (spec.startsWith('workspace:')) continue;
        if (spec.startsWith('file:')) {
          const target = normalize(join(w.path, spec.slice(5)));
          if (!Object.values(policy.lockfile.tarballs).includes(target)) problems.push(`${where} is "${spec}", which is not a tarball the policy lists.`);
          continue;
        }
        if (!EXACT.test(spec)) problems.push(`${where} is "${spec}": direct dependencies must be exact versions (bunfig.toml has exact = true; "bun add" writes them).`);
      }
    }
  }

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { trustedDependencies?: string[] };
  for (const t of pkg.trustedDependencies ?? []) {
    if (!policy.lockfile.trustedDependencies.includes(t)) problems.push(`package.json trusts "${t}" to run install scripts, which the policy does not allow.`);
  }
  const counts = [...lock.entries.values()].reduce<Record<string, number>>((n, e) => ({ ...n, [e.kind]: (n[e.kind] ?? 0) + 1 }), {});
  notes.push(`bun.lock: ${counts.registry ?? 0} registry package(s), ${counts.tarball ?? 0} committed tarball(s), ${counts.workspace ?? 0} workspace(s).`);
  return { problems, notes };
}

/**
 * Old-style GNU identifiers in their current form: "GPL-2.0+" is GPL-2.0-or-later, a bare
 * "GPL-3.0" (deprecated) is GPL-3.0-only. Other identifiers are unchanged ("+" dropped).
 */
export function canonicalLicense(id: string): string {
  const gnu = /^(A?GPL|LGPL)-(\d\.\d)(-only|-or-later)?(\+)?$/.exec(id);
  if (!gnu) return id.replace(/\+$/, '');
  return `${gnu[1]}-${gnu[2]}${gnu[4] ? '-or-later' : gnu[3] ?? '-only'}`;
}

/** Whether an SPDX license expression is allowed: one allowed alternative of an OR, every part of an AND. */
export function licenseAllowed(expression: string, allowed: string[]): boolean {
  const tokens = expression.replace(/[()]/g, ' $& ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  let i = 0;
  // or := and ("OR" and)* ; and := atom ("AND" atom)* ; atom := "(" or ")" | id ["WITH" id]
  const or = (): boolean => {
    let v = and();
    while (tokens[i]?.toUpperCase() === 'OR') {
      i++;
      v = and() || v;
    }
    return v;
  };
  const and = (): boolean => {
    let v = atom();
    while (tokens[i]?.toUpperCase() === 'AND') {
      i++;
      v = atom() && v;
    }
    return v;
  };
  const atom = (): boolean => {
    const t = tokens[i++];
    if (t === undefined) throw new Error('unexpected end');
    if (t === '(') {
      const v = or();
      if (tokens[i++] !== ')') throw new Error('missing )');
      return v;
    }
    if (tokens[i]?.toUpperCase() === 'WITH') i += 2;
    return allowed.includes(canonicalLicense(t));
  };
  try {
    const v = or();
    return i === tokens.length && v;
  } catch {
    return false;
  }
}

/** License scanning: every third-party package has a license the policy allows. */
export function checkLicenses(packages: ThirdPartyPackage[], policy: SupplyChainPolicy): CheckResult {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const p of packages) {
    const id = `${p.name}@${p.version} (${p.scope})`;
    if (!p.version) problems.push(`${p.name}: not installed, so its license cannot be read (run "bun install").`);
    else if (!p.license) problems.push(`${id} has no license field or recognisable LICENSE file. Check it by hand and add it to supply-chain.json "licenses.packages".`);
    else if (!licenseAllowed(p.license, policy.licenses.allowed)) problems.push(`${id} is licensed "${p.license}", which supply-chain.json does not allow.`);
  }
  for (const name of Object.keys(policy.licenses.packages)) {
    if (!packages.some((p) => p.name === name)) notes.push(`supply-chain.json sets the license of "${name}", which is no longer a dependency: remove it.`);
  }
  const byLicense = packages.reduce<Record<string, number>>((n, p) => ({ ...n, [p.license ?? 'unknown']: (n[p.license ?? 'unknown'] ?? 0) + 1 }), {});
  notes.push(`licenses: ${Object.entries(byLicense).sort().map(([l, n]) => `${l} ${n}`).join(', ')}.`);
  return { problems, notes };
}

/** One advisory from `bun audit --json` ({ package: [advisory, ...] }, the npm bulk advisory format). */
export interface Advisory {
  id: number | string;
  url?: string;
  title?: string;
  severity?: string;
  vulnerable_versions?: string;
}

const SEVERITIES: Severity[] = ['info', 'low', 'moderate', 'high', 'critical'];
const ghsa = (a: Advisory) => /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i.exec(a.url ?? '')?.[0] ?? String(a.id);

/**
 * Applies the audit policy to a `bun audit --json` report: advisories at a `failOn`
 * severity fail unless an unexpired exception names them (an expired one fails too);
 * lower ones are notes. A report that is not the expected shape fails (fail closed:
 * an unreachable advisory database must not look like "no vulnerabilities").
 */
export function evaluateAudit(report: unknown, policy: SupplyChainPolicy, today = new Date().toISOString().slice(0, 10)): CheckResult {
  const problems: string[] = [];
  const notes: string[] = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { problems: ['bun audit did not return a report (is the registry reachable?).'], notes };
  const used = new Set<AuditException>();
  for (const [name, list] of Object.entries(report as Record<string, unknown>)) {
    if (!Array.isArray(list)) return { problems: [`bun audit: unexpected report for "${name}".`], notes };
    for (const a of list as Advisory[]) {
      const severity = (SEVERITIES.includes(a.severity as Severity) ? a.severity : 'critical') as Severity;
      const id = ghsa(a);
      const line = `${name}: ${severity} ${id} ${a.title ?? ''} (${a.vulnerable_versions ?? '?'})`.trim();
      if (!policy.audit.failOn.includes(severity)) {
        notes.push(`advisory below the failing level: ${line}`);
        continue;
      }
      const exception = policy.audit.exceptions.find((x: AuditException) => x.package === name && x.advisory.toUpperCase() === id.toUpperCase());
      if (!exception) problems.push(`advisory: ${line}`);
      else if (exception.expires < today) {
        used.add(exception);
        problems.push(`advisory: ${line}; its exception expired on ${exception.expires}`);
      } else {
        used.add(exception);
        notes.push(`advisory accepted until ${exception.expires}: ${line} (${exception.reason})`);
      }
    }
  }
  for (const x of policy.audit.exceptions) if (!used.has(x)) notes.push(`audit exception ${x.advisory} (${x.package}) matches no advisory any more: remove it from supply-chain.json.`);
  return { problems, notes };
}
