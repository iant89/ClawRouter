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
