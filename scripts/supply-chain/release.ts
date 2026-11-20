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
 * Release artifacts (SEC-020): a deterministic tarball of the production build, its
 * SBOMs, and SHA256SUMS; and the verification of a release directory (checksums,
 * and the Sigstore signatures when asked). Signing itself happens in the release
 * workflow (.github/workflows/release.yml) with cosign's keyless signing, because the
 * signature is bound to that workflow's identity, which no one can take home.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CheckResult } from './checks.ts';

export const SUMS = 'SHA256SUMS';
export const BUNDLE_SUFFIX = '.sigstore.json';
export const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
/** The identity a release signature must carry: the release workflow, run for that tag. */
export const releaseIdentity = (version: string) => `https://github.com/iant89/ClawRouter/.github/workflows/release.yml@refs/tags/v${version}`;

export const artifactNames = (version: string) => ({
  tarball: `clawrouter-${version}.tar.gz`,
  spdx: `clawrouter-${version}.spdx.json`,
  cyclonedx: `clawrouter-${version}.cdx.json`,
});

/** What goes into the tarball, under clawrouter-<version>/. */
const CONTENTS = ['dist', 'deploy', 'LICENSE', 'README.md'];

const sha256 = (file: string) => new Bun.CryptoHasher('sha256').update(readFileSync(file)).digest('hex');

function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): string {
  const r = Bun.spawnSync(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`${cmd[0]} failed (${r.exitCode}): ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

/**
 * The time the release is from: SOURCE_DATE_EPOCH, else the commit time, else now.
 * Used for the tarball's file times and the SBOM's creation time.
 */
export function sourceDateEpoch(root: string, env = process.env): number {
  if (env.SOURCE_DATE_EPOCH && /^\d+$/.test(env.SOURCE_DATE_EPOCH)) return Number(env.SOURCE_DATE_EPOCH);
  try {
    return Number(run(['git', 'log', '-1', '--format=%ct'], { cwd: root }).trim());
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

export function currentCommit(root: string): string | undefined {
  try {
    return run(['git', 'rev-parse', 'HEAD'], { cwd: root }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Writes clawrouter-<version>.tar.gz from the built dist/ (run `bun run build` first),
 * with sorted entries, fixed times, owners and modes and no gzip timestamp, so the
 * same build gives the same bytes. Needs GNU tar and gzip (Linux; the release runs on Ubuntu).
 */
export function writeTarball(root: string, out: string, version: string, epoch: number): string {
  if (!existsSync(join(root, 'dist', 'main.js'))) throw new Error('dist/main.js is missing: run "bun run build" first.');
  const name = `clawrouter-${version}`;
  const stage = join(out, '.stage');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, name), { recursive: true });
  for (const c of CONTENTS) cpSync(join(root, c), join(stage, name, c), { recursive: true });
  const file = join(out, artifactNames(version).tarball);
  const tar = join(stage, `${name}.tar`);
  run(['tar', '--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner', '--mode=u=rwX,go=rX',
    '--format=posix', '--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime', '-C', stage, '-cf', tar, name]);
  // -n: no file name or time in the gzip header.
  const gz = Bun.spawnSync(['gzip', '-n', '-9', '-c', tar], { stdout: 'pipe', stderr: 'pipe' });
  if (gz.exitCode !== 0) throw new Error(`gzip failed: ${gz.stderr.toString()}`);
  writeFileSync(file, gz.stdout);
  rmSync(stage, { recursive: true, force: true });
  return file;
}

/** SHA256SUMS for every artifact in `dir` (the format `sha256sum -c` reads). Signature bundles are left out. */
export function writeChecksums(dir: string): string {
  const files = readdirSync(dir).filter((f) => f !== SUMS && !f.endsWith(BUNDLE_SUFFIX) && !f.startsWith('.') && statSync(join(dir, f)).isFile()).sort();
  const text = files.map((f) => `${sha256(join(dir, f))}  ${f}\n`).join('');
  writeFileSync(join(dir, SUMS), text);
  return join(dir, SUMS);
}

export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *]([A-Za-z0-9._+-]+)$/.exec(line);
    if (!m) throw new Error(`${SUMS} line ${i + 1} is not "<sha256>  <file>".`);
    if (out.has(m[2]!)) throw new Error(`${SUMS} lists ${m[2]} twice.`);
    out.set(m[2]!, m[1]!);
  }
  return out;
}

export interface VerifyOptions {
  /** The release version; every artifact for it must be present. */
  version?: string;
  /** Require a Sigstore bundle for every artifact and SHA256SUMS, and check each with cosign. */
  signed?: boolean;
  /** The certificate identity signatures must carry (default: the release workflow for `version`). */
  identity?: string;
  /** cosign's path (default: cosign on PATH). */
  cosign?: string;
}

/**
 * Verifies a release directory: SHA256SUMS lists exactly the artifacts there and each
 * matches; the expected artifacts for the version exist; the SBOMs name that version;
 * and, with `signed`, every artifact and SHA256SUMS has a valid keyless signature from
 * the release workflow (cosign verify-blob against the Sigstore transparency log).
 */
export function verifyRelease(dir: string, o: VerifyOptions = {}): CheckResult {
  const problems: string[] = [];
  const notes: string[] = [];
  if (!existsSync(join(dir, SUMS))) return { problems: [`${SUMS} is missing in ${dir}.`], notes };
  let sums: Map<string, string>;
  try {
    sums = parseChecksums(readFileSync(join(dir, SUMS), 'utf8'));
  } catch (error) {
    return { problems: [(error as Error).message], notes };
  }
  const present = readdirSync(dir).filter((f) => f !== SUMS && !f.endsWith(BUNDLE_SUFFIX) && !f.startsWith('.') && statSync(join(dir, f)).isFile());
  for (const f of present) if (!sums.has(f)) problems.push(`${f} is not listed in ${SUMS}.`);
  for (const [f, want] of sums) {
    if (!existsSync(join(dir, f))) problems.push(`${f} is listed in ${SUMS} but missing.`);
    else if (sha256(join(dir, f)) !== want) problems.push(`${f} does not match its SHA-256 in ${SUMS}.`);
  }
  if (o.version) {
    const names = artifactNames(o.version);
    for (const f of Object.values(names)) if (!sums.has(f)) problems.push(`${f} is missing from the release.`);
    for (const f of [names.spdx, names.cyclonedx]) {
      if (!existsSync(join(dir, f))) continue;
      try {
        const doc = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { packages?: { SPDXID: string; versionInfo: string }[]; metadata?: { component?: { version?: string } } };
        const v = doc.metadata?.component?.version ?? doc.packages?.find((p) => p.SPDXID === 'SPDXRef-ClawRouter')?.versionInfo;
        if (v !== o.version) problems.push(`${f} describes version ${v ?? '(none)'}, not ${o.version}.`);
      } catch {
        problems.push(`${f} is not JSON.`);
      }
    }
  }
  if (o.signed) {
    const identity = o.identity ?? (o.version ? releaseIdentity(o.version) : null);
    if (!identity) problems.push('Checking signatures needs the version or the identity.');
    else {
      for (const f of [...sums.keys(), SUMS]) {
        const bundle = join(dir, f + BUNDLE_SUFFIX);
        if (!existsSync(bundle)) {
          problems.push(`${f} has no signature (${basename(bundle)}).`);
          continue;
        }
        const r = Bun.spawnSync([o.cosign ?? 'cosign', 'verify-blob', '--bundle', bundle, '--certificate-identity', identity, '--certificate-oidc-issuer', OIDC_ISSUER, join(dir, f)], { stdout: 'pipe', stderr: 'pipe' });
        if (r.exitCode !== 0) problems.push(`${f}: the signature does not verify for ${identity}: ${r.stderr.toString().trim().split('\n').pop()}`);
      }
      if (!problems.length) notes.push(`${sums.size + 1} signature(s) verified for ${identity}.`);
    }
  }
  if (!problems.length) notes.push(`${sums.size} artifact(s) match ${SUMS}.`);
  return { problems, notes };
}
