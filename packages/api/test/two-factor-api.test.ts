import { describe, expect, test } from 'bun:test';
import { base32Decode, hotp, totpStep } from '@clawrouter/authentication';
import type { ApiErrorBody, ApiSuccess, AuthSession, MailServerSettings, RecoveryCodes, SignInChallenge, SignInSecuritySettings, TotpSetup, TwoFactorStatus, UserWithRoles } from '@clawrouter/shared';
import { recoverPassword } from '../../../apps/server/src/recover.ts';
import { ADMIN, cookieFrom, createHarness, type Harness } from '../../../tests/support/harness.ts';

const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;
const errorOf = async (res: Response) => ((await res.json()) as ApiErrorBody).error;
const PASSWORD = ADMIN.password;
const codeFor = (h: Harness, secret: string, offsetSteps = 0) => hotp(base32Decode(secret), totpStep(h.clock.time) + offsetSteps);

/** Starts and confirms an authenticator app for the signed-in user; returns the secret and recovery codes. */
async function enrollTotp(h: Harness, cookie: string) {
  const setup = await data<TotpSetup>(await h.request('/api/auth/2fa/totp', { method: 'POST', cookie, json: {} }));
  const codes = await data<RecoveryCodes>(await h.request('/api/auth/2fa/totp/confirm', { method: 'POST', cookie, json: { code: codeFor(h, setup.secret) } }));
  return { secret: setup.secret, codes: codes.codes };
}

const login = (h: Harness, username = 'admin', password = PASSWORD) => h.request('/api/auth/login', { method: 'POST', json: { username, password } });
const verify = (h: Harness, challenge: string, method: string, code: string) => h.request('/api/auth/login/verify', { method: 'POST', json: { challenge, method, code } });

async function configureMail(h: Harness, admin: string) {
  return h.request('/api/settings/mail', { method: 'PUT', cookie: admin, json: { enabled: true, host: 'smtp.example.test', port: 587, security: 'starttls', username: 'mailer', password: 'smtp-password-canary', from: 'ClawRouter <clawrouter@example.test>' } });
}

describe('administrator settings', () => {
  test('defaults; the policy needs a usable method; mail password is write-only and encrypted', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    expect(await data<SignInSecuritySettings>(await h.request('/api/settings/sign-in', { cookie: admin }))).toMatchObject({ methods: { totp: true, email: false }, require: 'off' });
    const emailOnly = await h.request('/api/settings/sign-in', { method: 'PUT', cookie: admin, json: { methods: { totp: false, email: true }, require: 'everyone' } });
    expect(emailOnly.status).toBe(400);
    expect((await h.request('/api/settings/sign-in', { method: 'PUT', cookie: admin, json: { methods: { totp: false, email: false }, require: 'administrators' } })).status).toBe(400);

    const saved = await data<MailServerSettings>(await configureMail(h, admin));
    expect(saved).toMatchObject({ enabled: true, host: 'smtp.example.test', passwordSet: true, configured: true });
    expect(JSON.stringify(saved)).not.toContain('smtp-password-canary');
    expect(JSON.stringify(h.db.all('SELECT * FROM settings')) + JSON.stringify(h.db.all('SELECT * FROM audit_log'))).not.toContain('smtp-password-canary');
    expect(h.audit.list({ action: 'SETTINGS_CHANGED' }).find((r) => r.metadata?.mailServer)!.metadata).toMatchObject({ signInDetailsChanged: true });
    // Enabling without a host is refused; null removes the password.
    expect((await h.request('/api/settings/mail', { method: 'PUT', cookie: admin, json: { host: '' } })).status).toBe(400);
    expect((await data<MailServerSettings>(await h.request('/api/settings/mail', { method: 'PUT', cookie: admin, json: { password: null } }))).passwordSet).toBe(false);
    // Operators cannot change sign-in security.
    await h.addUser('olly', ['OPERATOR']);
    expect((await h.request('/api/settings/sign-in', { method: 'PUT', cookie: await h.login('olly'), json: { require: 'off' } })).status).toBe(403);
  });

  test('test message goes to the administrator\'s own address', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await configureMail(h, admin);
    expect(await data<{ sent: boolean }>(await h.request('/api/settings/mail/test', { method: 'POST', cookie: admin, json: {} }))).toMatchObject({ sent: false });
    await h.request('/api/auth/email', { method: 'PUT', cookie: admin, json: { email: 'ada@example.test', password: PASSWORD } });
    expect(await data<{ sent: boolean }>(await h.request('/api/settings/mail/test', { method: 'POST', cookie: admin, json: {} }))).toMatchObject({ sent: true, to: 'ada@example.test' });
    expect(h.outbox.at(-1)).toMatchObject({ to: 'ada@example.test', subject: 'ClawRouter test message' });
  });
});

describe('authenticator app', () => {
  test('enroll, then sign in with a code; replays and wrong codes are refused', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const setup = await data<TotpSetup>(await h.request('/api/auth/2fa/totp', { method: 'POST', cookie: admin, json: {} }));
    expect(setup.uri).toStartWith('otpauth://totp/ClawRouter:admin?secret=');
    expect((await h.request('/api/auth/2fa/totp/confirm', { method: 'POST', cookie: admin, json: { code: '000000' } })).status).toBe(400);
    const confirmed = await data<RecoveryCodes>(await h.request('/api/auth/2fa/totp/confirm', { method: 'POST', cookie: admin, json: { code: codeFor(h, setup.secret) } }));
    expect(confirmed.codes).toHaveLength(10);
    expect(confirmed.codes[0]).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}$/);
    expect(await data<TwoFactorStatus>(await h.request('/api/auth/2fa', { cookie: admin }))).toMatchObject({ enrolled: ['totp'], recoveryCodesLeft: 10 });
    // The secret is encrypted at rest.
    expect(JSON.stringify(h.db.all('SELECT * FROM user_two_factor'))).not.toContain(setup.secret);

    const first = await login(h);
    expect(first.headers.getSetCookie().join()).not.toContain('clawrouter_session=');
    const { twoFactor } = await data<SignInChallenge>(first);
    expect(twoFactor.methods).toEqual(['totp']);
    const wrong = await verify(h, twoFactor.challenge, 'totp', '123456');
    expect(wrong.status).toBe(401);
    expect((await errorOf(wrong)).details).toMatchObject({ reason: 'wrong_code', attemptsLeft: 4 });
    // The previous step's code was used to confirm enrollment: move on a step.
    h.clock.advance(30_000);
    const ok = await verify(h, twoFactor.challenge, 'totp', codeFor(h, setup.secret));
    expect(ok.status).toBe(200);
    const session = await data<AuthSession>(ok);
    expect(session.user.username).toBe('admin');
    expect((await h.request('/api/auth/session', { cookie: cookieFrom(ok) })).status).toBe(200);
    // The challenge is used up, and the same code cannot be used again with a new one.
    expect((await verify(h, twoFactor.challenge, 'totp', codeFor(h, setup.secret))).status).toBe(401);
    const again = (await data<SignInChallenge>(await login(h))).twoFactor;
    expect((await verify(h, again.challenge, 'totp', codeFor(h, setup.secret))).status).toBe(401);
    expect(h.audit.list({ action: 'LOGIN' }).at(0)!.metadata).toMatchObject({ secondFactor: 'totp' });
  });

  test('five wrong codes burn the challenge; recovery codes work once', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const { codes } = await enrollTotp(h, admin);
    const { twoFactor } = await data<SignInChallenge>(await login(h));
    for (let i = 0; i < 5; i++) await verify(h, twoFactor.challenge, 'totp', '111111');
    const burned = await verify(h, twoFactor.challenge, 'recovery', codes[0]!);
    expect(burned.status).toBe(401);
    expect((await errorOf(burned)).details).toMatchObject({ reason: 'challenge_expired' });

    const next = (await data<SignInChallenge>(await login(h))).twoFactor;
    expect((await verify(h, next.challenge, 'recovery', codes[0]!.toUpperCase().replace('-', ' '))).status).toBe(200);
    const after = (await data<SignInChallenge>(await login(h))).twoFactor;
    expect((await verify(h, after.challenge, 'recovery', codes[0]!)).status).toBe(401);
    expect(JSON.stringify(h.db.all('SELECT * FROM recovery_codes')) + JSON.stringify(h.db.all('SELECT * FROM audit_log'))).not.toContain(codes[1]!);
  });

  test('turning it off needs the password; challenges expire after 10 minutes', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await enrollTotp(h, admin);
    expect((await h.request('/api/auth/2fa/disable', { method: 'POST', cookie: admin, json: { method: 'totp', password: 'wrong' } })).status).toBe(400);
    const { twoFactor } = await data<SignInChallenge>(await login(h));
    h.clock.advance(11 * 60_000);
    expect((await verify(h, twoFactor.challenge, 'totp', '000000')).status).toBe(401);
    // New recovery codes replace the old ones (password needed).
    const fresh = await data<RecoveryCodes>(await h.request('/api/auth/2fa/recovery-codes', { method: 'POST', cookie: admin, json: { password: PASSWORD } }));
    expect(fresh.codes).toHaveLength(10);
    // The session from before enrollment is still valid: turn the app off from it.
    expect((await data<TwoFactorStatus>(await h.request('/api/auth/2fa/disable', { method: 'POST', cookie: admin, json: { method: 'totp', password: PASSWORD } }))).enrolled).toEqual([]);
    expect((await login(h)).headers.getSetCookie().join()).toContain('clawrouter_session=');
  });
});

describe('email codes', () => {
  test('enroll and sign in with a code sent by email', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await configureMail(h, admin);
    await h.request('/api/settings/sign-in', { method: 'PUT', cookie: admin, json: { methods: { totp: true, email: true } } });
    expect((await h.request('/api/auth/2fa/email', { method: 'POST', cookie: admin, json: {} })).status).toBe(409); // no address yet
    await h.request('/api/auth/email', { method: 'PUT', cookie: admin, json: { email: 'ada@example.test', password: PASSWORD } });
    expect(await data<{ sentTo: string }>(await h.request('/api/auth/2fa/email', { method: 'POST', cookie: admin, json: {} }))).toEqual({ sentTo: 'a•••@example.test' });
    const code = /Your code: (\d{6})/.exec(h.outbox.at(-1)!.text)![1]!;
    expect((await h.request('/api/auth/2fa/email/confirm', { method: 'POST', cookie: admin, json: { code: '000000' } })).status).toBe(400);
    expect((await data<RecoveryCodes>(await h.request('/api/auth/2fa/email/confirm', { method: 'POST', cookie: admin, json: { code } }))).codes).toHaveLength(10);

    const { twoFactor } = await data<SignInChallenge>(await login(h));
    expect(twoFactor).toMatchObject({ methods: ['email'], emailHint: 'a•••@example.test' });
    await h.request('/api/auth/login/email-code', { method: 'POST', json: { challenge: twoFactor.challenge } });
    const signInCode = /Your code: (\d{6})/.exec(h.outbox.at(-1)!.text)![1]!;
    // Resending is limited to once per 30 seconds.
    expect((await h.request('/api/auth/login/email-code', { method: 'POST', json: { challenge: twoFactor.challenge } })).status).toBe(429);
    expect((await verify(h, twoFactor.challenge, 'email', signInCode)).status).toBe(200);
    // Codes are only stored hashed.
    expect(JSON.stringify(h.db.all('SELECT * FROM sign_in_challenges')) + JSON.stringify(h.db.all('SELECT * FROM audit_log'))).not.toContain(signInCode);
  });

  test('a new address turns email codes off until confirmed again', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await configureMail(h, admin);
    await h.request('/api/settings/sign-in', { method: 'PUT', cookie: admin, json: { methods: { totp: true, email: true } } });
    await h.request('/api/auth/email', { method: 'PUT', cookie: admin, json: { email: 'ada@example.test', password: PASSWORD } });
    await h.request('/api/auth/2fa/email', { method: 'POST', cookie: admin, json: {} });
    await h.request('/api/auth/2fa/email/confirm', { method: 'POST', cookie: admin, json: { code: /Your code: (\d{6})/.exec(h.outbox.at(-1)!.text)![1]! } });
    await h.request('/api/auth/email', { method: 'PUT', cookie: admin, json: { email: 'ada@other.test', password: PASSWORD } });
    expect((await data<TwoFactorStatus>(await h.request('/api/auth/2fa', { cookie: admin }))).enrolled).toEqual([]);
    // Your own address changes only with your password, never through user administration.
    const me = await data<{ user: { id: string } }>(await h.request('/api/auth/session', { cookie: admin }));
    const self = await h.request(`/api/users/${me.user.id}`, { method: 'PATCH', cookie: admin, json: { email: 'stolen@example.test' } });
    expect(self.status).toBe(409);
    expect((await data<TwoFactorStatus>(await h.request('/api/auth/2fa', { cookie: admin }))).email).toBe('ada@other.test');
  });
});

describe('required two-factor sign-in', () => {
  test('a user who must have it can only set it up; then the console opens', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await h.request('/api/settings/sign-in', { method: 'PUT', cookie: admin, json: { require: 'everyone' } });
    await h.addUser('val', ['VIEWER']);
    const val = await h.login('val');
    expect((await data<AuthSession>(await h.request('/api/auth/session', { cookie: val }))).twoFactorSetupRequired).toBe(true);
    const blocked = await h.request('/api/providers', { cookie: val });
    expect(blocked.status).toBe(403);
    expect((await errorOf(blocked)).details).toMatchObject({ reason: 'two_factor_setup_required' });
    await enrollTotp(h, val);
    expect((await data<AuthSession>(await h.request('/api/auth/session', { cookie: val }))).twoFactorSetupRequired).toBe(false);
    expect((await h.request('/api/providers', { cookie: val })).status).toBe(200);
    // The last method cannot be removed while it is required.
    expect((await h.request('/api/auth/2fa/disable', { method: 'POST', cookie: val, json: { method: 'totp', password: PASSWORD } })).status).toBe(409);
  });

  test('"administrators" applies to the Administrator role only', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await h.request('/api/settings/sign-in', { method: 'PUT', cookie: admin, json: { require: 'administrators' } });
    await h.addUser('val', ['VIEWER']);
    expect((await data<AuthSession>(await h.request('/api/auth/session', { cookie: await h.login('val') }))).twoFactorSetupRequired).toBe(false);
    expect((await data<AuthSession>(await h.request('/api/auth/session', { cookie: admin }))).twoFactorSetupRequired).toBe(true);
  });
});

describe('lost phone', () => {
  test('an administrator resets a user\'s two-factor sign-in; others cannot reset more powerful users', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const { id } = await h.addUser('val', ['VIEWER']);
    await enrollTotp(h, await h.login('val'));
    expect((await login(h, 'val')).headers.getSetCookie().join()).not.toContain('clawrouter_session=');
    const reset = await data<UserWithRoles>(await h.request(`/api/users/${id}/two-factor/reset`, { method: 'POST', cookie: admin, json: {} }));
    expect(reset.twoFactor).toEqual([]);
    expect((await login(h, 'val')).headers.getSetCookie().join()).toContain('clawrouter_session=');
    expect(h.audit.list({ action: 'TWO_FACTOR_RESET' })).toHaveLength(1);

    const role = await data<{ id: string }>(await h.request('/api/roles', { method: 'POST', cookie: admin, json: { name: 'Helpdesk', permissions: ['users.read', 'users.write'] } }));
    await h.addUser('hd', [role.id]);
    const adminId = h.users.findByUsername('admin')!.id;
    expect((await h.request(`/api/users/${adminId}/two-factor/reset`, { method: 'POST', cookie: await h.login('hd'), json: {} })).status).toBe(403);
  });

  test('the command line can reset two-factor sign-in with the password', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    await enrollTotp(h, admin);
    const { user, password } = await recoverPassword(h.db, 'admin', { resetTwoFactor: true, hasher: (await import('@clawrouter/authentication')).createArgon2Hasher({ memoryCost: 1024, timeCost: 1 }) });
    expect(user.twoFactor).toEqual([]);
    expect((await login(h, 'admin', password)).headers.getSetCookie().join()).toContain('clawrouter_session=');
  });
});
