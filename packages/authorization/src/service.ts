import { AppError, errors, type EventBus, type Logger } from '@clawapi/core';
import type { AuditService } from '@clawapi/audit';
import type { Permission, RoleInfo, UserWithRoles } from '@clawapi/shared';
import type { RoleRepository } from './repository.ts';
import { permissionsOfRole } from './roles.ts';

export interface Principal {
  roles: string[];
  permissions: ReadonlySet<Permission>;
}

export interface Actor {
  id: string;
  username: string;
}

export interface ClientInfo {
  ip: string | null;
  requestId?: string | null;
}

export type AuthorizationService = ReturnType<typeof createAuthorizationService>;

/**
 * Permission service (spec §16). Roles are read from the database on every
 * request, so a role change takes effect on the user's next request without
 * signing them out.
 */
export function createAuthorizationService(options: {
  roles: RoleRepository;
  audit: AuditService;
  events?: EventBus;
  log?: Logger;
  now?: () => Date;
}) {
  const { roles: repo, audit, events, log } = options;
  const now = options.now ?? (() => new Date());

  const principalFromRoles = (roleIds: string[]): Principal => ({
    roles: roleIds,
    permissions: new Set(roleIds.flatMap((r) => permissionsOfRole(r))),
  });

  return {
    principalFor(userId: string): Principal {
      return principalFromRoles(repo.rolesOf(userId));
    },

    can(principal: Principal, permission: Permission): boolean {
      return principal.permissions.has(permission);
    },

    /** Throws AUTHORIZATION_ERROR unless the principal holds `permission`. */
    require(principal: Principal, permission: Permission): void {
      if (!principal.permissions.has(permission)) throw new AppError('AUTHORIZATION_ERROR');
    },

    listRoles(): RoleInfo[] {
      const counts = repo.memberCounts();
      return repo.listRoles().map((r) => ({ ...r, permissions: [...permissionsOfRole(r.id)], memberCount: counts.get(r.id) ?? 0 }));
    },

    listUsers(): UserWithRoles[] {
      return repo.listUsersWithRoles();
    },

    /** Gives the user created by initial setup the ADMIN role. */
    grantInitialAdministrator(userId: string): void {
      repo.setUserRoles(userId, ['ADMIN'], now().toISOString(), null);
    },

    /**
     * Replaces a user's roles. Refuses unknown roles and any change that would
     * leave ClawAPI without an active administrator.
     */
    setUserRoles(actor: Actor, userId: string, requested: string[], client: ClientInfo): UserWithRoles {
      const roleIds = [...new Set(requested)].sort();
      const known = new Set(repo.listRoles().map((r) => r.id));
      const unknown = roleIds.filter((r) => !known.has(r));
      if (unknown.length) throw errors.validation(unknown.map((r) => ({ path: 'roles', message: `unknown role "${r}"` })));

      const { before, after } = repo.transaction((tx) => {
        const user = tx.findUserWithRoles(userId);
        if (!user) throw errors.notFound('User not found.');
        const losesAdmin = user.roles.includes('ADMIN') && !roleIds.includes('ADMIN');
        if (losesAdmin && user.status === 'ACTIVE' && tx.countActiveHolders('ADMIN') <= 1) {
          throw new AppError('CONFLICT', 'ClawAPI must keep at least one active administrator. Assign ADMIN to someone else first.');
        }
        tx.setUserRoles(userId, roleIds, now().toISOString(), actor.id);
        return { before: user.roles, after: tx.findUserWithRoles(userId)! };
      });

      if (before.join() !== after.roles.join()) {
        audit.record({
          action: 'ROLE_CHANGED', result: 'SUCCESS', resource: 'user', resourceId: userId,
          actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null,
          metadata: { username: after.username, before, after: after.roles },
        });
        events?.emit('user.roles_changed', { userId, roles: after.roles });
        log?.info('user roles changed', { component: 'authorization', userId, before, after: after.roles });
      }
      return after;
    },
  };
}
