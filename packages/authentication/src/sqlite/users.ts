import type { Database } from '@clawapi/database';
import type { NewUser, User, UserRepository } from '../users.ts';

interface Row {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  status: User['status'];
  created_at: string;
  updated_at: string;
  password_changed_at: string;
  last_login_at: string | null;
}

const toUser = (r: Row): User => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  passwordHash: r.password_hash,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  passwordChangedAt: r.password_changed_at,
  lastLoginAt: r.last_login_at,
});

export function createSqliteUserRepository(db: Database): UserRepository {
  const repo = (d: Database): UserRepository => ({
    findById(id) {
      const row = d.get<Row>('SELECT * FROM users WHERE id = ?', [id]);
      return row ? toUser(row) : undefined;
    },
    findByUsername(username) {
      const row = d.get<Row>('SELECT * FROM users WHERE username = ?', [username]);
      return row ? toUser(row) : undefined;
    },
    count() {
      return d.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
    },
    insert(u: NewUser) {
      d.run(
        `INSERT INTO users (id, username, display_name, password_hash, status, created_at, updated_at, password_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [u.id, u.username, u.displayName, u.passwordHash, u.status, u.now, u.now, u.now],
      );
      return toUser(d.get<Row>('SELECT * FROM users WHERE id = ?', [u.id])!);
    },
    recordLogin(id, at) {
      d.run('UPDATE users SET last_login_at = ? WHERE id = ?', [at, id]);
    },
    transaction: (fn) => d.transaction((tx) => fn(repo(tx))),
  });
  return repo(db);
}
