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

/** 256-bit random token, base64url (43 chars). */
export function generateToken(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
}

/** Tokens are stored as SHA-256 hashes; the raw token only exists in the client's cookie. */
export function hashToken(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex');
}

/** Constant-time string comparison (hashes both sides so lengths match). */
export function safeEqual(a: string, b: string): boolean {
  const ha = new Bun.CryptoHasher('sha256').update(a).digest();
  const hb = new Bun.CryptoHasher('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
