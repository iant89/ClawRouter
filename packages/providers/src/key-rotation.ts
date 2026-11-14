import type { SealedSecretStore } from '@clawrouter/core';
import type { ProviderRepository } from './repository.ts';

/**
 * Provider credentials (API keys) as sealed secrets, for key rotation, checks and
 * credential recovery (see `SealedSecretStore` in core). The context binds each
 * value to its provider exactly as when it was stored.
 */
export function providerCredentialSecrets(repo: ProviderRepository, names: (providerId: string) => string = (id) => id): SealedSecretStore {
  return {
    name: 'provider credentials',
    whenForgotten: 'the provider has no API key until one is entered again (Providers page)',
    list: () => repo.listCredentials().map((c) => ({
      id: `${c.providerId}/${c.name}`, label: `provider ${names(c.providerId)}`, context: `provider:${c.providerId}:${c.name}`,
      ciphertext: c.ciphertext, fingerprint: c.keyFingerprint,
    })),
    replace(id, from, ciphertext, fingerprint) {
      const [providerId, name] = splitId(id);
      try {
        return repo.replaceCiphertexts([{ providerId, name, from, ciphertext, keyFingerprint: fingerprint }]) === 1;
      } catch {
        return false; // changed meanwhile
      }
    },
    forget(id) {
      const [providerId, name] = splitId(id);
      repo.deleteCredential(providerId, name);
    },
  };
}

function splitId(id: string): [string, string] {
  const at = id.lastIndexOf('/');
  return [id.slice(0, at), id.slice(at + 1)];
}
