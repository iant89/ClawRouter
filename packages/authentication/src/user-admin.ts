import { AppError, errors, newId, type EventBus, type Logger } from '@clawrouter/core';
import type { AuditService } from '@clawrouter/audit';
import { USERNAME_PATTERN, type CreateUserRequest, type UpdateUserRequest, type UserWithRoles } from '@clawrouter/shared';
import type { AuthService, ClientInfo } from './auth-service.ts';
import { checkPasswordPolicy, type PasswordHasher } from './password.ts';
import type { UserRepository } from './users.ts';

/** Who is acting: a signed-in user (with their permissions) or the system (CLI). */
export interface UserAdminActor {
  id: string | null;
  username: string;
  /** Absent for the system: escalation checks do not apply. */
  permissions?: ReadonlySet<string>;
}

/**
 * The authorization rules user administration depends on. Implemented by the
 * authorization service; kept as an interface so authentication does not depend
 * on authorization.
 */
export interface UserAccessPolicy {
  /** Throws for unknown roles or roles beyond the actor's own permissions. */
  assertCanAssign(actor: UserAdminActor, roles: string[]): void;
  /** Throws when the target holds permissions the actor lacks. */
  assertCanManageUser(actor: UserAdminActor, userId: string, doing: string): void;
  assignRoles(actor: UserAdminActor, userId: string, roles: string[], client: ClientInfo): void;
  isLastActiveAdministrator(userId: string): boolean;
  getUser(userId: string): UserWithRoles | undefined;
}

export interface UserAdminOptions {
  users: UserRepository;
  hasher: PasswordHasher;
  auth: AuthService;
  audit: AuditService;
  policy: UserAccessPolicy;
  events?: EventBus;
  log?: Logger;
  now?: () => Date;
}

export type UserAdminService = ReturnType<typeof createUserAdminService>;

const USERNAME_RULE = 'must be 2–64 characters: letters, digits, dot, dash or underscore, starting with a letter or digit';

/** A readable temporary password (about 100 bits), for the recovery CLI. */
export function generateTemporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return chars.match(/.{5}/g)!.join('-');
}

/**
 * Console user administration (spec §16): create users with a temporary
 * password, change their name, enable and disable them, reset passwords, and
 * recover a lost administrator password from the server's command line.
 *
 * Rules:
 * - nobody can disable themselves, and the last active administrator cannot be disabled;
 * - an actor can only manage users whose permissions they hold themselves, and
 *   only give new users roles within their own permissions (no escalation);
 * - disabling a user or resetting their password ends all their sessions.
 */
export function createUserAdminService(options: UserAdminOptions) {
  const { users, hasher, auth, audit, policy, events, log } = options;
  const now = options.now ?? (() => new Date());

  const record = (actor: UserAdminActor, action: Parameters<AuditService['record']>[0]['action'], userId: string, client: ClientInfo, metadata: Record<string, unknown>) =>
    audit.record({
      action, result: 'SUCCESS', resource: 'user', resourceId: userId,
      actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null, metadata,
    });

  const describe = (userId: string): UserWithRoles => {
    const user = policy.getUser(userId);
    if (!user) throw errors.notFound('User not found.');
    return user;
  };

  const target = (userId: string) => {
    const user = users.findById(userId);
    if (!user) throw errors.notFound('User not found.');
    return user;
  };

  return {
    async create(actor: UserAdminActor, input: CreateUserRequest, client: ClientInfo): Promise<UserWithRoles> {
      const username = input.username.trim();
      const issues = [
        ...(USERNAME_PATTERN.test(username) ? [] : [{ path: 'username', message: USERNAME_RULE }]),
        ...(input.displayName.trim() ? [] : [{ path: 'displayName', message: 'is required' }]),
        ...checkPasswordPolicy(input.password, username),
      ];
      if (issues.length) throw errors.validation(issues);
      if (users.findByUsername(username)) throw errors.validation([{ path: 'username', message: 'is already taken' }]);
      policy.assertCanAssign(actor, input.roles);

      const passwordHash = await hasher.hash(input.password);
      const user = users.transaction((tx) => {
        if (tx.findByUsername(username)) throw errors.validation([{ path: 'username', message: 'is already taken' }]);
        return tx.insert({ id: newId(), username, displayName: input.displayName.trim(), passwordHash, status: 'ACTIVE', mustChangePassword: true, now: now().toISOString() });
      });
      record(actor, 'USER_CREATED', user.id, client, { username: user.username, roles: [...new Set(input.roles)].sort() });
      if (input.roles.length) policy.assignRoles(actor, user.id, input.roles, client);
      events?.emit('user.changed', { userId: user.id, action: 'created' });
      log?.info('user created', { component: 'users', userId: user.id });
      return describe(user.id);
    },

    /** Changes the display name and/or enables or disables the user. */
    update(actor: UserAdminActor, userId: string, patch: UpdateUserRequest, client: ClientInfo): UserWithRoles {
      const user = target(userId);
      const displayName = patch.displayName?.trim();
      if (patch.displayName !== undefined && !displayName) throw errors.validation([{ path: 'displayName', message: 'is required' }]);
      const status = patch.status && patch.status !== user.status ? patch.status : undefined;
      const renamed = displayName !== undefined && displayName !== user.displayName;
      if (!status && !renamed) return describe(userId);

      if (userId !== actor.id) policy.assertCanManageUser(actor, userId, 'change this user');
      if (status === 'DISABLED') {
        if (userId === actor.id) throw new AppError('CONFLICT', 'You cannot disable your own account.');
        if (policy.isLastActiveAdministrator(userId)) throw new AppError('CONFLICT', 'This is the only active administrator. Give another user the Administrator role first.');
      }

      users.update(userId, { displayName: renamed ? displayName : undefined, status }, now().toISOString());
      if (renamed) {
        record(actor, 'USER_UPDATED', userId, client, { username: user.username, displayName: { before: user.displayName, after: displayName } });
        events?.emit('user.changed', { userId, action: 'updated' });
      }
      if (status === 'DISABLED') {
        const ended = auth.revokeAllSessions(userId, 'USER_DISABLED');
        record(actor, 'USER_DISABLED', userId, client, { username: user.username, sessionsEnded: ended });
        events?.emit('user.changed', { userId, action: 'disabled' });
      } else if (status === 'ACTIVE') {
        record(actor, 'USER_ENABLED', userId, client, { username: user.username });
        events?.emit('user.changed', { userId, action: 'enabled' });
      }
      return describe(userId);
    },

    /**
     * Sets a temporary password chosen by an administrator. The user is signed
     * out everywhere and must choose a new password at the next sign-in.
     */
    async resetPassword(actor: UserAdminActor, userId: string, password: string, client: ClientInfo): Promise<UserWithRoles> {
      const user = target(userId);
      if (userId === actor.id) throw new AppError('CONFLICT', 'Use "Change password" to change your own password.');
      policy.assertCanManageUser(actor, userId, "reset this user's password");
      const issues = checkPasswordPolicy(password, user.username);
      if (issues.length) throw errors.validation(issues);
      users.setPassword(userId, await hasher.hash(password), true, now().toISOString());
      const ended = auth.revokeAllSessions(userId, 'PASSWORD_CHANGED');
      record(actor, 'PASSWORD_RESET', userId, client, { username: user.username, sessionsEnded: ended });
      events?.emit('user.changed', { userId, action: 'password_reset' });
      log?.info('user password reset', { component: 'users', userId });
      return describe(userId);
    },

    /**
     * Server-side recovery (the `reset-password` command): gives the user a new
     * random temporary password and, optionally, re-enables the account.
     * Returns the temporary password so the command can print it once; it is
     * never logged or stored in plain text.
     */
    async recover(username: string, opts: { enable?: boolean } = {}): Promise<{ user: UserWithRoles; password: string }> {
      const user = users.findByUsername(username);
      if (!user) throw errors.notFound(`No user called "${username}".`);
      const password = generateTemporaryPassword();
      const at = now().toISOString();
      users.setPassword(user.id, await hasher.hash(password), true, at);
      const ended = auth.revokeAllSessions(user.id, 'PASSWORD_CHANGED');
      const system: UserAdminActor = { id: null, username: 'command line' };
      const client: ClientInfo = { ip: null, userAgent: null };
      record(system, 'PASSWORD_RESET', user.id, client, { username: user.username, via: 'cli', sessionsEnded: ended });
      if (opts.enable && user.status !== 'ACTIVE') {
        users.update(user.id, { status: 'ACTIVE' }, at);
        record(system, 'USER_ENABLED', user.id, client, { username: user.username, via: 'cli' });
      }
      log?.warn('user password reset from the command line', { component: 'users', userId: user.id });
      return { user: describe(user.id), password };
    },
  };
}
