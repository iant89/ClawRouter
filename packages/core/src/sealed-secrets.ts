import { AppError } from './errors.ts';
import type { SecretBox } from './secrets.ts';

/** One value encrypted with the server's secret key. Never carries the plaintext. */
export interface SealedSecret {
  /** Unique within its store (e.g. "<providerId>/api_key", a user id). */
  id: string;
  /** For people: which provider, user or setting it belongs to. */
  label: string;
  /** Additional authenticated data it was sealed with; needed to open it. */
  context: string;
  ciphertext: string;
  /** Fingerprint of the key it was sealed with, when the store records it. */
  fingerprint: string | null;
}

/**
 * Every kind of value encrypted with the secret key implements this (phase 17):
 * provider credentials, the mail server password, authenticator-app secrets.
 * Key rotation, `doctor`, restore checks and credential recovery all go through
 * it, so a new kind of secret only has to add a store to `sealedSecretStores`.
 */
export interface SealedSecretStore {
  /** Plural, for messages: "provider credentials". */
  readonly name: string;
  /** What forgetting a value means for the operator. */
  readonly whenForgotten: string;
  list(): SealedSecret[];
  /** Replaces `from` with `ciphertext`; false when the value changed meanwhile. Called inside a transaction. */
  replace(id: string, from: string, ciphertext: string, fingerprint: string): boolean;
  /** Removes a value that can no longer be decrypted (credential recovery). */
  forget(id: string): void;
}

export interface SecretCheck {
  store: string;
  secret: SealedSecret;
  ok: boolean;
}

/** Tries to open every stored secret with `box`. Reveals nothing but success or failure. */
export async function checkSealedSecrets(stores: readonly SealedSecretStore[], box: SecretBox): Promise<SecretCheck[]> {
  const out: SecretCheck[] = [];
  for (const store of stores) {
    for (const secret of store.list()) {
      let ok = true;
      try {
        await box.decrypt(secret.ciphertext, secret.context);
      } catch {
        ok = false;
      }
      out.push({ store: store.name, secret, ok });
    }
  }
  return out;
}

export interface SecretRotation {
  /** Values re-encrypted with the new key, per store. */
  rotated: Record<string, number>;
  /** Values already readable with the new key (an earlier, interrupted run). */
  alreadyNew: number;
}

/**
 * Re-encrypts every stored secret from `from` to `to`. All or nothing: every
 * value is opened and resealed in memory first (anything readable by neither key
 * stops it before a write), then all are written in one `transaction`. Running it
 * again after it succeeded changes nothing.
 */
export async function rotateSealedSecrets(
  stores: readonly SealedSecretStore[], from: SecretBox, to: SecretBox, transaction: (fn: () => void) => void,
): Promise<SecretRotation> {
  if (from.fingerprint === to.fingerprint) throw new AppError('VALIDATION_ERROR', 'The new key is the same as the current key.');
  const updates: { store: SealedSecretStore; secret: SealedSecret; ciphertext: string }[] = [];
  const unreadable: string[] = [];
  let alreadyNew = 0;
  for (const store of stores) {
    for (const secret of store.list()) {
      let plain: string | null = null;
      try {
        plain = await from.decrypt(secret.ciphertext, secret.context);
      } catch {
        try {
          await to.decrypt(secret.ciphertext, secret.context);
          alreadyNew += 1;
          continue;
        } catch {
          unreadable.push(`${secret.label} (${store.name})`);
          continue;
        }
      }
      updates.push({ store, secret, ciphertext: await to.encrypt(plain, secret.context) });
    }
  }
  if (unreadable.length) {
    throw new AppError('VALIDATION_ERROR', `${unreadable.length} stored secret(s) can be read with neither key: ${unreadable.join(', ')}. Nothing was changed.`);
  }
  const rotated: Record<string, number> = Object.fromEntries(stores.map((s) => [s.name, 0]));
  transaction(() => {
    for (const u of updates) {
      if (!u.store.replace(u.secret.id, u.secret.ciphertext, u.ciphertext, to.fingerprint)) {
        throw new AppError('CONFLICT', 'Stored secrets changed during the rotation; nothing was changed. Stop ClawRouter and run it again.');
      }
      rotated[u.store.name] = (rotated[u.store.name] ?? 0) + 1;
    }
  });
  return { rotated, alreadyNew };
}
