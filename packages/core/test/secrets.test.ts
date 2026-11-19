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
import { createSecretBox, generateSecretKey, parseSecretKey } from '../src/index.ts';

const box = async (key = generateSecretKey()) => createSecretBox(parseSecretKey(key));

describe('secret box', () => {
  test('round trip; ciphertext does not contain the plaintext and differs each time', async () => {
    const b = await box();
    const a1 = await b.encrypt('sk-live-abcdef', 'provider:1:api_key');
    const a2 = await b.encrypt('sk-live-abcdef', 'provider:1:api_key');
    expect(a1).toStartWith('v1.');
    expect(a1).not.toBe(a2);
    expect(a1).not.toContain('sk-live');
    expect(await b.decrypt(a1, 'provider:1:api_key')).toBe('sk-live-abcdef');
  });

  test('a ciphertext moved to another owner fails', async () => {
    const b = await box();
    const sealed = await b.encrypt('secret', 'provider:1:api_key');
    await expect(b.decrypt(sealed, 'provider:2:api_key')).rejects.toThrow('could not be decrypted');
  });

  test('a different key fails and has a different fingerprint', async () => {
    const a = await box();
    const b = await box();
    expect(a.fingerprint).not.toBe(b.fingerprint);
    await expect(b.decrypt(await a.encrypt('x', 'c'), 'c')).rejects.toThrow();
  });

  test('tampering is detected', async () => {
    const b = await box();
    const sealed = await b.encrypt('secret', 'c');
    // Flip one bit of a decoded byte. (Replacing trailing base64 characters can leave
    // the bytes unchanged: the last character carries unused bits. CI caught that once.)
    const [version, iv, data] = sealed.split('.');
    for (let i = 0; i < Buffer.from(data!, 'base64url').length; i++) {
      const bytes = Buffer.from(data!, 'base64url');
      bytes[i]! ^= 0x01;
      await expect(b.decrypt(`${version}.${iv}.${bytes.toString('base64url')}`, 'c')).rejects.toThrow('could not be decrypted');
    }
    const ivBytes = Buffer.from(iv!, 'base64url');
    ivBytes[0]! ^= 0x01;
    await expect(b.decrypt(`${version}.${ivBytes.toString('base64url')}.${data}`, 'c')).rejects.toThrow('could not be decrypted');
  });

  test('accepts hex and base64 keys, rejects anything else', () => {
    expect(parseSecretKey('a'.repeat(64))).toHaveLength(32);
    expect(parseSecretKey(Buffer.alloc(32, 7).toString('base64'))).toHaveLength(32);
    expect(parseSecretKey(generateSecretKey())).toHaveLength(32);
    expect(() => parseSecretKey('short')).toThrow('32 bytes');
  });
});
