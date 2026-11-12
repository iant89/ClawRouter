import { PERMISSIONS, type BuiltInRoleId, type Permission } from '@clawapi/shared';

/**
 * Permissions of the built-in roles (spec §16). Defined in code, not data, so a
 * permission added in a later phase reaches ADMIN automatically and the
 * built-ins cannot drift between installations.
 */
export const BUILT_IN_ROLE_PERMISSIONS: Record<BuiltInRoleId, readonly Permission[]> = {
  /** Full access. */
  ADMIN: PERMISSIONS,
  /** Providers, models, routing, health, logs, audit, requests, usage. */
  OPERATOR: [
    'providers.read', 'providers.write',
    'models.read', 'models.write',
    'routing.read', 'routing.write',
    'health.read',
    'logs.read',
    'audit.read',
    'requests.read',
    'usage.read',
  ],
  /**
   * Read-only view of gateway configuration and activity. Deliberately excludes
   * logs and audit (they can reveal security-relevant detail) and everything
   * under Administration.
   */
  VIEWER: ['providers.read', 'models.read', 'routing.read', 'requests.read', 'usage.read', 'health.read'],
};

export function permissionsOfRole(roleId: string): readonly Permission[] {
  return (BUILT_IN_ROLE_PERMISSIONS as Record<string, readonly Permission[] | undefined>)[roleId] ?? [];
}
