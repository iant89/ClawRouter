import { AppError } from './errors.ts';

/**
 * Encryption of secrets at rest (spec §29): AES-256-GCM via WebCrypto.
 *
 * - The key lives outside the database (environment variable or key file).
 * - Each value has a random 96-bit IV.
 * - Additional authenticated data binds a ciphertext to its owner (e.g.
 *   "provider:<id>:api_key"), so a ciphertext copied to another row fails to decrypt.
 * - A key fingerprint is stored with each value so a wrong key is reported
 *   clearly instead of as corrupt data.
 *
 * Format: `v1.<iv base64url>.<ciphertext+tag base64url>`.
 */
export interface SecretBox {
  /** First 16 hex chars of SHA-256(key). Safe to store and log. */
  readonly fingerprint: string;
  encrypt(plaintext: string, context: string): Promise<string>;
  decrypt(sealed: string, context: string): Promise<string>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const unb64 = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(text, 'base64url'));

/** Parses a 32-byte key given as base64 / base64url (44 or 43 chars) or hex (64 chars). */
export function parseSecretKey(text: string): Uint8Array {
  const value = text.trim();
  let bytes: Uint8Array | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) bytes = new Uint8Array(Buffer.from(value, 'hex'));
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) bytes = new Uint8Array(Buffer.from(value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=$/, ''), 'base64url'));
  if (!bytes || bytes.length !== 32) {
    throw new AppError('VALIDATION_ERROR', 'The secret key must be 32 bytes, as 64 hex characters or base64. Generate one with: openssl rand -base64 32');
  }
  return bytes;
}

export function generateSecretKey(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}

/** Synchronous to construct; the WebCrypto key is imported on first use. */
export function createSecretBox(keyBytes: Uint8Array): SecretBox {
  if (keyBytes.length !== 32) throw new AppError('INTERNAL_ERROR', 'Secret key must be 32 bytes');
  let imported: Promise<CryptoKey> | undefined;
  const key = () => (imported ??= crypto.subtle.importKey('raw', new Uint8Array(keyBytes), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
  const fingerprint = new Bun.CryptoHasher('sha256').update(keyBytes).digest('hex').slice(0, 16);

  return {
    fingerprint,
    async encrypt(plaintext, context) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, await key(), encoder.encode(plaintext));
      return `v1.${b64(iv)}.${b64(new Uint8Array(sealed))}`;
    },
    async decrypt(sealed, context) {
      const [version, iv, data] = sealed.split('.');
      if (version !== 'v1' || !iv || !data) throw new AppError('INTERNAL_ERROR', 'Unsupported secret format');
      try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: encoder.encode(context) }, await key(), unb64(data));
        return decoder.decode(plain);
      } catch (cause) {
        throw new AppError('INTERNAL_ERROR', 'A stored secret could not be decrypted', { cause });
      }
    },
  };
}
