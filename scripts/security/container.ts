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
 * Container checks (SEC-026). Two parts:
 *
 * - the image definition: Dockerfile and deploy/compose.yaml keep the SEC-004 hardening
 *   (checked everywhere, no Docker needed);
 * - the built image: a Trivy JSON report (CI builds the image and scans it) evaluated against
 *   supply-chain.json "container". Every vulnerability is reported; those at a `failOn`
 *   severity fail, only when a fixed version exists if `fixedOnly` (an unfixed one cannot be
 *   acted on), unless an exception with a reason and an expiry date names it.
 */
import type { CheckResult } from '../supply-chain/checks.ts';

export interface ContainerException {
  /** CVE or GHSA id. */
  vulnerability: string;
  /** The package it is in (as Trivy names it). */
  package: string;
  reason: string;
  /** YYYY-MM-DD: after this day the exception no longer applies. */
  expires: string;
}

export interface ContainerPolicy {
  failOn: string[];
  fixedOnly: boolean;
  exceptions: ContainerException[];
}

const SEVERITY_ORDER = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** Instructions of a Dockerfile, with continuation lines joined and comments removed. */
export function dockerInstructions(text: string): { op: string; args: string }[] {
  const out: { op: string; args: string }[] = [];
  let current = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!current && (line.startsWith('#') || !line)) continue;
    if (line.startsWith('#')) continue;
    current += `${current ? ' ' : ''}${line.replace(/\\$/, '').trim()}`;
    if (line.endsWith('\\')) continue;
    const m = /^(\w+)\s+([\s\S]*)$/.exec(current);
    if (m) out.push({ op: m[1]!.toUpperCase(), args: m[2]! });
    current = '';
  }
  return out;
}

const SECRET_NAME = /(PASSWORD|SECRET|TOKEN|API_?KEY|PRIVATE)/i;

/** The Dockerfile's security properties (SEC-004). */
export function checkDockerfile(text: string): CheckResult {
  const problems: string[] = [];
  const notes: string[] = [];
  const ins = dockerInstructions(text);
  const stages = ins.filter((i) => i.op === 'FROM');
  if (!stages.length) problems.push('Dockerfile: no FROM.');
  for (const s of stages) {
    const image = s.args.split(/\s+/)[0]!;
    const tag = image.includes('@') ? 'digest' : image.split(':')[1];
    if (!tag || tag === 'latest') problems.push(`Dockerfile: base image "${image}" has no exact version.`);
    else if (tag !== 'digest' && !/\d+\.\d+\.\d+/.test(tag)) problems.push(`Dockerfile: base image "${image}" is not pinned to an exact version.`);
  }
  const final = ins.slice(ins.lastIndexOf(stages.at(-1)!));
  const users = final.filter((i) => i.op === 'USER').map((i) => i.args.trim());
  if (!users.length) problems.push('Dockerfile: the final image runs as root (no USER).');
  else if (/^(root|0)(:|$)/.test(users.at(-1)!)) problems.push(`Dockerfile: the final image runs as ${users.at(-1)}.`);
  for (const i of ins) {
    if (i.op === 'ADD' && /https?:\/\//.test(i.args)) problems.push(`Dockerfile: ADD downloads from a URL (${i.args.slice(0, 80)}): no integrity check.`);
    if ((i.op === 'ENV' || i.op === 'ARG') && i.args.split(/\s+/).some((kv) => SECRET_NAME.test(kv.split('=')[0]!) && kv.includes('='))) problems.push(`Dockerfile: ${i.op} sets a secret-looking value (${i.args.slice(0, 60)}); pass secrets at run time.`);
    if (i.op === 'RUN' && /curl[^|]*\|\s*(ba)?sh|wget[^|]*\|\s*(ba)?sh/.test(i.args)) problems.push('Dockerfile: RUN pipes a download into a shell.');
    if (i.op === 'RUN' && /chmod\s+(-R\s+)?(0?777|a\+w)/.test(i.args)) problems.push('Dockerfile: RUN makes files writable by everyone.');
  }
  if (!final.some((i) => i.op === 'HEALTHCHECK')) notes.push('Dockerfile: no HEALTHCHECK.');
  return { problems, notes };
}

type ComposeService = {
  user?: string; read_only?: boolean; privileged?: boolean; cap_drop?: string[]; cap_add?: string[];
  security_opt?: string[]; network_mode?: string; pid?: string; ipc?: string; volumes?: (string | { source?: string })[];
  pids_limit?: number; mem_limit?: string | number; ports?: (string | number)[];
};

/** deploy/compose.yaml keeps the SEC-004 hardening for every service. */
export function checkCompose(doc: unknown): CheckResult {
  const problems: string[] = [];
  const services = (doc as { services?: Record<string, ComposeService> })?.services ?? {};
  if (!Object.keys(services).length) problems.push('compose: no services.');
  for (const [name, s] of Object.entries(services)) {
    const at = `compose: ${name}`;
    if (!s.user || /^(root|0)(:|$)/.test(String(s.user))) problems.push(`${at} does not set an unprivileged user.`);
    if (s.read_only !== true) problems.push(`${at} has a writable root filesystem (read_only: true).`);
    if (s.privileged) problems.push(`${at} is privileged.`);
    if (!(s.cap_drop ?? []).map((c) => c.toUpperCase()).includes('ALL')) problems.push(`${at} does not drop every capability (cap_drop: [ALL]).`);
    if ((s.cap_add ?? []).length) problems.push(`${at} adds capabilities (${s.cap_add!.join(', ')}).`);
    if (!(s.security_opt ?? []).some((o) => /^no-new-privileges(:true)?$/.test(o))) problems.push(`${at} allows new privileges (security_opt: no-new-privileges:true).`);
    if ((s.security_opt ?? []).some((o) => /unconfined/.test(o))) problems.push(`${at} turns off seccomp or AppArmor.`);
    for (const ns of ['network_mode', 'pid', 'ipc'] as const) if (s[ns] === 'host') problems.push(`${at} shares the host's ${ns === 'network_mode' ? 'network' : ns} namespace.`);
    for (const v of s.volumes ?? []) {
      const src = typeof v === 'string' ? v.split(':')[0]! : v.source ?? '';
      if (/docker\.sock$/.test(src)) problems.push(`${at} mounts the Docker socket.`);
      if (src === '/') problems.push(`${at} mounts the host's root filesystem.`);
    }
    if (s.pids_limit === undefined) problems.push(`${at} has no pids_limit.`);
    if (s.mem_limit === undefined) problems.push(`${at} has no mem_limit.`);
    for (const p of s.ports ?? []) if (!/^\d{1,3}(\.\d{1,3}){3}:|^\[[0-9a-f:]+\]:/i.test(String(p))) problems.push(`${at} publishes port ${p} on every interface (bind it to 127.0.0.1 behind a proxy).`);
  }
  return { problems, notes: [] };
}

interface TrivyVulnerability { VulnerabilityID?: string; PkgName?: string; InstalledVersion?: string; FixedVersion?: string; Severity?: string; Title?: string }
interface TrivyReport { ArtifactName?: string; Results?: { Target?: string; Vulnerabilities?: TrivyVulnerability[] | null }[] }

export interface ContainerScan extends CheckResult {
  counts: Record<string, number>;
}

/** Evaluates a Trivy JSON report ("trivy image --format json"). */
export function evaluateTrivy(report: unknown, policy: ContainerPolicy, today = new Date().toISOString().slice(0, 10)): ContainerScan {
  const problems: string[] = [];
  const notes: string[] = [];
  const counts: Record<string, number> = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
  const r = report as TrivyReport;
  if (!r || typeof r !== 'object' || !Array.isArray(r.Results)) return { problems: ['container scan: not a Trivy JSON report.'], notes, counts };
  const used = new Set<ContainerException>();
  const failOn = policy.failOn.map((s) => s.toUpperCase());
  const seen = new Set<string>();
  for (const result of r.Results) {
    for (const v of result.Vulnerabilities ?? []) {
      const severity = SEVERITY_ORDER.includes(String(v.Severity).toUpperCase()) ? String(v.Severity).toUpperCase() : 'UNKNOWN';
      const key = `${v.VulnerabilityID}|${v.PkgName}|${v.InstalledVersion}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counts[severity]! += 1;
      const line = `${severity} ${v.VulnerabilityID} in ${v.PkgName} ${v.InstalledVersion}${v.FixedVersion ? ` (fixed in ${v.FixedVersion})` : ' (no fix yet)'}${v.Title ? `: ${v.Title}` : ''} [${result.Target ?? '?'}]`;
      const failing = failOn.includes(severity) && (!policy.fixedOnly || !!v.FixedVersion);
      if (!failing) {
        notes.push(line);
        continue;
      }
      const exception = policy.exceptions.find((x) => x.vulnerability.toUpperCase() === String(v.VulnerabilityID).toUpperCase() && x.package === v.PkgName);
      if (!exception) problems.push(line);
      else {
        used.add(exception);
        if (exception.expires < today) problems.push(`${line}; its exception expired on ${exception.expires}`);
        else notes.push(`accepted until ${exception.expires}: ${line} (${exception.reason})`);
      }
    }
  }
  for (const x of policy.exceptions) if (!used.has(x)) notes.push(`container exception ${x.vulnerability} (${x.package}) matches no finding any more: remove it from supply-chain.json.`);
  notes.unshift(`${r.ArtifactName ?? 'image'}: ${SEVERITY_ORDER.slice().reverse().map((s) => `${counts[s]} ${s.toLowerCase()}`).join(', ')}.`);
  return { problems, notes, counts };
}
