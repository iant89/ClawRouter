/*
 * ClawRouter - Self-hosted AI gateway and control platform
 * https://github.com/iant89/ClawRouter
 *
 * Copyright (C) 2026 Ian Thomas
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * in the LICENSE file for more details.
 */

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
  email: string | null;
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
  email?: string | null;
}

export interface UserRepository {
  findById(id: string): User | undefined;
  /** Case-insensitive. */
  findByUsername(username: string): User | undefined;
  count(): number;
  insert(user: NewUser): User;
  recordLogin(id: string, at: string): void;
  /** `email: null` removes the address; absent leaves it. */
  update(id: string, patch: { displayName?: string; status?: UserStatus; email?: string | null }, at: string): void;
  findByEmail(email: string): User | undefined;
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
    email: user.email,
  };
}
