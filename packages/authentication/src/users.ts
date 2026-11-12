import type { UserStatus, UserSummary } from '@clawapi/shared';

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
}

export interface NewUser {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  status: UserStatus;
  now: string;
}

export interface UserRepository {
  findById(id: string): User | undefined;
  /** Case-insensitive. */
  findByUsername(username: string): User | undefined;
  count(): number;
  insert(user: NewUser): User;
  recordLogin(id: string, at: string): void;
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
  };
}
