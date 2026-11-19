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

export interface Session {
  id: string;
  tokenHash: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  /** Absolute expiry. */
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface ActiveSessionQuery {
  /** Current time (ISO). Sessions past their absolute expiry are excluded. */
  now: string;
  /** Sessions last seen before this time (ISO) are idle-expired and excluded. */
  idleCutoff: string;
  userId?: string;
  limit: number;
  offset: number;
}

export interface SessionRepository {
  insert(session: Session): void;
  findByTokenHash(tokenHash: string): Session | undefined;
  findById(id: string): Session | undefined;
  touch(id: string, at: string): void;
  revoke(id: string, at: string, reason: string): boolean;
  revokeAllForUser(userId: string, at: string, reason: string, exceptId?: string): string[];
  /** Active (not revoked, not past absolute expiry) sessions of a user, newest first. */
  listActiveForUser(userId: string, now: string): Session[];
  /** Live sessions across all users, newest first, with the total for pagination. */
  listActive(query: ActiveSessionQuery): { items: Session[]; total: number };
  /** Deletes sessions that expired or were revoked before `cutoff`. Returns the number removed. */
  purge(cutoff: string): number;
}
