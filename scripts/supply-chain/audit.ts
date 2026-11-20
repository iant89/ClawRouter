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
 * Vulnerability auditing (SEC-018): `bun audit --json` asks the npm advisory database about
 * every installed package. High and critical advisories fail; lower ones are warnings.
 * `bun audit --json` itself exits 0 whatever it finds, so the decision is made here.
 */
import { AUDIT_EXCEPTIONS, FAILING_SEVERITIES, type AuditException } from './policy.ts';

export interface Advisory {
  package: string;
  /** GHSA id from the advisory URL, or bun's numeric id. */
  id: string;
  title: string;
  severity: string;
  url: string;
  vulnerableVersions: string;
}

/** Reads `bun audit --json` output: `{ "<package>": [advisory, ...] }`. Anything else is an error (fail closed). */
export function parseAudit(text: string): Advisory[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`bun audit did not answer with JSON: ${text.slice(0, 200)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bun audit answered in an unknown shape');
  const out: Advisory[] = [];
  for (const [pkg, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) throw new Error(`bun audit answered in an unknown shape (for ${pkg})`);
    for (const a of list as Record<string, unknown>[]) {
      const url = String(a.url ?? '');
      out.push({
        package: pkg,
        id: /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(url)?.[0] ?? String(a.id ?? '?'),
        title: String(a.title ?? ''),
        // An advisory without a known severity counts as critical.
        severity: ['low', 'moderate', 'high', 'critical'].includes(String(a.severity)) ? String(a.severity) : 'critical',
        url,
        vulnerableVersions: String(a.vulnerable_versions ?? ''),
      });
    }
  }
  return out;
}

export interface AuditResult {
  failures: string[];
  warnings: string[];
}

export function judgeAudit(
  advisories: Advisory[],
  now: Date,
  exceptions: readonly AuditException[] = AUDIT_EXCEPTIONS,
  failing: readonly string[] = FAILING_SEVERITIES,
): AuditResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const today = now.toISOString().slice(0, 10);
  for (const a of advisories) {
    const line = `${a.package}: ${a.severity} ${a.id} ${a.title} (${a.vulnerableVersions}) ${a.url}`;
    const exception = exceptions.find((e) => e.id === a.id && e.package === a.package);
    if (!failing.includes(a.severity)) warnings.push(line);
    else if (exception && exception.expires >= today) warnings.push(`${line} [accepted until ${exception.expires}: ${exception.reason}]`);
    else if (exception) failures.push(`${line} [the exception expired on ${exception.expires}]`);
    else failures.push(line);
  }
  for (const e of exceptions) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) failures.push(`AUDIT_EXCEPTIONS ${e.id}: expires must be YYYY-MM-DD`);
    if (!advisories.some((a) => a.id === e.id && a.package === e.package)) warnings.push(`AUDIT_EXCEPTIONS ${e.id} (${e.package}) no longer matches an advisory: remove it`);
  }
  return { failures, warnings };
}

export function runAudit(root: string): Advisory[] {
  const p = Bun.spawnSync(['bun', 'audit', '--json'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const out = p.stdout.toString().trim();
  if (!out) throw new Error(`bun audit failed (exit ${p.exitCode}): ${p.stderr.toString().trim().slice(0, 300)}`);
  return parseAudit(out);
}
