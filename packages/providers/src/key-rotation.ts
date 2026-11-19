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
