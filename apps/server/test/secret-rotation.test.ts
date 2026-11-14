import { describe, expect, test } from 'bun:test';
import { base32Decode, hotp, totpStep } from '@clawrouter/authentication';
import { checkSealedSecrets, createSecretBox, generateSecretKey, parseSecretKey } from '@clawrouter/core';
import type { ApiSuccess, TotpSetup } from '@clawrouter/shared';
import { rotateSecretKey } from '../src/rotate-key.ts';
import { sealedSecretStores } from '../src/secret-stores.ts';
import { createHarness } from '../../../tests/support/harness.ts';

const actor = { id: 'u1', username: 'admin' };
const newBox = () => createSecretBox(parseSecretKey(generateSecretKey()));

/** Two provider keys, a mail server password and an enrolled authenticator app: every kind of stored secret. */
async function withSecrets() {
  const h = createHarness();
  const admin = await h.completeSetup();
  for (const [name, identifier, key] of [['OpenAI', 'openai', 'sk-first-0123456789abcdef'], ['Other', 'other', 'sk-second-0123456789abcdef']] as const) {
    await h.providers.create(actor, { name, identifier, kind: 'openai', endpoint: 'https://api.example.test/v1', apiKey: key }, { ip: null });
  }
  await h.request('/api/settings/mail', { method: 'PUT', cookie: admin, json: { enabled: true, host: 'smtp.example.test', port: 587, security: 'starttls', username: 'mailer', password: 'smtp-password-canary', from: 'ClawRouter <c@example.test>' } });
  const setup = ((await (await h.request('/api/auth/2fa/totp', { method: 'POST', cookie: admin, json: {} })).json()) as ApiSuccess<TotpSetup>).data;
  const code = hotp(base32Decode(setup.secret), totpStep(h.clock.time));
  expect((await h.request('/api/auth/2fa/totp/confirm', { method: 'POST', cookie: admin, json: { code } })).status).toBe(200);
  return h;
}

describe('secret key rotation (every stored secret)', () => {
  test('provider credentials, the mail password and authenticator secrets all move to the new key', async () => {
    const h = await withSecrets();
    const stores = sealedSecretStores(h.db);
    expect(stores.map((s) => [s.name, s.list().length])).toEqual([['provider credentials', 2], ['mail server password', 1], ['authenticator-app secrets', 1]]);
    const next = newBox();

    const result = await rotateSecretKey(h.db, h.secrets, next);
    expect(result).toEqual({ rotated: { 'provider credentials': 2, 'mail server password': 1, 'authenticator-app secrets': 1 }, alreadyNew: 0 });
    const withNew = await checkSealedSecrets(sealedSecretStores(h.db), next);
    expect(withNew.every((c) => c.ok)).toBe(true);
    expect((await checkSealedSecrets(sealedSecretStores(h.db), h.secrets)).some((c) => c.ok)).toBe(false);
    // The values themselves are unchanged.
    const provider = sealedSecretStores(h.db)[0]!.list();
    expect((await Promise.all(provider.map((s) => next.decrypt(s.ciphertext, s.context)))).sort()).toEqual(['sk-first-0123456789abcdef', 'sk-second-0123456789abcdef']);
    const mail = sealedSecretStores(h.db)[1]!.list()[0]!;
    expect(await next.decrypt(mail.ciphertext, mail.context)).toBe('smtp-password-canary');

    const record = h.audit.list({ action: 'SECRET_KEY_ROTATED' })[0]!;
    expect(record.metadata).toMatchObject({ from: h.secrets.fingerprint, to: next.fingerprint, alreadyNew: 0 });
    expect(JSON.stringify(record)).not.toContain('sk-first');
    expect(JSON.stringify(record)).not.toContain('smtp-password');
  });

  test('running it again changes nothing', async () => {
    const h = await withSecrets();
    const next = newBox();
    await rotateSecretKey(h.db, h.secrets, next);
    expect(await rotateSecretKey(h.db, h.secrets, next)).toEqual({ rotated: { 'provider credentials': 0, 'mail server password': 0, 'authenticator-app secrets': 0 }, alreadyNew: 4 });
  });

  test('refuses the same key, and values readable by neither key, before writing anything', async () => {
    const h = await withSecrets();
    await expect(rotateSecretKey(h.db, h.secrets, h.secrets)).rejects.toThrow('same as the current key');
    const before = sealedSecretStores(h.db).map((s) => s.list());
    await expect(rotateSecretKey(h.db, newBox(), newBox())).rejects.toThrow('can be read with neither key');
    expect(sealedSecretStores(h.db).map((s) => s.list())).toEqual(before);
  });
});
