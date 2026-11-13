import type { Migration } from '../migrations.ts';

/**
 * Custom roles and user management (phase 14).
 *
 * `role_permissions` holds the permissions of custom roles only: built-in roles
 * (ADMIN, OPERATOR, VIEWER) keep theirs in code, so new permissions reach them
 * without a data migration and they cannot be edited.
 * `users.must_change_password` is set when an administrator gives a user a
 * temporary password; the user must choose a new one at their next sign-in.
 */
export const m0013CustomRolesUsers: Migration = {
  id: '0013_custom_roles_users',
  up: `
CREATE TABLE role_permissions (
  role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
) STRICT;

ALTER TABLE roles ADD COLUMN updated_at TEXT;

ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1));
`,
};
