/**
 * Authorization vocabulary (spec §16). The server is the authority: the console
 * uses these only to decide what to show.
 */
export const PERMISSIONS = [
  'providers.read', 'providers.write',
  'models.read', 'models.write',
  'routing.read', 'routing.write',
  'requests.read',
  'usage.read',
  'api_keys.read', 'api_keys.write',
  'rate_limits.read', 'rate_limits.write',
  'health.read',
  'logs.read',
  'audit.read',
  'users.read', 'users.write',
  'roles.read', 'roles.write', 'roles.assign',
  'sessions.read', 'sessions.revoke',
  'settings.read', 'settings.write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  'providers.read': 'View providers and their status',
  'providers.write': 'Create, change, enable, disable and test providers; manage provider credentials',
  'models.read': 'View the model registry',
  'models.write': 'Create, change, enable and disable models',
  'routing.read': 'View routing rules and aliases',
  'routing.write': 'Change routing rules and aliases',
  'requests.read': 'View gateway request history',
  'usage.read': 'View token usage and cost',
  'api_keys.read': 'View API keys (never their secret values)',
  'api_keys.write': 'Create and revoke API keys and change their limits',
  'rate_limits.read': 'View rate limits and current usage against them',
  'rate_limits.write': 'Change rate limits',
  'health.read': 'View detailed platform health',
  'logs.read': 'View server logs',
  'audit.read': 'View the audit log',
  'users.read': 'View console users and their roles',
  'users.write': 'Create, change, enable and disable console users',
  'roles.read': 'View roles and their permissions',
  'roles.write': 'Create, change and delete custom roles (only with permissions you hold yourself)',
  'roles.assign': 'Assign roles to users (only roles whose permissions you hold yourself)',
  'sessions.read': "View every user's sessions",
  'sessions.revoke': "Sign out any user's sessions",
  'settings.read': 'View system settings',
  'settings.write': 'Change system settings',
};

export const BUILT_IN_ROLE_IDS = ['ADMIN', 'OPERATOR', 'VIEWER'] as const;
export type BuiltInRoleId = (typeof BUILT_IN_ROLE_IDS)[number];

export interface RoleInfo {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  permissions: Permission[];
  /** Number of users holding the role. */
  memberCount: number;
}

/** A console user as listed for administrators. */
export interface UserWithRoles {
  id: string;
  username: string;
  displayName: string;
  status: 'ACTIVE' | 'DISABLED';
  createdAt: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  roles: string[];
}

/** PUT /api/users/:id/roles */
export interface SetUserRolesRequest {
  roles: string[];
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/** The role that holds every permission. Unique and fixed: it cannot be edited, deleted or matched by another role. */
export const ADMIN_ROLE_ID = 'ADMIN';

/** Permissions grouped by area, for the role editor (every permission appears once). */
export const PERMISSION_GROUPS: { area: string; permissions: Permission[] }[] = [
  { area: 'Gateway', permissions: ['requests.read', 'usage.read', 'api_keys.read', 'api_keys.write', 'rate_limits.read', 'rate_limits.write'] },
  { area: 'AI infrastructure', permissions: ['providers.read', 'providers.write', 'models.read', 'models.write', 'routing.read', 'routing.write'] },
  { area: 'System', permissions: ['health.read', 'logs.read', 'audit.read'] },
  { area: 'Administration', permissions: ['users.read', 'users.write', 'roles.read', 'roles.write', 'roles.assign', 'sessions.read', 'sessions.revoke', 'settings.read', 'settings.write'] },
];

/** POST /api/roles */
export interface CreateRoleRequest {
  name: string;
  description?: string;
  permissions: Permission[];
}

/** PATCH /api/roles/:id (custom roles only) */
export interface UpdateRoleRequest {
  name?: string;
  description?: string;
  permissions?: Permission[];
}
