import { describe, expect, test } from 'bun:test';
// zxing's QR reader, vendored by ENTERPRISE-UI for its barcode scanner: an independent check
// that what we draw is a valid QR code (format, version, error correction, data).
// The vendored build ships without type declarations; the shapes used are typed below.
// @ts-expect-error no declaration file
import BitMatrixJs from '../node_modules/@enterprise-ui/react/dist/vendor/zxing-library/esm/core/common/BitMatrix.js';
// @ts-expect-error no declaration file
import DecoderJs from '../node_modules/@enterprise-ui/react/dist/vendor/zxing-library/esm/core/qrcode/decoder/Decoder.js';
import { encodeQr, QR_MAX_VERSION, type QrMatrix } from '../src/components/custom/qr-code.ts';

const BitMatrix = BitMatrixJs as new (width: number, height: number) => { set(x: number, y: number): void };
const Decoder = DecoderJs as new () => { decodeBitMatrix(m: unknown): { getText(): string; getECLevel(): string } };

function decode(qr: QrMatrix): { text: string; level: string } {
  const matrix = new BitMatrix(qr.size, qr.size);
  qr.modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) matrix.set(x, y); }));
  const result = new Decoder().decodeBitMatrix(matrix);
  return { text: result.getText(), level: result.getECLevel() };
}

/** Text of exactly `n` bytes. */
const text = (n: number) => Array.from({ length: n }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[i % 36]).join('');

describe('QR code encoder', () => {
  test('an authenticator setup link decodes to itself', () => {
    const uri = 'otpauth://totp/ClawRouter:admin?secret=ELXN4REOFSG5576CI24ZS74MNOQNNRW7&issuer=ClawRouter&algorithm=SHA1&digits=6&period=30';
    const qr = encodeQr(uri);
    expect(qr.version).toBe(8); // 123 bytes; version 7 holds 122 at level M
    expect(qr.size).toBe(49);
    expect(decode(qr)).toEqual({ text: uri, level: 'M' });
  });

  test('every version, 1 to 20, decodes', () => {
    for (let version = 1; version <= QR_MAX_VERSION; version++) {
      const qr = encodeQr(text(version * 10), { minVersion: version });
      expect(qr.version).toBe(version);
      expect(decode(qr).text).toBe(text(version * 10));
    }
  });

  test('every mask pattern decodes', () => {
    for (let mask = 0; mask < 8; mask++) {
      const qr = encodeQr('otpauth://totp/ClawRouter:someone%40example.com?secret=ABC', { mask });
      expect(qr.mask).toBe(mask);
      expect(decode(qr).text).toBe('otpauth://totp/ClawRouter:someone%40example.com?secret=ABC');
    }
  });

  test('picks the smallest version that fits, and handles UTF-8', () => {
    expect(encodeQr(text(14)).version).toBe(1); // 14 bytes is version 1's limit at level M
    expect(encodeQr(text(15)).version).toBe(2);
    expect(decode(encodeQr('Zoë · ClawRouter')).text).toBe('Zoë · ClawRouter');
  });

  test('the longest setup link fits (64-character username, every character escaped)', () => {
    const uri = `otpauth://totp/ClawRouter:${'%E2'.repeat(64)}?secret=${'A'.repeat(32)}&issuer=ClawRouter&algorithm=SHA1&digits=6&period=30`;
    expect(decode(encodeQr(uri)).text).toBe(uri);
  });

  test('refuses text too long for version 20', () => {
    expect(() => encodeQr(text(700))).toThrow('Too long');
  });
});
