import { AppError, errors, newId, type EventBus, type Logger } from '@clawrouter/core';
import type { AuditService } from '@clawrouter/audit';
import { ADMIN_ROLE_ID, isPermission, PERMISSIONS, type CreateRoleRequest, type Permission, type RoleInfo, type UpdateRoleRequest, type UserWithRoles } from '@clawrouter/shared';
import type { RoleRepository } from './repository.ts';
import { permissionsOfRole } from './roles.ts';

export interface Principal {
  roles: string[];
  permissions: ReadonlySet<Permission>;
}

/** Who is acting. With `permissions`, the actor may only grant or assign what they hold (no escalation); without, it is the system. */
export interface Actor {
  permissions?: ReadonlySet<string>;
  /** null for the system (the command line). */
  id: string | null;
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

  /** Permissions of roles: built-in ones from code, custom ones from the database. */
  const permissionsOf = (roleIds: string[]): Map<string, Permission[]> => {
    const custom = repo.customPermissions(roleIds.filter((r) => !permissionsOfRole(r).length));
    return new Map(roleIds.map((r) => [r, permissionsOfRole(r).length ? [...permissionsOfRole(r)] : (custom.get(r) ?? []).filter(isPermission)]));
  };

  const principalFromRoles = (roleIds: string[]): Principal => ({
    roles: roleIds,
    permissions: new Set([...permissionsOf(roleIds).values()].flat()),
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
      const roles = repo.listRoles();
      const perms = permissionsOf(roles.map((r) => r.id));
      return roles.map((r) => ({ ...r, permissions: perms.get(r.id) ?? [], memberCount: counts.get(r.id) ?? 0 }));
    },

    listUsers(): UserWithRoles[] {
      return repo.listUsersWithRoles();
    },

    getUser(userId: string): UserWithRoles | undefined {
      return repo.findUserWithRoles(userId);
    },

    /** Refuses unknown roles and roles beyond the actor's own permissions (before a user is created with them). */
    assertCanAssign(actor: Actor, requested: string[]): void {
      const known = new Set(repo.listRoles().map((r) => r.id));
      const unknown = [...new Set(requested)].filter((r) => !known.has(r));
      if (unknown.length) throw errors.validation(unknown.map((r) => ({ path: 'roles', message: `unknown role "${r}"` })));
      assertWithin(actor, [...permissionsOf([...new Set(requested)]).values()].flat(), 'assign these roles');
    },

    /**
     * Refuses to let an actor disable, edit or reset the password of a user who
     * holds permissions the actor lacks (that would be a way to take over a more
     * powerful account, e.g. an administrator's).
     */
    assertCanManageUser(actor: Actor, userId: string, doing: string): void {
      assertWithin(actor, [...principalFromRoles(repo.rolesOf(userId)).permissions], doing);
    },

    /** True when the user is the only active holder of Administrator. */
    isLastActiveAdministrator(userId: string): boolean {
      return repo.rolesOf(userId).includes(ADMIN_ROLE_ID) && repo.countActiveHolders(ADMIN_ROLE_ID) <= 1;
    },

    /** Gives the user created by initial setup the ADMIN role. */
    grantInitialAdministrator(userId: string): void {
      repo.setUserRoles(userId, ['ADMIN'], now().toISOString(), null);
    },

    /**
     * Replaces a user's roles. Refuses unknown roles and any change that would
     * leave ClawRouter without an active administrator.
     */
    setUserRoles(actor: Actor, userId: string, requested: string[], client: ClientInfo): UserWithRoles {
      const roleIds = [...new Set(requested)].sort();
      const known = new Set(repo.listRoles().map((r) => r.id));
      const unknown = roleIds.filter((r) => !known.has(r));
      if (unknown.length) throw errors.validation(unknown.map((r) => ({ path: 'roles', message: `unknown role "${r}"` })));

      const { before, after } = repo.transaction((tx) => {
        const user = tx.findUserWithRoles(userId);
        if (!user) throw errors.notFound('User not found.');
        // No escalation: every role given or taken away must be within the actor's own permissions
        // (so only administrators can assign or remove Administrator).
        const changed = [...roleIds.filter((r) => !user.roles.includes(r)), ...user.roles.filter((r) => !roleIds.includes(r))];
        assertWithin(actor, [...permissionsOf(changed).values()].flat(), 'assign or remove these roles');
        const losesAdmin = user.roles.includes('ADMIN') && !roleIds.includes('ADMIN');
        if (losesAdmin && user.status === 'ACTIVE' && tx.countActiveHolders('ADMIN') <= 1) {
          throw new AppError('CONFLICT', 'ClawRouter must keep at least one active administrator. Assign ADMIN to someone else first.');
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

    /** Creates a custom role (owner rule: never one with every permission; only permissions the actor holds). */
    createRole(actor: Actor, input: CreateRoleRequest, client: ClientInfo): RoleInfo {
      const v = validateRole(input.name, input.description ?? '', input.permissions);
      if (repo.findRoleByName(v.name)) throw errors.validation([{ path: 'name', message: `a role called "${v.name}" already exists` }]);
      assertWithin(actor, v.permissions, 'create a role with these permissions');
      const id = `role_${newId().replace(/-/g, '').slice(0, 16)}`;
      repo.insertRole({ id, ...v, at: now().toISOString() });
      audit.record({
        action: 'ROLE_CREATED', result: 'SUCCESS', resource: 'role', resourceId: id,
        actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null,
        metadata: { name: v.name, permissions: v.permissions },
      });
      events?.emit('role.changed', { roleId: id, action: 'created' });
      return this.listRoles().find((r) => r.id === id)!;
    },

    /** Changes a custom role. Built-in roles (Administrator, Operator, Viewer) cannot be changed. */
    updateRole(actor: Actor, id: string, input: UpdateRoleRequest, client: ClientInfo): RoleInfo {
      const role = repo.findRole(id);
      if (!role) throw errors.notFound('Role not found.');
      if (role.builtIn) throw new AppError('CONFLICT', id === ADMIN_ROLE_ID ? 'The Administrator role cannot be changed.' : 'Built-in roles cannot be changed. Create a custom role instead.');
      const current = permissionsOf([id]).get(id) ?? [];
      const v = validateRole(input.name ?? role.name, input.description ?? role.description, input.permissions ?? current);
      const clash = repo.findRoleByName(v.name);
      if (clash && clash.id !== id) throw errors.validation([{ path: 'name', message: `a role called "${v.name}" already exists` }]);
      // Only roles entirely within the actor's own permissions can be touched, before and after.
      assertWithin(actor, [...current, ...v.permissions], 'change this role');
      repo.updateRole(id, { ...v, at: now().toISOString() });
      const added = v.permissions.filter((p) => !current.includes(p));
      const removed = current.filter((p) => !v.permissions.includes(p));
      audit.record({
        action: 'ROLE_UPDATED', result: 'SUCCESS', resource: 'role', resourceId: id,
        actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null,
        metadata: { name: v.name, ...(v.name !== role.name ? { renamedFrom: role.name } : {}), added, removed },
      });
      events?.emit('role.changed', { roleId: id, action: 'updated' });
      // Members' open consoles and live connections pick up the new permissions.
      if (added.length || removed.length) {
        for (const u of repo.listUsersWithRoles().filter((u) => u.roles.includes(id))) events?.emit('user.roles_changed', { userId: u.id, roles: u.roles });
      }
      return this.listRoles().find((r) => r.id === id)!;
    },

    /** Deletes a custom role that nobody holds. */
    deleteRole(actor: Actor, id: string, client: ClientInfo): void {
      const role = repo.findRole(id);
      if (!role) throw errors.notFound('Role not found.');
      if (role.builtIn) throw new AppError('CONFLICT', id === ADMIN_ROLE_ID ? 'The Administrator role cannot be removed.' : 'Built-in roles cannot be deleted.');
      const permissions = permissionsOf([id]).get(id) ?? [];
      assertWithin(actor, permissions, 'delete this role');
      const members = repo.memberCounts().get(id) ?? 0;
      if (members) throw new AppError('CONFLICT', `${members} user(s) still have this role. Give them another role first.`);
      repo.deleteRole(id);
      audit.record({
        action: 'ROLE_DELETED', result: 'SUCCESS', resource: 'role', resourceId: id,
        actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null,
        metadata: { name: role.name, permissions },
      });
      events?.emit('role.changed', { roleId: id, action: 'deleted' });
    },
  };
}

/**
 * The owner's rule: a custom role has 1–64 character name, known permissions,
 * at least one permission, and never every permission (that is Administrator alone).
 */
function validateRole(name: string, description: string, permissions: string[]) {
  const issues: { path: string; message: string }[] = [];
  const n = name.trim();
  if (!n || n.length > 64) issues.push({ path: 'name', message: 'must be 1–64 characters' });
  if (description.length > 300) issues.push({ path: 'description', message: 'must be at most 300 characters' });
  const unknown = permissions.filter((p) => !isPermission(p));
  if (unknown.length) issues.push({ path: 'permissions', message: `unknown permission: ${unknown.join(', ')}` });
  const unique = [...new Set(permissions.filter(isPermission))].sort() as Permission[];
  if (!unique.length) issues.push({ path: 'permissions', message: 'choose at least one permission' });
  if (unique.length === PERMISSIONS.length) issues.push({ path: 'permissions', message: 'only the Administrator role may have every permission' });
  if (issues.length) throw errors.validation(issues);
  return { name: n, description: description.trim(), permissions: unique };
}

/** Refuses to let an actor grant, assign or edit permissions they do not hold themselves. */
function assertWithin(actor: Actor, permissions: Permission[], doing: string) {
  if (!actor.permissions) return;
  const missing = [...new Set(permissions)].filter((p) => !actor.permissions!.has(p));
  if (missing.length) throw new AppError('AUTHORIZATION_ERROR', `You cannot ${doing}: it involves permissions you do not have yourself (${missing.join(', ')}).`, { expose: true });
}

/** The rules user administration relies on (see `UserAccessPolicy` in authentication). */
export function userAccessPolicy(authz: AuthorizationService) {
  return {
    assertCanAssign: (actor: Actor, roles: string[]) => authz.assertCanAssign(actor, roles),
    assertCanManageUser: (actor: Actor, userId: string, doing: string) => authz.assertCanManageUser(actor, userId, doing),
    assignRoles: (actor: Actor, userId: string, roles: string[], client: ClientInfo) => { authz.setUserRoles(actor, userId, roles, client); },
    isLastActiveAdministrator: (userId: string) => authz.isLastActiveAdministrator(userId),
    getUser: (userId: string) => authz.getUser(userId),
  };
}

/** Who holds what, for flows that must find the right people (e.g. API key requests). */
export function peopleDirectory(authz: AuthorizationService) {
  return {
    /** Active users holding `permission`, with their role ids. */
    holders: (permission: string) =>
      authz.listUsers()
        .filter((u) => u.status === 'ACTIVE' && authz.principalFor(u.id).permissions.has(permission as Permission))
        .map((u) => ({ id: u.id, roles: u.roles })),
    rolesOf: (userId: string) => authz.principalFor(userId).roles,
  };
}
