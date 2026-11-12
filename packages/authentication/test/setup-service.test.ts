import { describe, expect, test } from 'bun:test';
import { ADMIN, SETUP_TOKEN, createHarness } from '../../../tests/support/harness.ts';

const client = { ip: '198.51.100.1', userAgent: 'ua' };

describe('initial setup', () => {
  test('is required only while no user exists', async () => {
    const h = createHarness();
    expect(h.setup.isRequired()).toBe(true);
    const result = await h.setup.complete({ setupToken: SETUP_TOKEN, ...ADMIN }, client);
    expect(result.user.username).toBe(ADMIN.username);
    expect(h.setup.isRequired()).toBe(false);
    expect(h.audit.list().map((r) => r.action).sort()).toEqual(['LOGIN', 'ROLE_CHANGED', 'SETUP_COMPLETED', 'USER_CREATED']);
  });

  test('cannot run twice', async () => {
    const h = createHarness();
    await h.setup.complete({ setupToken: SETUP_TOKEN, ...ADMIN }, client);
    await expect(h.setup.complete({ setupToken: SETUP_TOKEN, ...ADMIN, username: 'second' }, client)).rejects.toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
  });

  test('concurrent attempts create exactly one administrator', async () => {
    const h = createHarness();
    const results = await Promise.allSettled([
      h.setup.complete({ setupToken: SETUP_TOKEN, ...ADMIN, username: 'one' }, client),
      h.setup.complete({ setupToken: SETUP_TOKEN, ...ADMIN, username: 'two' }, client),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(h.users.count()).toBe(1);
  });

  test('requires the setup token and throttles guessing', async () => {
    const h = createHarness();
    await expect(h.setup.complete({ setupToken: 'guess', ...ADMIN }, client)).rejects.toThrow(expect.objectContaining({ code: 'AUTHENTICATION_ERROR' }));
    for (let i = 0; i < 10; i++) await h.setup.complete({ setupToken: `guess${i}`, ...ADMIN }, client).catch(() => {});
    await expect(h.setup.complete({ setupToken: SETUP_TOKEN, ...ADMIN }, client)).rejects.toThrow(expect.objectContaining({ code: 'RATE_LIMITED' }));
    expect(h.users.count()).toBe(0);
  });

  test('enforces username format and password policy', async () => {
    const h = createHarness();
    const error = await h.setup.complete({ setupToken: SETUP_TOKEN, username: 'bad name!', displayName: 'x', password: 'short' }, client).catch((e) => e);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details.issues.map((i: { path: string }) => i.path).sort()).toEqual(['password', 'username']);
  });

  test('stores an argon2id hash, never the password', async () => {
    const h = createHarness();
    await h.setup.complete({ setupToken: SETUP_TOKEN, ...ADMIN }, client);
    const row = h.db.get<{ password_hash: string }>('SELECT password_hash FROM users');
    expect(row?.password_hash).toStartWith('$argon2id$');
    expect(JSON.stringify(h.db.all('SELECT * FROM users'))).not.toContain(ADMIN.password);
    expect(JSON.stringify(h.db.all('SELECT * FROM audit_log'))).not.toContain(ADMIN.password);
  });
});
