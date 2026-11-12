import type { Database } from '@clawapi/database';
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
    purge(cutoff) {
      return db.run('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', [cutoff, cutoff]).changes;
    },
  };
}
