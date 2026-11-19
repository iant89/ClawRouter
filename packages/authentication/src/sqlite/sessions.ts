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

import type { Database } from '@clawrouter/database';
import type { Session, SessionRepository } from '../sessions.ts';

interface Row {
  id: string;
  token_hash: string;
  user_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

const toSession = (r: Row): Session => ({
  id: r.id,
  tokenHash: r.token_hash,
  userId: r.user_id,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  expiresAt: r.expires_at,
  ip: r.ip,
  userAgent: r.user_agent,
  revokedAt: r.revoked_at,
  revokedReason: r.revoked_reason,
});

export function createSqliteSessionRepository(db: Database): SessionRepository {
  return {
    insert(s) {
      db.run(
        `INSERT INTO sessions (id, token_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [s.id, s.tokenHash, s.userId, s.createdAt, s.lastSeenAt, s.expiresAt, s.ip, s.userAgent],
      );
    },
    findByTokenHash(tokenHash) {
      const row = db.get<Row>('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]);
      return row ? toSession(row) : undefined;
    },
    findById(id) {
      const row = db.get<Row>('SELECT * FROM sessions WHERE id = ?', [id]);
      return row ? toSession(row) : undefined;
    },
    touch(id, at) {
      db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [at, id]);
    },
    revoke(id, at, reason) {
      return db.run('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL', [at, reason, id]).changes > 0;
    },
    revokeAllForUser(userId, at, reason, exceptId) {
      return db.transaction((tx) => {
        const ids = tx
          .all<{ id: string }>('SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND id != ?', [userId, exceptId ?? ''])
          .map((r) => r.id);
        for (const id of ids) tx.run('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ?', [at, reason, id]);
        return ids;
      });
    },
    listActiveForUser(userId, now) {
      return db
        .all<Row>('SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC', [userId, now])
        .map(toSession);
    },
    listActive({ now, idleCutoff, userId, limit, offset }) {
      const where = ['revoked_at IS NULL', 'expires_at > ?', 'last_seen_at > ?'];
      const params: string[] = [now, idleCutoff];
      if (userId) {
        where.push('user_id = ?');
        params.push(userId);
      }
      const clause = where.join(' AND ');
      const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions WHERE ${clause}`, params)?.n ?? 0;
      const items = db
        .all<Row>(`SELECT * FROM sessions WHERE ${clause} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`, [...params, limit, offset])
        .map(toSession);
      return { items, total };
    },
    purge(cutoff) {
      return db.run('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', [cutoff, cutoff]).changes;
    },
  };
}
