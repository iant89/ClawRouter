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
