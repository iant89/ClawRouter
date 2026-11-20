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
 * Release artifacts (SEC-020). The release workflow runs these; so can anyone, to
 * rebuild a release or check one they downloaded.
 *
 *   bun run release:package [--out release] [--skip-build]
 *       build, then clawrouter-<version>.tar.gz, both SBOMs and SHA256SUMS in release/
 *   bun run release:verify <dir> [--version <v>] [--signed] [--identity <url>]
 *       check SHA256SUMS, the artifacts and SBOM versions; with --signed also every
 *       Sigstore signature (needs cosign; the identity defaults to the release workflow)
 *
 * See docs/releases.md for verifying a downloaded release by hand.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { artifactNames, sourceDateEpoch, verifyRelease, writeChecksums, writeTarball } from './supply-chain/release.ts';
import { writeSboms } from './sbom.ts';

const root = join(import.meta.dir, '..');
const args = process.argv.slice(2);
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;

switch (args[0]) {
  case 'package': {
    // The release is built with the runtime it ships for (the Docker image's Bun).
    const pinned = /oven\/bun:(\d+\.\d+\.\d+)/.exec(readFileSync(join(root, 'Dockerfile'), 'utf8'))?.[1];
    if (pinned !== Bun.version && !args.includes('--any-runtime')) {
      console.error(`This is Bun ${Bun.version}; releases are built with Bun ${pinned} (the Dockerfile's). Use that version, or --any-runtime for a local try.`);
      process.exit(1);
    }
    const out = resolve(value('--out') ?? join(root, 'release'));
    rmSync(out, { recursive: true, force: true });
    if (!args.includes('--skip-build')) {
      rmSync(join(root, 'dist'), { recursive: true, force: true });
      const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
      if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
    }
    const tarball = writeTarball(root, out, version, sourceDateEpoch(root));
    const sboms = writeSboms(out);
    const sums = writeChecksums(out);
    for (const f of [tarball, ...sboms, sums]) console.log(`Wrote ${f}`);
    console.log(readFileSync(sums, 'utf8').trimEnd());
    break;
  }
  case 'verify': {
    const dir = args[1];
    if (!dir) {
      console.error('Usage: bun run release:verify <dir> [--version <v>] [--signed] [--identity <url>]');
      process.exit(2);
    }
    const v = value('--version') ?? version;
    const identity = value('--identity');
    const { problems, notes } = verifyRelease(resolve(dir), { version: v, signed: args.includes('--signed'), ...(identity ? { identity } : {}) });
    for (const n of notes) console.log(`✔ ${n}`);
    for (const p of problems) console.log(`✖ ${p}`);
    if (!problems.length) console.log(`Release ${v} (${artifactNames(v).tarball}) verified.`);
    process.exit(problems.length ? 1 : 0);
  }
  default:
    console.error('Usage: bun run release:package | bun run release:verify <dir>');
    process.exit(2);
}
