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
 * Signed releases (SEC-020): source -> build -> artifact -> SHA-256 -> signature -> GitHub release.
 *
 * - The artifact is a reproducible .tar.gz (sorted entries, fixed times and owners, no links).
 * - SHA256SUMS lists every release file in `sha256sum -c` format.
 * - SHA256SUMS.sig is an Ed25519 signature of SHA256SUMS (64 raw bytes), so one signature
 *   covers every file. OpenSSL can verify it without ClawRouter (docs/security/release-verification.md).
 * - verifyRelease() checks all of it, and that the archive cannot write outside its folder.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const CHECKSUMS = 'SHA256SUMS';
export const SIGNATURE = 'SHA256SUMS.sig';

export const artifactNames = (version: string) => ({
  archive: `clawrouter-${version}.tar.gz`,
  spdx: `clawrouter-${version}.spdx.json`,
  cyclonedx: `clawrouter-${version}.cdx.json`,
});

// ---------------------------------------------------------------------------------------------
// Reproducible tar (ustar) written here, so the archive is the same on every machine.

export interface ArchiveEntry {
  path: string;
  data: Uint8Array;
  executable: boolean;
}

/** Every regular file under `dir`, as archive entries under `prefix`. Links are refused. */
export function collectFiles(dir: string, prefix: string): ArchiveEntry[] {
  const out: ArchiveEntry[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new Error(`refusing to package a symbolic link: ${full}`);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push({ path: `${prefix}/${relative(dir, full).split('\\').join('/')}`, data: readFileSync(full), executable: (st.mode & 0o111) !== 0 });
    }
  };
  walk(dir);
  return out;
}

function header(path: string, size: number, mode: number, type: '0' | '5', mtime: number): Uint8Array {
  const h = new Uint8Array(512);
  const put = (offset: number, length: number, value: string) => {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length > length) throw new Error(`tar field too long: ${value}`);
    h.set(bytes, offset);
  };
  const octal = (offset: number, length: number, n: number) => put(offset, length, `${n.toString(8).padStart(length - 1, '0')}\0`);
  let name = path;
  let prefix = '';
  if (new TextEncoder().encode(path).length > 100) {
    const cut = path.lastIndexOf('/', 155);
    if (cut <= 0 || path.length - cut - 1 > 100) throw new Error(`path too long for the archive: ${path}`);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  put(0, 100, name);
  octal(100, 8, mode);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, mtime);
  h.fill(0x20, 148, 156);
  put(156, 1, type);
  put(257, 6, 'ustar\0');
  put(263, 2, '00');
  put(345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  put(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return h;
}

/** A gzip-compressed ustar archive; the same entries and time always give the same bytes. */
export function createArchive(entries: ArchiveEntry[], mtime: number): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const dirs = new Set<string>();
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const segments = e.path.split('/');
    for (let i = 1; i < segments.length; i++) {
      const dir = `${segments.slice(0, i).join('/')}/`;
      if (!dirs.has(dir)) {
        dirs.add(dir);
        parts.push(header(dir, 0, 0o755, '5', mtime));
      }
    }
    parts.push(header(e.path, e.data.length, e.executable ? 0o755 : 0o644, '0', mtime));
    parts.push(e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  const tar = Buffer.concat(parts);
  // gzip header: mtime 0, no file name, so the bytes depend on the content only.
  return Bun.gzipSync(tar, { level: 9 });
}

export interface ArchiveListing {
  path: string;
  type: string;
  size: number;
}

/** Lists a .tar.gz without extracting it. */
export function listArchive(bytes: Uint8Array): ArchiveListing[] {
  const tar = Bun.gunzipSync(new Uint8Array(bytes));
  const out: ArchiveListing[] = [];
  const text = (from: number, len: number) => new TextDecoder().decode(tar.subarray(from, from + len)).replace(/\0.*$/s, '');
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break;
    const name = text(offset, 100);
    const prefix = text(offset + 345, 155);
    const size = parseInt(text(offset + 124, 12).trim() || '0', 8);
    const type = text(offset + 156, 1) || '0';
    out.push({ path: prefix ? `${prefix}/${name}` : name, type, size });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Checksums and signatures.

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** `sha256sum` format: "<hex>  <name>", sorted by name. */
export function checksumFile(dir: string, names: string[]): string {
  return `${[...names].sort().map((n) => `${sha256(readFileSync(join(dir, n)))}  ${n}`).join('\n')}\n`;
}

export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split('\n');
  if (lines.pop() !== '') throw new Error(`${CHECKSUMS} must end with a newline`);
  for (const line of lines) {
    const m = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!m) throw new Error(`${CHECKSUMS}: unreadable line "${line.slice(0, 120)}"`);
    if (out.has(m[2]!)) throw new Error(`${CHECKSUMS}: ${m[2]} is listed twice`);
    out.set(m[2]!, m[1]!);
  }
  if (!out.size) throw new Error(`${CHECKSUMS} lists no files`);
  return out;
}

export function loadPrivateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the release signing key must be an Ed25519 key');
  return key;
}

export function loadPublicKey(pem: string): KeyObject {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the release public key must be an Ed25519 key');
  return key;
}

export const publicKeyPem = (key: KeyObject) => createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();

export function generateSigningKey(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export const signBytes = (data: Uint8Array, key: KeyObject): Uint8Array => sign(null, data, key);
export const verifyBytes = (data: Uint8Array, signature: Uint8Array, key: KeyObject): boolean => {
  try {
    return signature.length === 64 && verify(null, data, key, signature);
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------------------------
// Verification.

export interface VerifyOptions {
  /** PEM of the Ed25519 public key. Without it the signature is not checked (only with allowUnsigned). */
  publicKey?: string;
  allowUnsigned?: boolean;
  /** The version the release must be (e.g. from the tag). */
  expectVersion?: string;
}

export interface VerifyResult {
  version: string;
  files: string[];
  signed: boolean;
}

/** Checks a release folder; throws with every problem found. */
export function verifyRelease(dir: string, options: VerifyOptions = {}): VerifyResult {
  const problems: string[] = [];
  const checksumsPath = join(dir, CHECKSUMS);
  if (!existsSync(checksumsPath)) throw new Error(`${CHECKSUMS} is missing`);
  const checksumsBytes = readFileSync(checksumsPath);
  const listed = parseChecksums(checksumsBytes.toString('utf8'));

  // 1. Signature over SHA256SUMS: every other check relies on that file being genuine.
  let signed = false;
  const sigPath = join(dir, SIGNATURE);
  if (existsSync(sigPath)) {
    if (!options.publicKey) {
      if (!options.allowUnsigned) problems.push('no public key given to check the signature with');
    } else if (!verifyBytes(checksumsBytes, readFileSync(sigPath), loadPublicKey(options.publicKey))) {
      problems.push(`${SIGNATURE} does not match ${CHECKSUMS} and the public key: the release was changed or signed by someone else`);
    } else {
      signed = true;
    }
  } else if (!options.allowUnsigned) {
    problems.push(`${SIGNATURE} is missing: the release is not signed`);
  }

  // 2. Every listed file matches its checksum, and nothing else is in the folder.
  for (const [name, hash] of listed) {
    const path = join(dir, name);
    if (!existsSync(path)) problems.push(`${name} is listed in ${CHECKSUMS} but missing`);
    else if (sha256(readFileSync(path)) !== hash) problems.push(`${name} does not match its SHA-256 in ${CHECKSUMS}`);
  }
  for (const name of readdirSync(dir)) {
    if (name !== CHECKSUMS && name !== SIGNATURE && !listed.has(name)) problems.push(`${name} is not listed in ${CHECKSUMS}`);
  }

  // 3. The expected files, all for one version.
  const archive = [...listed.keys()].find((n) => /^clawrouter-.+\.tar\.gz$/.test(n));
  const version = archive?.slice('clawrouter-'.length, -'.tar.gz'.length) ?? '';
  if (!archive) problems.push('no clawrouter-<version>.tar.gz in the release');
  if (options.expectVersion && version !== options.expectVersion) problems.push(`the release is version ${version || '?'}, expected ${options.expectVersion}`);
  const names = artifactNames(version);
  for (const required of [names.spdx, names.cyclonedx]) if (!listed.has(required)) problems.push(`${required} is missing from the release`);

  if (archive && existsSync(join(dir, archive)) && !problems.some((p) => p.startsWith(archive))) {
    // 4. The archive only holds plain files and folders inside clawrouter-<version>/.
    try {
      const entries = listArchive(readFileSync(join(dir, archive)));
      const top = `clawrouter-${version}/`;
      for (const e of entries) {
        if (!e.path.startsWith(top) || e.path.split('/').includes('..') || e.path.includes('\\')) problems.push(`archive entry outside ${top}: ${e.path}`);
        if (e.type !== '0' && e.type !== '5') problems.push(`archive entry is not a plain file or folder: ${e.path} (type ${e.type})`);
      }
      for (const needed of ['dist/main.js', 'LICENSE', 'BUILD-INFO.json']) {
        if (!entries.some((e) => e.path === `${top}${needed}`)) problems.push(`the archive has no ${needed}`);
      }
    } catch (e) {
      problems.push(`${archive} cannot be read: ${(e as Error).message}`);
    }
  }

  // 5. The SBOMs describe this version.
  for (const [file, read] of [
    [names.spdx, (j: Record<string, unknown>) => (j.packages as { name: string; versionInfo: string }[] | undefined)?.find((p) => p.name === 'clawrouter')?.versionInfo],
    [names.cyclonedx, (j: Record<string, unknown>) => (j.metadata as { component?: { version?: string } } | undefined)?.component?.version],
  ] as const) {
    if (!listed.has(file) || !existsSync(join(dir, file))) continue;
    try {
      const v = read(JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>);
      if (v !== version) problems.push(`${file} describes version ${v ?? '?'}, not ${version}`);
    } catch {
      problems.push(`${file} is not valid JSON`);
    }
  }

  if (problems.length) throw new Error(problems.join('\n'));
  return { version, files: [...listed.keys()], signed };
}
