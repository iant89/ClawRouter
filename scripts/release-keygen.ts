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
 * Creates the release signing key pair (SEC-020), once, on the maintainer's machine:
 *
 *   bun run release:keygen <private key file>
 *
 * The private key is written to the given file (mode 0600, never inside the repository) and
 * belongs in the GitHub secret CLAWROUTER_RELEASE_SIGNING_KEY; the public key is written to
 * docs/security/release-signing-key.pub, to be committed. See docs/security/release-verification.md.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { generateSigningKey } from './supply-chain/release.ts';

const root = resolve(import.meta.dir, '..');
const target = process.argv[2];
if (!target) {
  console.error('Usage: bun run release:keygen <private key file outside the repository>');
  process.exit(2);
}
const file = resolve(target);
if (!relative(root, file).startsWith('..')) {
  console.error('Write the private key outside the repository, so it can never be committed.');
  process.exit(1);
}
const publicPath = join(root, 'docs/security/release-signing-key.pub');
for (const f of [file, publicPath]) {
  if (existsSync(f)) {
    console.error(`${f} exists; refusing to overwrite a key.`);
    process.exit(1);
  }
}
const { privateKey, publicKey } = generateSigningKey();
writeFileSync(file, privateKey, { mode: 0o600 });
writeFileSync(publicPath, publicKey);
console.log(`Private key: ${file} (store it as the GitHub secret CLAWROUTER_RELEASE_SIGNING_KEY and keep an offline copy)`);
console.log(`Public key:  ${publicPath} (commit it)`);
