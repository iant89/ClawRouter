import type { Database } from '@clawrouter/database';
import type { UserWithRoles } from '@clawrouter/shared';

export interface RoleRecord {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
}

export interface RoleRepository {
  listRoles(): RoleRecord[];
  memberCounts(): Map<string, number>;
  rolesOf(userId: string): string[];
  /** Replaces a user's roles atomically. */
  setUserRoles(userId: string, roleIds: string[], at: string, assignedBy: string | null): void;
  /** Number of ACTIVE users holding `roleId`. */
  countActiveHolders(roleId: string): number;
  listUsersWithRoles(): UserWithRoles[];
  findUserWithRoles(userId: string): UserWithRoles | undefined;
  /** Stored permissions of custom roles (built-in roles keep theirs in code). */
  customPermissions(roleIds: string[]): Map<string, string[]>;
  findRole(id: string): RoleRecord | undefined;
  /** Case-insensitive. */
  findRoleByName(name: string): RoleRecord | undefined;
  insertRole(role: { id: string; name: string; description: string; permissions: string[]; at: string }): void;
  updateRole(id: string, patch: { name: string; description: string; permissions: string[]; at: string }): void;
  deleteRole(id: string): void;
  transaction<T>(fn: (repo: RoleRepository) => T): T;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  status: UserWithRoles['status'];
  created_at: string;
  last_login_at: string | null;
  must_change_password: number;
  email: string | null;
  two_factor: string | null;
  roles: string | null;
}

const USERS_WITH_ROLES = `
  SELECT u.id, u.username, u.display_name, u.status, u.created_at, u.last_login_at, u.must_change_password, u.email,
         (SELECT trim((CASE WHEN t.totp_confirmed_at IS NOT NULL THEN 'totp ' ELSE '' END) || (CASE WHEN t.email_enabled_at IS NOT NULL THEN 'email' ELSE '' END)) FROM user_two_factor t WHERE t.user_id = u.id) AS two_factor,
         (SELECT group_concat(role_id, ',') FROM (SELECT role_id FROM user_roles WHERE user_id = u.id ORDER BY role_id)) AS roles
  FROM users u`;

const toUser = (r: UserRow): UserWithRoles => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  status: r.status,
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at,
  mustChangePassword: r.must_change_password === 1,
  email: r.email,
  twoFactor: (r.two_factor ? r.two_factor.split(' ').filter(Boolean) : []) as ('totp' | 'email')[],
  roles: r.roles ? r.roles.split(',') : [],
});

export function createSqliteRoleRepository(db: Database): RoleRepository {
  const repo = (d: Database): RoleRepository => ({
    listRoles() {
      return d
        .all<{ id: string; name: string; description: string; built_in: number }>('SELECT id, name, description, built_in FROM roles ORDER BY built_in DESC, rowid')
        .map((r) => ({ id: r.id, name: r.name, description: r.description, builtIn: r.built_in === 1 }));
    },
    memberCounts() {
      return new Map(d.all<{ role_id: string; n: number }>('SELECT role_id, COUNT(*) AS n FROM user_roles GROUP BY role_id').map((r) => [r.role_id, r.n]));
    },
    rolesOf(userId) {
      return d.all<{ role_id: string }>('SELECT role_id FROM user_roles WHERE user_id = ? ORDER BY role_id', [userId]).map((r) => r.role_id);
    },
    setUserRoles(userId, roleIds, at, assignedBy) {
      d.transaction((tx) => {
        tx.run('DELETE FROM user_roles WHERE user_id = ?', [userId]);
        for (const roleId of roleIds) {
          tx.run('INSERT INTO user_roles (user_id, role_id, assigned_at, assigned_by) VALUES (?, ?, ?, ?)', [userId, roleId, at, assignedBy]);
        }
      });
    },
    countActiveHolders(roleId) {
      return d.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role_id = ? AND u.status = 'ACTIVE'",
        [roleId],
      )?.n ?? 0;
    },
    listUsersWithRoles() {
      return d.all<UserRow>(`${USERS_WITH_ROLES} ORDER BY u.username COLLATE NOCASE`).map(toUser);
    },
    findUserWithRoles(userId) {
      const row = d.get<UserRow>(`${USERS_WITH_ROLES} WHERE u.id = ?`, [userId]);
      return row ? toUser(row) : undefined;
    },
    customPermissions(roleIds) {
      const out = new Map<string, string[]>();
      if (!roleIds.length) return out;
      const rows = d.all<{ role_id: string; permission: string }>(
        `SELECT role_id, permission FROM role_permissions WHERE role_id IN (${roleIds.map(() => '?').join(', ')}) ORDER BY permission`,
        roleIds,
      );
      for (const r of rows) out.set(r.role_id, [...(out.get(r.role_id) ?? []), r.permission]);
      return out;
    },
    findRole(id) {
      const r = d.get<{ id: string; name: string; description: string; built_in: number }>('SELECT id, name, description, built_in FROM roles WHERE id = ?', [id]);
      return r ? { id: r.id, name: r.name, description: r.description, builtIn: r.built_in === 1 } : undefined;
    },
    findRoleByName(name) {
      const r = d.get<{ id: string; name: string; description: string; built_in: number }>('SELECT id, name, description, built_in FROM roles WHERE name = ? COLLATE NOCASE', [name]);
      return r ? { id: r.id, name: r.name, description: r.description, builtIn: r.built_in === 1 } : undefined;
    },
    insertRole(role) {
      d.transaction((tx) => {
        tx.run('INSERT INTO roles (id, name, description, built_in, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)', [role.id, role.name, role.description, role.at, role.at]);
        for (const p of role.permissions) tx.run('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)', [role.id, p]);
      });
    },
    updateRole(id, patch) {
      d.transaction((tx) => {
        tx.run('UPDATE roles SET name = ?, description = ?, updated_at = ? WHERE id = ? AND built_in = 0', [patch.name, patch.description, patch.at, id]);
        tx.run('DELETE FROM role_permissions WHERE role_id = ?', [id]);
        for (const p of patch.permissions) tx.run('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)', [id, p]);
      });
    },
    deleteRole(id) {
      d.run('DELETE FROM roles WHERE id = ? AND built_in = 0', [id]);
    },
    transaction: (fn) => d.transaction((tx) => fn(repo(tx))),
  });
  return repo(db);
}
