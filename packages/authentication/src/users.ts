import type { UserStatus, UserSummary } from '@clawrouter/shared';

export interface User {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
  passwordChangedAt: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
}

export interface NewUser {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  status: UserStatus;
  now: string;
  /** New accounts made by an administrator start with a temporary password. */
  mustChangePassword?: boolean;
}

export interface UserRepository {
  findById(id: string): User | undefined;
  /** Case-insensitive. */
  findByUsername(username: string): User | undefined;
  count(): number;
  insert(user: NewUser): User;
  recordLogin(id: string, at: string): void;
  update(id: string, patch: { displayName?: string; status?: UserStatus }, at: string): void;
  /** Replaces the password hash and stamps password_changed_at. */
  setPassword(id: string, passwordHash: string, mustChange: boolean, at: string): void;
  list(): User[];
  /** Runs `fn` atomically (used to make initial setup race-free). */
  transaction<T>(fn: (repo: UserRepository) => T): T;
}

/** The only shape of a user that leaves the server. */
export function toUserSummary(user: User): UserSummary {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    status: user.status,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    mustChangePassword: user.mustChangePassword,
  };
}
