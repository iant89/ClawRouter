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

export interface SessionRepository {
  insert(session: Session): void;
  findByTokenHash(tokenHash: string): Session | undefined;
  findById(id: string): Session | undefined;
  touch(id: string, at: string): void;
  revoke(id: string, at: string, reason: string): boolean;
  revokeAllForUser(userId: string, at: string, reason: string, exceptId?: string): string[];
  /** Active (not revoked, not past absolute expiry) sessions of a user, newest first. */
  listActiveForUser(userId: string, now: string): Session[];
  /** Deletes sessions that expired or were revoked before `cutoff`. Returns the number removed. */
  purge(cutoff: string): number;
}
