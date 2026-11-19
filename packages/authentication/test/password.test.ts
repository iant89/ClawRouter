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

import { describe, expect, test } from 'bun:test';
import { checkPasswordPolicy, generateToken, hashToken, safeEqual } from '../src/index.ts';
import { fastHasher } from '../../../tests/support/harness.ts';

describe('password hashing', () => {
  test('argon2id round trip', async () => {
    const hash = await fastHasher.hash('correct horse battery staple');
    expect(hash).toStartWith('$argon2id$');
    expect(await fastHasher.verify('correct horse battery staple', hash)).toBe(true);
    expect(await fastHasher.verify('wrong', hash)).toBe(false);
  });

  test('a malformed hash is a mismatch, not a crash', async () => {
    expect(await fastHasher.verify('x', 'not-a-hash')).toBe(false);
  });
});

describe('password policy', () => {
  test('accepts a long passphrase', () => {
    expect(checkPasswordPolicy('correct horse battery staple', 'admin')).toEqual([]);
  });
  test.each([
    ['short', 'at least 12'],
    ['x'.repeat(257), 'at most 256'],
    ['my-admin-password', 'username'],
    ['aaaaaaaaaaaabbbb', '4 different'],
  ])('rejects %s', (password, message) => {
    expect(checkPasswordPolicy(password, 'admin').map((i) => i.message).join()).toContain(message);
  });
});

describe('tokens', () => {
  test('are random, 256-bit, base64url', () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
  });
  test('hash is stable SHA-256 hex', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  test('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
