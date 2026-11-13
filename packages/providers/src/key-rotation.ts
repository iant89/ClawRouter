import { AppError, type SecretBox } from '@clawrouter/core';
import type { ProviderRepository } from './repository.ts';

export interface RotationResult {
  /** Credentials re-encrypted with the new key. */
  rotated: number;
  /** Credentials that already used the new key (an earlier, interrupted run). */
  alreadyNew: number;
}

/**
 * Re-encrypts every stored provider credential from `from` (the current key) to
 * `to` (the new key). All or nothing: every value is decrypted and re-encrypted
 * in memory first, then written in one transaction. Running it again after it
 * succeeded changes nothing, so it is safe to repeat.
 *
 * Values encrypted with neither key stop the rotation before anything is written.
 */
export async function rotateCredentialKey(repo: ProviderRepository, from: SecretBox, to: SecretBox): Promise<RotationResult> {
  if (from.fingerprint === to.fingerprint) throw new AppError('VALIDATION_ERROR', 'The new key is the same as the current key.');
  const all = repo.listCredentials();
  const unknown = all.filter((c) => c.keyFingerprint !== from.fingerprint && c.keyFingerprint !== to.fingerprint);
  if (unknown.length) {
    throw new AppError('VALIDATION_ERROR', `${unknown.length} stored credential(s) were encrypted with a different key (fingerprint ${[...new Set(unknown.map((c) => c.keyFingerprint))].join(', ')}). Nothing was changed.`);
  }
  const pending = all.filter((c) => c.keyFingerprint === from.fingerprint);
  const updates = [];
  for (const c of pending) {
    // The same context binds the value to its owner, exactly as when it was stored.
    const context = `provider:${c.providerId}:${c.name}`;
    const plain = await from.decrypt(c.ciphertext, context);
    updates.push({ providerId: c.providerId, name: c.name, from: c.ciphertext, ciphertext: await to.encrypt(plain, context), keyFingerprint: to.fingerprint });
  }
  const rotated = updates.length ? repo.replaceCiphertexts(updates) : 0;
  return { rotated, alreadyNew: all.length - pending.length };
}
