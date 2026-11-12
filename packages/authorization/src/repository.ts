import type { Database } from '@clawapi/database';
import type { UserWithRoles } from '@clawapi/shared';

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
  transaction<T>(fn: (repo: RoleRepository) => T): T;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  status: UserWithRoles['status'];
  created_at: string;
  last_login_at: string | null;
  roles: string | null;
}

const USERS_WITH_ROLES = `
  SELECT u.id, u.username, u.display_name, u.status, u.created_at, u.last_login_at,
         (SELECT group_concat(role_id, ',') FROM (SELECT role_id FROM user_roles WHERE user_id = u.id ORDER BY role_id)) AS roles
  FROM users u`;

const toUser = (r: UserRow): UserWithRoles => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  status: r.status,
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at,
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
    transaction: (fn) => d.transaction((tx) => fn(repo(tx))),
  });
  return repo(db);
}
