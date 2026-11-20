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
 * License scanning (SEC-018): every installed dependency's license, read from its
 * package.json, is an SPDX expression the policy allows.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Lockfile, LockedPackage } from './lockfile.ts';
import { ALLOWED_LICENSES, LICENSE_OVERRIDES } from './policy.ts';

type Expr = { id: string } | { op: 'AND' | 'OR'; left: Expr; right: Expr };

/** Parses an SPDX license expression ("MIT", "(MIT OR Apache-2.0)", "Apache-2.0 WITH LLVM-exception"). */
export function parseLicenseExpression(text: string): Expr {
  const tokens = text.replace(/[()]/g, ' $& ').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  const atom = (): Expr => {
    const t = tokens[i++];
    if (t === undefined) throw new Error(`incomplete license expression "${text}"`);
    if (t === '(') {
      const e = or();
      if (tokens[i++] !== ')') throw new Error(`unbalanced license expression "${text}"`);
      return e;
    }
    if (t === ')' || /^(AND|OR|WITH)$/i.test(t)) throw new Error(`unexpected "${t}" in license expression "${text}"`);
    if (/^WITH$/i.test(tokens[i] ?? '')) {
      i++;
      const exception = tokens[i++];
      if (!exception) throw new Error(`incomplete license expression "${text}"`);
      return { id: `${t} WITH ${exception}` };
    }
    return { id: t };
  };
  const and = (): Expr => {
    let left = atom();
    while (/^AND$/i.test(tokens[i] ?? '')) {
      i++;
      left = { op: 'AND', left, right: atom() };
    }
    return left;
  };
  const or = (): Expr => {
    let left = and();
    while (/^OR$/i.test(tokens[i] ?? '')) {
      i++;
      left = { op: 'OR', left, right: and() };
    }
    return left;
  };
  const expr = or();
  if (i !== tokens.length) throw new Error(`unexpected "${tokens[i]}" in license expression "${text}"`);
  return expr;
}

/** True when the expression can be satisfied with allowed licenses only (OR: either side, AND: both). */
export function licenseAllowed(expression: string, allowed: readonly string[] = ALLOWED_LICENSES): boolean {
  const ok = (e: Expr): boolean => ('id' in e ? allowed.includes(e.id) : e.op === 'OR' ? ok(e.left) || ok(e.right) : ok(e.left) && ok(e.right));
  try {
    return ok(parseLicenseExpression(expression));
  } catch {
    return false;
  }
}

/** The license a package.json declares, as one SPDX expression (legacy `licenses` arrays are ANDed). */
export function declaredLicense(pkg: Record<string, unknown>): string | null {
  const l = pkg.license;
  if (typeof l === 'string' && l.trim()) return l.trim();
  if (l && typeof l === 'object' && typeof (l as { type?: unknown }).type === 'string') return (l as { type: string }).type;
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((x) => (x && typeof x === 'object' ? (x as { type?: unknown }).type : x)).filter((t): t is string => typeof t === 'string');
    if (types.length) return types.length === 1 ? types[0]! : types.map((t) => `(${t})`).join(' AND ');
  }
  return null;
}

/** Where an installed package's package.json is, for Bun's isolated and hoisted layouts. */
export function findInstalled(root: string, name: string, version: string): string | null {
  const candidates: string[] = [];
  const store = join(root, 'node_modules', '.bun');
  if (existsSync(store)) {
    const prefix = `${name.replace('/', '+')}@`;
    for (const dir of readdirSync(store)) if (dir.startsWith(prefix)) candidates.push(join(store, dir, 'node_modules', name, 'package.json'));
  }
  candidates.push(join(root, 'node_modules', name, 'package.json'));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: string };
    if (!version || pkg.version === version) return file;
  }
  return null;
}

export interface LicenseInfo {
  pkg: LockedPackage;
  /** The installed version (for tarballs, which bun.lock does not version). */
  version: string;
  license: string | null;
  overridden: boolean;
}

export function readLicenses(root: string, lock: Lockfile): LicenseInfo[] {
  return lock.packages.filter((p) => p.source.kind !== 'workspace').map((pkg) => {
    const file = findInstalled(root, pkg.name, pkg.version);
    const json = file ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : null;
    const override = LICENSE_OVERRIDES[pkg.name];
    const declared = json ? declaredLicense(json) : null;
    return {
      pkg,
      version: pkg.version || String(json?.version ?? ''),
      license: declared ?? override?.license ?? null,
      overridden: !declared && !!override,
    };
  });
}

export function checkLicenses(root: string, lock: Lockfile): string[] {
  const problems: string[] = [];
  for (const info of readLicenses(root, lock)) {
    const id = `${info.pkg.name}@${info.version || '?'}`;
    if (!info.version) problems.push(`${id}: not installed (run bun install --frozen-lockfile first)`);
    else if (!info.license) problems.push(`${id}: no license stated; review it and add it to LICENSE_OVERRIDES`);
    else if (!licenseAllowed(info.license)) problems.push(`${id}: license "${info.license}" is not in ALLOWED_LICENSES; review it first`);
  }
  return problems;
}
