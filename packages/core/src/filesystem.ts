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

import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';

/**
 * Filesystem hardening (SEC-023). ClawRouter's own files hold secrets or the
 * whole database, so they are private to the account it runs as: files 0600,
 * directories 0700. Every file is created with an explicit mode (never left to
 * the umask), and the process umask is 0077 as a second line of defence for
 * anything created without one (SQLite's temporary files, a library's).
 */
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_UMASK = 0o077;

/** Mode bits are meaningless on Windows: every check and change here is skipped there. */
const posix = process.platform !== 'win32';

/** Sets the process umask to 0077 (new files 0600, directories 0700). Returns the previous umask. */
export function restrictUmask(): number | null {
  if (!posix) return null;
  return process.umask(PRIVATE_UMASK);
}

/** Creates a directory (and missing parents) as 0700. An existing directory is left as it is. */
export function makePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/** Creates an empty file as 0600 if it does not exist yet. Returns true when it created it. */
export function createPrivateFile(path: string): boolean {
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, PRIVATE_FILE_MODE));
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Removes the group and other permission bits of an existing file or directory
 * (0644 becomes 0600, 0755 becomes 0700), except those `allowed` keeps (0o640
 * keeps the group's read). Symbolic links are never followed or changed. Returns
 * true when the mode changed; false when it was already private enough, does not
 * exist, or cannot be changed (owned by another account).
 */
export function tightenMode(path: string, allowed = 0o700): boolean {
  if (!posix) return false;
  try {
    const st = lstatSync(path);
    const remove = st.mode & 0o077 & ~allowed;
    if (st.isSymbolicLink() || !remove) return false;
    chmodSync(path, st.mode & 0o777 & ~remove);
    return true;
  } catch {
    return false;
  }
}

export interface PathAccess {
  path: string;
  exists: boolean;
  directory: boolean;
  symlink: boolean;
  /** Permission bits, e.g. 0o644. */
  mode: number;
  uid: number;
  gid: number;
  /** Bits granted to the group and to other users beyond the allowed ones. */
  extra: number;
}

/**
 * What a path allows beyond `allowed` (0o600 for files, 0o700 for directories
 * by default). `extra` is 0 when the path is private enough, or on Windows.
 */
export function pathAccess(path: string, allowed?: number): PathAccess {
  if (!existsSync(path) && !isLink(path)) return { path, exists: false, directory: false, symlink: false, mode: 0, uid: -1, gid: -1, extra: 0 };
  const st = lstatSync(path);
  const mode = st.mode & 0o777;
  const limit = allowed ?? (st.isDirectory() ? PRIVATE_DIR_MODE : PRIVATE_FILE_MODE);
  return { path, exists: true, directory: st.isDirectory(), symlink: st.isSymbolicLink(), mode, uid: st.uid, gid: st.gid, extra: posix ? mode & ~limit & 0o077 : 0 };
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** "group and other users can read", for messages. */
export function describeExtraAccess(extra: number): string {
  const who = [extra & 0o070 ? 'its group' : '', extra & 0o007 ? 'other users' : ''].filter(Boolean).join(' and ');
  const what = [extra & 0o044 ? 'read' : '', extra & 0o022 ? 'write' : '', extra & 0o011 ? 'enter' : ''].filter(Boolean).join('/');
  return `${who} can ${what || 'access'} it`;
}

/** Octal text of a mode: 0o644 -> "0644". */
export const octal = (mode: number) => `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
