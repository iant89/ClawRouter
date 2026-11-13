import { describe, expect, test } from 'bun:test';
import { createSecretBox, generateSecretKey, parseSecretKey } from '@clawrouter/core';
import { createSqliteProviderRepository } from '../src/index.ts';
import { rotateSecretKey } from '../../../apps/server/src/rotate-key.ts';
import { createHarness } from '../../../tests/support/harness.ts';

const actor = { id: 'u1', username: 'admin' };
const newBox = () => createSecretBox(parseSecretKey(generateSecretKey()));

async function withProviders() {
  const h = createHarness();
  for (const [name, identifier, key] of [['OpenAI', 'openai', 'sk-first-0123456789abcdef'], ['Other', 'other', 'sk-second-0123456789abcdef']] as const) {
    await h.providers.create(actor, { name, identifier, kind: 'openai', endpoint: 'https://api.example.test/v1', apiKey: key }, { ip: null });
  }
  return h;
}

describe('secret key rotation', () => {
  test('re-encrypts every credential so only the new key can read them', async () => {
    const h = await withProviders();
    const next = newBox();
    const repo = createSqliteProviderRepository(h.db);
    const before = repo.listCredentials();

    expect(await rotateSecretKey(h.db, h.secrets, next)).toEqual({ rotated: 2, alreadyNew: 0 });
    const after = repo.listCredentials();
    expect(after.every((c) => c.keyFingerprint === next.fingerprint)).toBe(true);
    const plain = await Promise.all(after.map((c) => next.decrypt(c.ciphertext, `provider:${c.providerId}:${c.name}`)));
    expect(plain.sort()).toEqual(['sk-first-0123456789abcdef', 'sk-second-0123456789abcdef']);
    await expect(h.secrets.decrypt(after[0]!.ciphertext, `provider:${after[0]!.providerId}:api_key`)).rejects.toThrow();
    expect(after.map((c) => c.ciphertext)).not.toEqual(before.map((c) => c.ciphertext));

    const record = h.audit.list({ action: 'SECRET_KEY_ROTATED' })[0]!;
    expect(record.metadata).toEqual({ from: h.secrets.fingerprint, to: next.fingerprint, rotated: 2, alreadyNew: 0 });
    expect(JSON.stringify(record)).not.toContain('sk-first');
  });

  test('running it again changes nothing', async () => {
    const h = await withProviders();
    const next = newBox();
    await rotateSecretKey(h.db, h.secrets, next);
    expect(await rotateSecretKey(h.db, h.secrets, next)).toEqual({ rotated: 0, alreadyNew: 2 });
  });

  test('refuses the same key, and values under an unknown key, before writing anything', async () => {
    const h = await withProviders();
    await expect(rotateSecretKey(h.db, h.secrets, h.secrets)).rejects.toThrow('same as the current key');
    const repo = createSqliteProviderRepository(h.db);
    const before = repo.listCredentials();
    // From the wrong "current" key: the stored values use neither.
    await expect(rotateSecretKey(h.db, newBox(), newBox())).rejects.toThrow('encrypted with a different key');
    expect(repo.listCredentials()).toEqual(before);
  });
});
