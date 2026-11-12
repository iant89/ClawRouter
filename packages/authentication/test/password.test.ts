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
