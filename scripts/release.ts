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
 * Builds a release (SEC-019, SEC-020): a clean production build packed into a reproducible
 * archive, the SBOMs, SHA256SUMS, and an Ed25519 signature of SHA256SUMS.
 *
 *   bun run release                     unsigned, into release/ (for a look)
 *   bun run release --sign              signed with CLAWROUTER_RELEASE_SIGNING_KEY (PEM) or
 *                                       CLAWROUTER_RELEASE_SIGNING_KEY_FILE; the key must match
 *                                       docs/security/release-signing-key.pub
 *   bun run release --ephemeral-key     signed with a throwaway key (CI dry run); its public key
 *                                       is written to release-ephemeral.pub beside the folder
 *   --out <dir>                         another output folder
 *   --skip-build                        package the existing dist/
 *
 * The release workflow (.github/workflows/release.yml) runs this on a version tag, verifies
 * the result with `bun run release:verify` and publishes it. docs/security/release-verification.md
 * explains how users check a download.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkLockfile, readLockfile } from './supply-chain/lockfile.ts';
import {
  artifactNames, checksumFile, collectFiles, createArchive, generateSigningKey, loadPrivateKey, loadPublicKey,
  publicKeyPem, signBytes, CHECKSUMS, SIGNATURE, type ArchiveEntry,
} from './supply-chain/release.ts';
import { components, cycloneDx, sbomInput, spdx } from './supply-chain/sbom.ts';

const root = resolve(import.meta.dir, '..');
const PUBLIC_KEY_PATH = join(root, 'docs/security/release-signing-key.pub');
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const git = (...a: string[]) => {
  const p = Bun.spawnSync(['git', ...a], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  return p.exitCode === 0 ? p.stdout.toString().trim() : '';
};

const out = resolve(root, option('--out') ?? 'release');
const sign = flag('--sign');
const ephemeral = flag('--ephemeral-key');
if (sign && ephemeral) fail('Use --sign or --ephemeral-key, not both.');

const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
const commit = process.env.GITHUB_SHA || git('rev-parse', 'HEAD') || fail('Not a git checkout: the release records its commit.');
const timestamp = Number(process.env.SOURCE_DATE_EPOCH || git('log', '-1', '--format=%ct', commit) || fail('Cannot read the commit time.'));

// A signed release is built from a committed tree with a sound lockfile only.
if (sign) {
  const dirty = git('status', '--porcelain', '--untracked-files=no');
  if (dirty) fail(`Refusing to sign a release built from uncommitted changes:\n${dirty}`);
}
const lock = readLockfile(root);
const lockProblems = checkLockfile(root, lock);
if (lockProblems.length) fail(`The lockfile check failed (bun run deps:check):\n  ${lockProblems.join('\n  ')}`);

let signingKey = null as ReturnType<typeof loadPrivateKey> | null;
if (sign) {
  const pem = process.env.CLAWROUTER_RELEASE_SIGNING_KEY
    || (process.env.CLAWROUTER_RELEASE_SIGNING_KEY_FILE ? readFileSync(process.env.CLAWROUTER_RELEASE_SIGNING_KEY_FILE, 'utf8') : '');
  if (!pem) fail('--sign needs CLAWROUTER_RELEASE_SIGNING_KEY or CLAWROUTER_RELEASE_SIGNING_KEY_FILE (create one with bun run release:keygen).');
  signingKey = loadPrivateKey(pem);
  if (!existsSync(PUBLIC_KEY_PATH)) fail(`${PUBLIC_KEY_PATH} is missing: commit the public key before signing releases.`);
  const published = publicKeyPem(loadPublicKey(readFileSync(PUBLIC_KEY_PATH, 'utf8')));
  if (publicKeyPem(signingKey) !== published) fail('The signing key does not match docs/security/release-signing-key.pub: users could not verify this release.');
} else if (ephemeral) {
  const pair = generateSigningKey();
  signingKey = loadPrivateKey(pair.privateKey);
  writeFileSync(`${out}-ephemeral.pub`, pair.publicKey);
}

// Build from scratch, so nothing from an earlier build is packaged.
if (!flag('--skip-build')) {
  rmSync(join(root, 'dist'), { recursive: true, force: true });
  const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (build.exitCode !== 0) fail('The build failed.');
}
if (!existsSync(join(root, 'dist', 'main.js'))) fail('dist/main.js not found: run bun run build first.');

// Only ever clear a folder holding a previous release.
if (existsSync(out)) {
  const foreign = readdirSync(out).filter((f) => !/^(clawrouter-.*|SHA256SUMS(\.sig)?)$/.test(f));
  if (foreign.length) fail(`${out} holds other files (${foreign.join(', ')}); choose another --out.`);
  rmSync(out, { recursive: true });
}
mkdirSync(out, { recursive: true });

const names = artifactNames(version);
const prefix = `clawrouter-${version}`;
const buildInfo = {
  name: 'clawrouter',
  version,
  commit,
  committedAt: new Date(timestamp * 1000).toISOString(),
  bun: Bun.version,
  repository: 'https://github.com/iant89/ClawRouter',
};
const text = (path: string, s: string): ArchiveEntry => ({ path, data: new TextEncoder().encode(s), executable: false });
const entries: ArchiveEntry[] = [
  ...collectFiles(join(root, 'dist'), `${prefix}/dist`),
  ...collectFiles(join(root, 'deploy'), `${prefix}/deploy`),
  { path: `${prefix}/LICENSE`, data: readFileSync(join(root, 'LICENSE')), executable: false },
  { path: `${prefix}/README.md`, data: readFileSync(join(root, 'README.md')), executable: false },
  text(`${prefix}/BUILD-INFO.json`, `${JSON.stringify(buildInfo, null, 2)}\n`),
];
writeFileSync(join(out, names.archive), createArchive(entries, timestamp));

const input = sbomInput(root, lock, commit, timestamp);
const comps = components(input);
writeFileSync(join(out, names.spdx), `${JSON.stringify(spdx(input, comps), null, 2)}\n`);
writeFileSync(join(out, names.cyclonedx), `${JSON.stringify(cycloneDx(input, comps), null, 2)}\n`);

const sums = checksumFile(out, [names.archive, names.spdx, names.cyclonedx]);
writeFileSync(join(out, CHECKSUMS), sums);
if (signingKey) writeFileSync(join(out, SIGNATURE), signBytes(new TextEncoder().encode(sums), signingKey));

console.log(`ClawRouter ${version} (${commit.slice(0, 12)}) in ${out}:`);
for (const f of readdirSync(out).sort()) console.log(`  ${f}`);
console.log(sums.trimEnd().split('\n').map((l) => `  ${l}`).join('\n'));
if (!signingKey) console.log('Not signed (use --sign for a release).');
else if (ephemeral) console.log(`Signed with a throwaway key; its public key is ${out}-ephemeral.pub. Verify with: bun run release:verify ${out} --public-key ${out}-ephemeral.pub`);
