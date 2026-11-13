import { describe, expect, test } from 'bun:test';
import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUri, totpStep, verifyTotp } from '../src/totp.ts';

// RFC 6238 appendix B, SHA-1 (the 8-digit values; authenticators use the last 6).
const RFC_SECRET = new TextEncoder().encode('12345678901234567890');
const VECTORS: [number, string][] = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];

describe('TOTP (RFC 6238)', () => {
  test('matches the RFC test vectors', () => {
    for (const [seconds, code] of VECTORS) expect(hotp(RFC_SECRET, totpStep(seconds * 1000), 8)).toBe(code);
  });

  test('base32 round-trips and secrets are 160 bits', () => {
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect([...base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')]).toEqual([...RFC_SECRET]);
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
  });

  test('accepts the current step and one either side, then never the same step again', () => {
    const secret = base32Encode(RFC_SECRET);
    const t = 1111111111 * 1000;
    const now = hotp(RFC_SECRET, totpStep(t));
    const step = verifyTotp(secret, now, t, null);
    expect(step).toBe(totpStep(t));
    expect(verifyTotp(secret, now, t, step)).toBeNull(); // replay
    expect(verifyTotp(secret, hotp(RFC_SECRET, totpStep(t) - 1), t, null)).toBe(totpStep(t) - 1);
    expect(verifyTotp(secret, hotp(RFC_SECRET, totpStep(t) + 1), t, null)).toBe(totpStep(t) + 1);
    expect(verifyTotp(secret, hotp(RFC_SECRET, totpStep(t) - 2), t, null)).toBeNull();
    expect(verifyTotp(secret, '12345', t, null)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', t, null)).toBeNull();
    expect(verifyTotp(secret, `${now.slice(0, 3)} ${now.slice(3)}`, t, null)).toBe(totpStep(t));
  });

  test('otpauth URI for authenticator apps', () => {
    expect(otpauthUri('ClawRouter', 'ada@example.com', 'ABC')).toBe('otpauth://totp/ClawRouter:ada%40example.com?secret=ABC&issuer=ClawRouter&algorithm=SHA1&digits=6&period=30');
  });
});
