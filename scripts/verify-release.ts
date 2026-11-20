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
 * Verifies a downloaded or freshly built release (SEC-020): the Ed25519 signature of
 * SHA256SUMS, every file's SHA-256, no unlisted files, the archive's contents and the SBOMs.
 *
 *   bun run release:verify <dir>                        with docs/security/release-signing-key.pub
 *   bun run release:verify <dir> --public-key <file>    another public key (the CI dry run)
 *   bun run release:verify <dir> --version 1.2.0        and require that version (the tag)
 *   bun run release:verify <dir> --allow-unsigned       checksums only
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyRelease } from './supply-chain/release.ts';

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const values = new Set(['--public-key', '--version'].map(option));
const dir = args.find((a) => !a.startsWith('--') && !values.has(a));
if (!dir) {
  console.error('Usage: bun run release:verify <release folder> [--public-key <file>] [--version <x.y.z>] [--allow-unsigned]');
  process.exit(2);
}

const keyPath = option('--public-key') ?? join(import.meta.dir, '..', 'docs/security/release-signing-key.pub');
const allowUnsigned = args.includes('--allow-unsigned');
try {
  const publicKey = existsSync(keyPath) ? readFileSync(keyPath, 'utf8') : undefined;
  if (!publicKey && !allowUnsigned) throw new Error(`public key not found: ${keyPath}`);
  const expectVersion = option('--version')?.replace(/^v/, '');
  const result = verifyRelease(resolve(dir), { ...(publicKey ? { publicKey } : {}), allowUnsigned, ...(expectVersion ? { expectVersion } : {}) });
  console.log(`ClawRouter ${result.version}: ${result.signed ? 'signature valid, ' : 'NOT SIGNED, '}${result.files.length} files match ${'SHA256SUMS'}.`);
  for (const f of result.files) console.log(`  ✓ ${f}`);
} catch (e) {
  console.error(`Release verification FAILED:\n  ${(e as Error).message.split('\n').join('\n  ')}`);
  process.exit(1);
}
