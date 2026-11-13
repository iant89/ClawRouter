import { createAuditService, createSqliteAuditRepository } from '@clawrouter/audit';
import {
  createArgon2Hasher, createAuthService, createSqliteSessionRepository, createSqliteTwoFactorRepository, createSqliteUserRepository, createUserAdminService, type PasswordHasher,
} from '@clawrouter/authentication';
import { createAuthorizationService, createSqliteRoleRepository, userAccessPolicy } from '@clawrouter/authorization';
import type { Logger } from '@clawrouter/core';
import type { Database } from '@clawrouter/database';
import type { UserWithRoles } from '@clawrouter/shared';

/**
 * Lost-password recovery from the server's command line (never from the web).
 * Whoever can run this can already read the database, so it proves nothing new
 * about them; it only saves them from editing SQLite by hand.
 *
 * Sets a random temporary password (the user must change it at the next
 * sign-in), ends the user's sessions and, with `enable`, re-enables the account.
 * A running server sees the change at once: sessions are checked in the database
 * on every request, and open live connections close within half a minute.
 */
export async function recoverPassword(db: Database, username: string, options: { enable?: boolean; resetTwoFactor?: boolean; hasher?: PasswordHasher; log?: Logger } = {}): Promise<{ user: UserWithRoles; password: string }> {
  const users = createSqliteUserRepository(db);
  const audit = createAuditService(createSqliteAuditRepository(db), options.log);
  // Session lifetimes do not matter here: this only revokes sessions.
  const auth = createAuthService({ users, sessions: createSqliteSessionRepository(db), hasher: options.hasher ?? createArgon2Hasher(), audit, policy: { idleMinutes: 60, maxHours: 12 } });
  const authz = createAuthorizationService({ roles: createSqliteRoleRepository(db), audit });
  const admin = createUserAdminService({ users, hasher: options.hasher ?? createArgon2Hasher(), auth, audit, policy: userAccessPolicy(authz), log: options.log });
  const result = await admin.recover(username, { enable: options.enable });
  if (options.resetTwoFactor) {
    // Lost phone and password together: remove two-factor methods and recovery codes too.
    createSqliteTwoFactorRepository(db).deleteAll(result.user.id);
    audit.record({ action: 'TWO_FACTOR_RESET', result: 'SUCCESS', resource: 'user', resourceId: result.user.id, actor: { id: null, name: 'command line' }, ip: null, requestId: null, metadata: { username: result.user.username, via: 'cli' } });
    return { ...result, user: { ...result.user, twoFactor: [] } };
  }
  return result;
}
