import { AppError, errors, newId, type Logger } from '@clawapi/core';
import type { AuditService } from '@clawapi/audit';
import { USERNAME_PATTERN } from '@clawapi/shared';
import type { AuthService, ClientInfo, LoginResult } from './auth-service.ts';
import { checkPasswordPolicy, type PasswordHasher } from './password.ts';
import { FailureThrottle } from './throttle.ts';
import { safeEqual } from './tokens.ts';
import type { UserRepository } from './users.ts';

export interface SetupInput {
  setupToken: string;
  username: string;
  displayName: string;
  password: string;
}

export interface SetupServiceOptions {
  users: UserRepository;
  hasher: PasswordHasher;
  auth: AuthService;
  audit: AuditService;
  /**
   * The one-time setup token. Proves the caller has access to the server
   * (its log/file system), so a freshly started instance cannot be claimed by
   * whoever reaches it first.
   */
  setupToken: string;
  log?: Logger;
  now?: () => Date;
  onCompleted?: () => void;
}

export type SetupService = ReturnType<typeof createSetupService>;

/**
 * Initial setup (spec §15): creates the first administrator when no user
 * exists, then disables itself permanently.
 */
export function createSetupService(options: SetupServiceOptions) {
  const { users, hasher, auth, audit, log } = options;
  const now = options.now ?? (() => new Date());
  const throttle = new FailureThrottle({ limit: 10, windowMs: 15 * 60_000, blockMs: 15 * 60_000, now: () => now().getTime() });

  return {
    isRequired(): boolean {
      return users.count() === 0;
    },

    async complete(input: SetupInput, client: ClientInfo): Promise<LoginResult> {
      if (users.count() > 0) throw new AppError('CONFLICT', 'Initial setup has already been completed.');

      const ipKey = `ip:${client.ip ?? 'unknown'}`;
      const retry = throttle.retryAfter(ipKey);
      if (retry > 0) throw new AppError('RATE_LIMITED', undefined, { headers: { 'Retry-After': String(Math.ceil(retry / 1000)) } });
      if (!safeEqual(input.setupToken, options.setupToken)) {
        throttle.fail(ipKey);
        log?.warn('setup attempted with an invalid setup token', { component: 'setup', ip: client.ip });
        throw new AppError('AUTHENTICATION_ERROR', 'The setup token is not valid.');
      }

      const issues = checkPasswordPolicy(input.password, input.username);
      if (!USERNAME_PATTERN.test(input.username)) {
        issues.unshift({ path: 'username', message: 'must be 2–64 characters: letters, digits, dot, dash or underscore, starting with a letter or digit' });
      }
      if (issues.length) throw errors.validation(issues);

      const passwordHash = await hasher.hash(input.password);
      const at = now().toISOString();
      // Re-check inside the transaction: two concurrent setups cannot both succeed.
      const user = users.transaction((tx) => {
        if (tx.count() > 0) throw new AppError('CONFLICT', 'Initial setup has already been completed.');
        return tx.insert({ id: newId(), username: input.username, displayName: input.displayName, passwordHash, status: 'ACTIVE', now: at });
      });

      const actor = { id: user.id, name: user.username };
      const base = { ip: client.ip, requestId: client.requestId ?? null, actor };
      audit.record({ ...base, action: 'USER_CREATED', result: 'SUCCESS', resource: 'user', resourceId: user.id, metadata: { via: 'setup' } });
      audit.record({ ...base, action: 'SETUP_COMPLETED', result: 'SUCCESS', resource: 'system' });
      log?.info('initial setup completed', { component: 'setup', userId: user.id });
      options.onCompleted?.();

      const result = auth.startSession(user, client);
      audit.record({ ...base, action: 'LOGIN', result: 'SUCCESS', resource: 'user', resourceId: user.id, metadata: { sessionId: result.session.id, via: 'setup' } });
      return result;
    },
  };
}
