import { describe, expect, test } from 'bun:test';
import { AppError } from '@clawapi/core';
import { hashToken } from '../src/index.ts';
import { ADMIN, createHarness } from '../../../tests/support/harness.ts';

const client = { ip: '198.51.100.1', userAgent: 'test-agent', requestId: 'req_test' };

async function withAdmin(options?: Parameters<typeof createHarness>[0]) {
  const h = createHarness(options);
  await h.setup.complete({ setupToken: 'test-setup-token-0123456789', ...ADMIN }, client);
  return h;
}

describe('login', () => {
  test('creates a session and records LOGIN', async () => {
    const h = await withAdmin();
    const result = await h.auth.login('ADMIN', ADMIN.password, client); // usernames are case-insensitive
    expect(result.user.username).toBe('admin');
    expect(result.user).not.toHaveProperty('passwordHash');
    expect(result.session.current).toBe(true);
    expect(h.audit.list({ action: 'LOGIN' })).toHaveLength(2); // setup + this login
  });

  test('stores only a hash of the session token', async () => {
    const h = await withAdmin();
    const { token } = await h.auth.login(ADMIN.username, ADMIN.password, client);
    const rows = h.db.all<{ token_hash: string }>('SELECT token_hash FROM sessions');
    expect(rows.some((r) => r.token_hash === hashToken(token))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  test('wrong password and unknown user fail identically and are audited', async () => {
    const h = await withAdmin();
    const messages: string[] = [];
    for (const [u, p] of [['admin', 'nope'], ['ghost', 'nope']] as const) {
      try {
        await h.auth.login(u, p, client);
      } catch (error) {
        expect((error as AppError).code).toBe('AUTHENTICATION_ERROR');
        messages.push((error as AppError).message);
      }
    }
    expect(messages[0]).toBe(messages[1]!);
    const failed = h.audit.list({ action: 'LOGIN_FAILED' });
    expect(failed).toHaveLength(2);
    expect(JSON.stringify(failed)).not.toContain('nope'); // attempted password never stored
  });

  test('disabled users cannot sign in', async () => {
    const h = await withAdmin();
    h.db.run("UPDATE users SET status = 'DISABLED'");
    await expect(h.auth.login(ADMIN.username, ADMIN.password, client)).rejects.toThrow('disabled');
  });

  test('throttles repeated failures per username with Retry-After', async () => {
    const h = await withAdmin();
    for (let i = 0; i < 10; i++) await h.auth.login('admin', `wrong${i}`, { ...client, ip: `10.0.0.${i}` }).catch(() => {});
    const error = await h.auth.login('admin', ADMIN.password, client).catch((e: AppError) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('RATE_LIMITED');
    expect(Number((error as AppError).headers['Retry-After'])).toBeGreaterThan(0);
    h.clock.advance(15 * 60_000);
    await expect(h.auth.login('admin', ADMIN.password, client)).resolves.toBeDefined();
  });

  test('a successful login resets the username throttle', async () => {
    const h = await withAdmin();
    for (let i = 0; i < 9; i++) await h.auth.login('admin', 'wrong', client).catch(() => {});
    await h.auth.login('admin', ADMIN.password, client);
    await h.auth.login('admin', 'wrong', client).catch(() => {});
    await expect(h.auth.login('admin', ADMIN.password, client)).resolves.toBeDefined();
  });
});

describe('sessions', () => {
  test('resolve returns the user for a live session', async () => {
    const h = await withAdmin();
    const { token } = await h.auth.login(ADMIN.username, ADMIN.password, client);
    expect(h.auth.resolve(token)?.user.username).toBe('admin');
    expect(h.auth.resolve('garbage')).toBeNull();
    expect(h.auth.resolve('')).toBeNull();
  });

  test('expire after the idle timeout', async () => {
    const h = await withAdmin({ idleMinutes: 30 });
    const { token } = await h.auth.login(ADMIN.username, ADMIN.password, client);
    h.clock.advance(29 * 60_000);
    expect(h.auth.resolve(token)).not.toBeNull(); // activity slides the window
    h.clock.advance(29 * 60_000);
    expect(h.auth.resolve(token)).not.toBeNull();
    h.clock.advance(31 * 60_000);
    expect(h.auth.resolve(token)).toBeNull();
  });

  test('expire at the absolute lifetime even when active', async () => {
    const h = await withAdmin({ idleMinutes: 60, maxHours: 2 });
    const { token } = await h.auth.login(ADMIN.username, ADMIN.password, client);
    for (let i = 0; i < 3; i++) {
      h.clock.advance(50 * 60_000);
      h.auth.resolve(token);
    }
    expect(h.auth.resolve(token)).toBeNull();
  });

  test('end when the user is disabled', async () => {
    const h = await withAdmin();
    const { token } = await h.auth.login(ADMIN.username, ADMIN.password, client);
    h.db.run("UPDATE users SET status = 'DISABLED'");
    expect(h.auth.resolve(token)).toBeNull();
  });

  test('logout revokes the session, audits and emits session.revoked', async () => {
    const h = await withAdmin();
    const revoked: string[] = [];
    h.events.on('session.revoked', (e) => { revoked.push(e.reason); });
    const { token } = await h.auth.login(ADMIN.username, ADMIN.password, client);
    h.auth.logout(token, client);
    expect(h.auth.resolve(token)).toBeNull();
    expect(revoked).toEqual(['LOGOUT']);
    expect(h.audit.list({ action: 'LOGOUT' })).toHaveLength(1);
    h.auth.logout(token, client); // idempotent
    expect(h.audit.list({ action: 'LOGOUT' })).toHaveLength(1);
  });

  test('users can list and revoke only their own sessions', async () => {
    const h = await withAdmin();
    const a = await h.auth.login(ADMIN.username, ADMIN.password, client);
    const b = await h.auth.login(ADMIN.username, ADMIN.password, { ...client, userAgent: 'other' });
    const list = h.auth.listSessions(a.user.id, a.session.id);
    expect(list.length).toBe(3); // setup session + 2
    expect(list.filter((s) => s.current).map((s) => s.id)).toEqual([a.session.id]);

    const stranger = { ...a.user, id: 'someone-else' };
    expect(h.auth.revokeOwnSession(stranger, b.session.id, client)).toBe(false);
    expect(h.auth.revokeOwnSession(a.user, b.session.id, client)).toBe(true);
    expect(h.auth.resolve(b.token)).toBeNull();
    expect(h.auth.resolve(a.token)).not.toBeNull();
    expect(h.audit.list({ action: 'SESSION_REVOKED' })).toHaveLength(1);
  });

  test('revokeAllSessions can keep the current one', async () => {
    const h = await withAdmin();
    const a = await h.auth.login(ADMIN.username, ADMIN.password, client);
    const b = await h.auth.login(ADMIN.username, ADMIN.password, client);
    expect(h.auth.revokeAllSessions(a.user.id, 'PASSWORD_CHANGED', a.session.id)).toBe(2);
    expect(h.auth.resolve(a.token)).not.toBeNull();
    expect(h.auth.resolve(b.token)).toBeNull();
  });

  test('purgeExpired removes sessions that ended over a day ago', async () => {
    const h = await withAdmin({ maxHours: 1 });
    await h.auth.login(ADMIN.username, ADMIN.password, client);
    h.clock.advance(2 * 3_600_000);
    expect(h.auth.purgeExpired()).toBe(0);
    h.clock.advance(24 * 3_600_000);
    expect(h.auth.purgeExpired()).toBe(2);
  });
});
