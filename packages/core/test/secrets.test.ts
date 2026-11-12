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
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
    await expect(b.decrypt(tampered, 'c')).rejects.toThrow();
  });

  test('accepts hex and base64 keys, rejects anything else', () => {
    expect(parseSecretKey('a'.repeat(64))).toHaveLength(32);
    expect(parseSecretKey(Buffer.alloc(32, 7).toString('base64'))).toHaveLength(32);
    expect(parseSecretKey(generateSecretKey())).toHaveLength(32);
    expect(() => parseSecretKey('short')).toThrow('32 bytes');
  });
});
