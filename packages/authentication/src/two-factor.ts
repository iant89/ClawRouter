import { AppError, errors, newId, type EventBus, type Logger, type SecretBox } from '@clawrouter/core';
import type { AuditService } from '@clawrouter/audit';
import type { Database, JsonValue, SettingsRepository } from '@clawrouter/database';
import {
  TWO_FACTOR_METHODS, TWO_FACTOR_REQUIREMENTS, type FieldIssue, type RecoveryCodes, type SignInChallenge, type SignInSecuritySettings, type TotpSetup,
  type TwoFactorMethod, type TwoFactorStatus, type UpdateSignInSecurityRequest, type UserSummary,
} from '@clawrouter/shared';
import type { ClientInfo } from './auth-service.ts';
import type { PasswordHasher } from './password.ts';
import { createSqliteTwoFactorRepository, type ChallengeRecord } from './sqlite/two-factor.ts';
import { generateToken, hashToken } from './tokens.ts';
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from './totp.ts';
import { toUserSummary, type User, type UserRepository } from './users.ts';

const POLICY_KEY = 'security.sign_in';
const DEFAULT_POLICY = { methods: { totp: true, email: false }, require: 'off' as const };
const CHALLENGE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 30;
const RECOVERY_CODES = 10;

/** The mail service, as far as two-factor sign-in needs it. */
export interface CodeMailer {
  configured(): boolean;
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

/** "a•••@example.com" */
export const maskEmail = (email: string) => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
};

const sixDigits = () => String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, '0');
const normalizeRecovery = (code: string) => code.toLowerCase().replace(/[^a-z2-7]/g, '');

export type TwoFactorService = ReturnType<typeof createTwoFactorService>;

/**
 * Two-factor sign-in (owner's request; administrators configure it in Settings):
 * authenticator apps (TOTP) and email codes, one-time recovery codes, the second
 * step of sign-in, and the policy (allowed methods, who must use it).
 *
 * Secrets: authenticator secrets are encrypted with the server's secret key;
 * emailed codes, recovery codes and challenge tokens are stored only as hashes.
 */
export function createTwoFactorService(options: {
  db: Database;
  users: UserRepository;
  hasher: PasswordHasher;
  secrets: SecretBox;
  settings: SettingsRepository;
  mail: CodeMailer;
  /** Whether the user holds the Administrator role (for "require: administrators"). */
  isAdministrator: (userId: string) => boolean;
  audit: AuditService;
  events?: EventBus;
  log?: Logger;
  now?: () => Date;
  issuer?: string;
}) {
  const { users, hasher, secrets, settings, mail, audit, events, log } = options;
  const repo = createSqliteTwoFactorRepository(options.db);
  const now = options.now ?? (() => new Date());
  const issuer = options.issuer ?? 'ClawRouter';
  const totpContext = (userId: string) => `user:${userId}:totp`;

  const record = (user: { id: string; username: string }, action: Parameters<AuditService['record']>[0]['action'], client: ClientInfo, metadata: Record<string, unknown>, actor = user, result: 'SUCCESS' | 'FAILURE' = 'SUCCESS') =>
    audit.record({ action, result, resource: 'user', resourceId: user.id, actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null, metadata });

  // --- policy --------------------------------------------------------------
  const policy = (): SignInSecuritySettings => {
    const s = settings.get(POLICY_KEY);
    const v = (s?.value ?? {}) as Partial<SignInSecuritySettings>;
    return {
      methods: { ...DEFAULT_POLICY.methods, ...(v.methods ?? {}) },
      require: TWO_FACTOR_REQUIREMENTS.includes(v.require as never) ? v.require! : DEFAULT_POLICY.require,
      updatedAt: s?.updatedAt ?? null,
    };
  };
  const allowed = () => TWO_FACTOR_METHODS.filter((m) => policy().methods[m] && (m !== 'email' || mail.configured()));

  const enrolled = (userId: string): TwoFactorMethod[] => {
    const r = repo.get(userId);
    const set: TwoFactorMethod[] = [];
    if (r?.totpConfirmedAt) set.push('totp');
    if (r?.emailEnabledAt && users.findById(userId)?.email) set.push('email');
    return set.filter((m) => allowed().includes(m));
  };

  const requiredFor = (userId: string): boolean => {
    const p = policy();
    return p.require === 'everyone' || (p.require === 'administrators' && options.isAdministrator(userId));
  };

  const mustUser = (userId: string): User => {
    const u = users.findById(userId);
    if (!u) throw errors.notFound('User not found.');
    return u;
  };

  const checkPassword = async (user: User, password: string) => {
    if (!(await hasher.verify(password, user.passwordHash))) throw errors.validation([{ path: 'password', message: 'is not correct' }]);
  };

  async function newRecoveryCodes(user: User, client: ClientInfo): Promise<RecoveryCodes> {
    const codes = Array.from({ length: RECOVERY_CODES }, () => {
      const raw = base32Encode(crypto.getRandomValues(new Uint8Array(5))).toLowerCase(); // 40 bits
      return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
    });
    repo.replaceRecoveryCodes(user.id, codes.map((c) => hashToken(`${user.id}:${normalizeRecovery(c)}`)), now().toISOString());
    record(user, 'RECOVERY_CODES_GENERATED', client, { count: codes.length });
    return { codes };
  }

  async function sendCode(challenge: ChallengeRecord, user: User, subject: string, intro: string): Promise<void> {
    if (!user.email) throw new AppError('CONFLICT', 'There is no email address on this account.');
    if (challenge.codeSentAt && now().getTime() - Date.parse(challenge.codeSentAt) < RESEND_SECONDS * 1000) {
      throw new AppError('RATE_LIMITED', `Wait ${RESEND_SECONDS} seconds before asking for another code.`, { expose: true, headers: { 'Retry-After': String(RESEND_SECONDS) } });
    }
    const code = sixDigits();
    repo.setCode(challenge.id, hashToken(`${challenge.id}:${code}`), now().toISOString());
    await mail.send({
      to: user.email,
      subject: `${subject}: ${code}`,
      text: `${intro}\n\nYour code: ${code}\n\nIt works for ${CHALLENGE_MINUTES} minutes. If you did not ask for it, someone may know your password: change it.\n\n${issuer}`,
    });
  }

  /** Checks a challenge's emailed code; counts attempts and burns the challenge after too many. */
  const checkEmailCode = (c: ChallengeRecord, code: string): boolean => {
    if (!c.codeHash) return false;
    const ok = hashToken(`${c.id}:${code.replace(/\s/g, '')}`) === c.codeHash;
    return ok;
  };

  const liveChallenge = (token: string, purpose: ChallengeRecord['purpose']): ChallengeRecord => {
    const c = token && token.length <= 128 ? repo.findChallenge(hashToken(token)) : undefined;
    if (!c || c.purpose !== purpose || c.usedAt || Date.parse(c.expiresAt) <= now().getTime() || c.attempts >= MAX_ATTEMPTS) {
      throw new AppError('AUTHENTICATION_ERROR', 'This sign-in has expired. Enter your password again.', { expose: true, details: { reason: 'challenge_expired' } });
    }
    return c;
  };

  return {
    policy,

    updatePolicy(actor: { id: string; username: string }, body: UpdateSignInSecurityRequest, client: ClientInfo): SignInSecuritySettings {
      const current = policy();
      const issues: FieldIssue[] = [];
      const methods = { ...current.methods };
      if (body.methods !== undefined) {
        for (const [k, v] of Object.entries(body.methods)) {
          if (!(TWO_FACTOR_METHODS as readonly string[]).includes(k) || typeof v !== 'boolean') issues.push({ path: `methods.${k}`, message: 'must be a known method set to true or false' });
          else methods[k as TwoFactorMethod] = v;
        }
      }
      const require = body.require ?? current.require;
      if (!TWO_FACTOR_REQUIREMENTS.includes(require)) issues.push({ path: 'require', message: `must be one of ${TWO_FACTOR_REQUIREMENTS.join(', ')}` });
      if (require !== 'off' && !methods.totp && !methods.email) issues.push({ path: 'require', message: 'needs at least one allowed method' });
      if (require !== 'off' && !methods.totp && methods.email && !mail.configured()) issues.push({ path: 'require', message: 'email codes need a configured mail server; allow the authenticator app or set up mail first' });
      if (issues.length) throw errors.validation(issues);
      settings.set(POLICY_KEY, { methods, require } as unknown as JsonValue);
      const changes: Record<string, unknown> = {};
      if (JSON.stringify(methods) !== JSON.stringify(current.methods)) changes.methods = { before: current.methods, after: methods };
      if (require !== current.require) changes.require = { before: current.require, after: require };
      if (Object.keys(changes).length) {
        audit.record({ action: 'SETTINGS_CHANGED', result: 'SUCCESS', resource: 'settings', actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null, metadata: { signIn: changes } });
        events?.emit('settings.changed', { key: POLICY_KEY });
      }
      return policy();
    },

    requiredFor,
    enrolled,
    /** Must set up two-factor sign-in before doing anything else. */
    setupRequired: (userId: string) => requiredFor(userId) && enrolled(userId).length === 0,

    status(userId: string): TwoFactorStatus {
      const user = mustUser(userId);
      return {
        allowed: allowed(), required: requiredFor(userId), enrolled: enrolled(userId), email: user.email,
        mailConfigured: mail.configured(), recoveryCodesLeft: repo.recoveryCodesLeft(userId),
      };
    },

    // --- enrollment: authenticator app --------------------------------------
    async startTotp(userId: string): Promise<TotpSetup> {
      if (!allowed().includes('totp')) throw new AppError('CONFLICT', 'Authenticator apps are not allowed. An administrator can allow them in Settings.');
      const user = mustUser(userId);
      if (repo.get(userId)?.totpConfirmedAt) throw new AppError('CONFLICT', 'An authenticator app is already set up. Remove it first to set up a new one.');
      const secret = generateTotpSecret();
      repo.setTotpPending(userId, await secrets.encrypt(secret, totpContext(userId)), secrets.fingerprint, now().toISOString());
      return { secret, uri: otpauthUri(issuer, user.email ?? user.username, secret) };
    },

    /** Confirms the app with a first code. Returns new recovery codes when the user had none. */
    async confirmTotp(userId: string, code: string, client: ClientInfo): Promise<RecoveryCodes> {
      const user = mustUser(userId);
      const r = repo.get(userId);
      if (!r?.totpCiphertext || r.totpConfirmedAt) throw new AppError('CONFLICT', 'Start setting up an authenticator app first.');
      const secret = await secrets.decrypt(r.totpCiphertext, totpContext(userId));
      const step = verifyTotp(secret, code, now().getTime(), null);
      if (step === null) throw errors.validation([{ path: 'code', message: 'is not the current code from the app; check the time on your phone' }]);
      repo.confirmTotp(userId, step, now().toISOString());
      record(user, 'TWO_FACTOR_ENABLED', client, { method: 'totp' });
      return repo.recoveryCodesLeft(userId) ? { codes: [] } : newRecoveryCodes(user, client);
    },

    // --- enrollment: email codes ---------------------------------------------
    async startEmail(userId: string, client: ClientInfo): Promise<{ sentTo: string }> {
      if (!allowed().includes('email')) throw new AppError('CONFLICT', 'Email codes are not allowed or no mail server is configured. An administrator can change this in Settings.');
      const user = mustUser(userId);
      if (!user.email) throw new AppError('CONFLICT', 'Add an email address to your account first.');
      const id = newId();
      const at = now();
      repo.insertChallenge({ id, tokenHash: hashToken(generateToken()), userId, purpose: 'ENROLL_EMAIL', ip: client.ip, userAgent: client.userAgent, at: at.toISOString(), expiresAt: new Date(at.getTime() + CHALLENGE_MINUTES * 60_000).toISOString() });
      await sendCode(repo.latestEnrollment(userId)!, user, 'Confirm email sign-in codes', `Someone (hopefully you) is turning on email sign-in codes for ${user.username}.`);
      return { sentTo: maskEmail(user.email) };
    },

    async confirmEmail(userId: string, code: string, client: ClientInfo): Promise<RecoveryCodes> {
      const user = mustUser(userId);
      const c = repo.latestEnrollment(userId);
      if (!c || Date.parse(c.expiresAt) <= now().getTime() || c.attempts >= MAX_ATTEMPTS) throw new AppError('CONFLICT', 'Ask for a new code first.');
      repo.addAttempt(c.id);
      if (!checkEmailCode(c, code)) throw errors.validation([{ path: 'code', message: 'is not the code we sent' }]);
      repo.markUsed(c.id, now().toISOString());
      repo.setEmailEnabled(userId, now().toISOString(), now().toISOString());
      record(user, 'TWO_FACTOR_ENABLED', client, { method: 'email' });
      return repo.recoveryCodesLeft(userId) ? { codes: [] } : newRecoveryCodes(user, client);
    },

    /** Turns a method off (needs the password). Refused if it is the last one and two-factor is required. */
    async disable(userId: string, method: TwoFactorMethod, password: string, client: ClientInfo): Promise<TwoFactorStatus> {
      const user = mustUser(userId);
      await checkPassword(user, password);
      const remaining = enrolled(userId).filter((m) => m !== method);
      if (requiredFor(userId) && !remaining.length) throw new AppError('CONFLICT', 'Two-factor sign-in is required for your account: set up another method before removing this one.');
      if (method === 'totp') repo.clearTotp(userId, now().toISOString());
      else repo.setEmailEnabled(userId, null, now().toISOString());
      record(user, 'TWO_FACTOR_DISABLED', client, { method });
      return this.status(userId);
    },

    async regenerateRecoveryCodes(userId: string, password: string, client: ClientInfo): Promise<RecoveryCodes> {
      const user = mustUser(userId);
      await checkPassword(user, password);
      if (!enrolled(userId).length) throw new AppError('CONFLICT', 'Set up two-factor sign-in first.');
      return newRecoveryCodes(user, client);
    },

    /** The user's own email address (needs the password). A new address turns email codes off until confirmed again. */
    async changeEmail(userId: string, email: string | null, password: string, client: ClientInfo): Promise<UserSummary> {
      const user = mustUser(userId);
      await checkPassword(user, password);
      const next = email?.trim() || null;
      if (next && (!/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(next) || next.length > 254)) throw errors.validation([{ path: 'email', message: 'must be an email address' }]);
      if (next && users.findByEmail(next) && users.findByEmail(next)!.id !== userId) throw errors.validation([{ path: 'email', message: 'is used by another account' }]);
      if (next === user.email) return toUserSummary(user);
      if (!next && requiredFor(userId) && enrolled(userId).length === 1 && enrolled(userId)[0] === 'email') {
        throw new AppError('CONFLICT', 'Email codes are your only two-factor method: set up an authenticator app before removing your email address.');
      }
      const at = now().toISOString();
      users.update(userId, { email: next }, at);
      if (repo.get(userId)?.emailEnabledAt) repo.setEmailEnabled(userId, null, at);
      record(user, 'EMAIL_CHANGED', client, { hadEmail: user.email !== null, hasEmail: next !== null });
      events?.emit('user.changed', { userId, action: 'updated' });
      return toUserSummary(mustUser(userId));
    },

    // --- sign-in -------------------------------------------------------------
    /** After a correct password: whether a second step is needed. */
    needsSecondStep: (userId: string) => enrolled(userId).length > 0,

    beginSignIn(user: User, client: ClientInfo): SignInChallenge['twoFactor'] {
      const token = generateToken();
      const at = now();
      repo.insertChallenge({ id: newId(), tokenHash: hashToken(token), userId: user.id, purpose: 'SIGN_IN', ip: client.ip, userAgent: client.userAgent?.slice(0, 512) ?? null, at: at.toISOString(), expiresAt: new Date(at.getTime() + CHALLENGE_MINUTES * 60_000).toISOString() });
      const methods = enrolled(user.id);
      return { challenge: token, methods, emailHint: methods.includes('email') && user.email ? maskEmail(user.email) : null };
    },

    async sendSignInCode(token: string): Promise<{ sentTo: string }> {
      const c = liveChallenge(token, 'SIGN_IN');
      const user = mustUser(c.userId);
      if (!enrolled(user.id).includes('email')) throw new AppError('CONFLICT', 'Email codes are not set up for this account.');
      await sendCode(c, user, 'Your sign-in code', `Someone (hopefully you) entered the right password for ${user.username}.`);
      return { sentTo: maskEmail(user.email!) };
    },

    /**
     * The second step. Returns the user on success; the challenge is then used up.
     * After 5 wrong codes the challenge is burned and the password is needed again.
     */
    async completeSignIn(token: string, method: TwoFactorMethod | 'recovery', code: string, client: ClientInfo): Promise<{ user: User; method: string }> {
      const c = liveChallenge(token, 'SIGN_IN');
      const user = mustUser(c.userId);
      repo.addAttempt(c.id);
      let ok = false;
      if (method === 'totp' && enrolled(user.id).includes('totp')) {
        const r = repo.get(user.id)!;
        const step = verifyTotp(await secrets.decrypt(r.totpCiphertext!, totpContext(user.id)), code, now().getTime(), r.totpLastStep);
        ok = step !== null && repo.useTotpStep(user.id, step);
      } else if (method === 'email' && enrolled(user.id).includes('email')) {
        ok = checkEmailCode(c, code);
      } else if (method === 'recovery') {
        ok = repo.useRecoveryCode(user.id, hashToken(`${user.id}:${normalizeRecovery(code)}`), now().toISOString());
      }
      if (!ok || !repo.markUsed(c.id, now().toISOString())) {
        const left = MAX_ATTEMPTS - c.attempts - 1;
        record(user, 'LOGIN_FAILED', client, { reason: 'second_factor', method, attemptsLeft: Math.max(0, left) }, user, 'FAILURE');
        throw new AppError('AUTHENTICATION_ERROR', left > 0 ? 'That code is not right.' : 'Too many wrong codes. Enter your password again.', {
          expose: true, details: { reason: left > 0 ? 'wrong_code' : 'challenge_expired', attemptsLeft: Math.max(0, left) },
        });
      }
      if (method === 'recovery') log?.warn('sign-in with a recovery code', { component: 'auth', userId: user.id, left: repo.recoveryCodesLeft(user.id) });
      return { user, method };
    },

    // --- administration --------------------------------------------------------
    /** Removes a user's two-factor methods and recovery codes (lost phone). They set it up again at next sign-in if required. */
    reset(actor: { id: string | null; username: string }, userId: string, client: ClientInfo): void {
      const user = mustUser(userId);
      repo.deleteAll(userId);
      record(user, 'TWO_FACTOR_RESET', client, { username: user.username }, { id: actor.id ?? '', username: actor.username });
      events?.emit('user.changed', { userId, action: 'updated' });
    },

    /** An administrator changed the user's address: email codes must be confirmed again at the new one. */
    emailChanged(userId: string): void {
      if (repo.get(userId)?.emailEnabledAt) repo.setEmailEnabled(userId, null, now().toISOString());
    },

    purgeExpired: () => repo.purge(new Date(now().getTime() - 24 * 3_600_000).toISOString()),
  };
}
