import { AppError, newId, type EventBus, type Logger, type SessionRevokeReason } from '@clawapi/core';
import type { AuditService } from '@clawapi/audit';
import type { AdminSessionInfo, SessionInfo, UserSummary } from '@clawapi/shared';
import type { PasswordHasher } from './password.ts';
import type { Session, SessionRepository } from './sessions.ts';
import { FailureThrottle } from './throttle.ts';
import { generateToken, hashToken } from './tokens.ts';
import { toUserSummary, type User, type UserRepository } from './users.ts';

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
  requestId?: string | null;
}

export interface SessionPolicy {
  idleMinutes: number;
  maxHours: number;
}

export interface AuthenticatedSession {
  user: UserSummary;
  session: SessionInfo;
}

export interface LoginResult extends AuthenticatedSession {
  /** Raw session token for the cookie. Never log or return it in a body. */
  token: string;
}

export interface AuthServiceOptions {
  users: UserRepository;
  sessions: SessionRepository;
  hasher: PasswordHasher;
  audit: AuditService;
  policy: SessionPolicy;
  events?: EventBus;
  log?: Logger;
  now?: () => Date;
  /** Override throttles (tests). */
  usernameThrottle?: FailureThrottle;
  ipThrottle?: FailureThrottle;
}

/** Writes to `last_seen_at` at most this often per session. */
const TOUCH_INTERVAL_MS = 60_000;
const INVALID_CREDENTIALS = 'Invalid username or password.';

export type AuthService = ReturnType<typeof createAuthService>;

/**
 * Console authentication: password login, server-side sessions with idle and
 * absolute expiry, revocation, and login throttling. Independent of HTTP:
 * cookies are the API layer's concern.
 */
export function createAuthService(options: AuthServiceOptions) {
  const { users, sessions, hasher, audit, policy, events, log } = options;
  const now = options.now ?? (() => new Date());
  const idleMs = policy.idleMinutes * 60_000;
  const maxMs = policy.maxHours * 3_600_000;
  const usernameThrottle = options.usernameThrottle ?? new FailureThrottle({ limit: 10, windowMs: 15 * 60_000, blockMs: 15 * 60_000, now: () => now().getTime() });
  const ipThrottle = options.ipThrottle ?? new FailureThrottle({ limit: 50, windowMs: 15 * 60_000, blockMs: 15 * 60_000, now: () => now().getTime() });

  // Verifying against a real hash when the user does not exist keeps response times
  // similar, so timing does not reveal which usernames exist.
  let dummyHash: Promise<string> | undefined;
  const dummy = () => (dummyHash ??= hasher.hash(generateToken()));

  const idleExpiry = (s: Session) => new Date(Math.min(Date.parse(s.lastSeenAt) + idleMs, Date.parse(s.expiresAt))).toISOString();

  const toInfo = (s: Session, currentId?: string): SessionInfo => ({
    id: s.id,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    idleExpiresAt: idleExpiry(s),
    expiresAt: s.expiresAt,
    ip: s.ip,
    userAgent: s.userAgent,
    current: s.id === currentId,
  });

  const isLive = (s: Session, at: number) =>
    s.revokedAt === null && Date.parse(s.expiresAt) > at && Date.parse(s.lastSeenAt) + idleMs > at;

  function createSession(user: User, client: ClientInfo): LoginResult {
    const at = now();
    const token = generateToken();
    const session: Session = {
      id: newId(),
      tokenHash: hashToken(token),
      userId: user.id,
      createdAt: at.toISOString(),
      lastSeenAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + maxMs).toISOString(),
      ip: client.ip,
      userAgent: client.userAgent?.slice(0, 512) ?? null,
      revokedAt: null,
      revokedReason: null,
    };
    sessions.insert(session);
    return { token, user: toUserSummary(user), session: toInfo(session, session.id) };
  }

  function throttled(retryMs: number): AppError {
    const seconds = Math.ceil(retryMs / 1000);
    return new AppError('RATE_LIMITED', 'Too many failed sign-in attempts. Try again later.', { headers: { 'Retry-After': String(seconds) } });
  }

  return {
    async login(username: string, password: string, client: ClientInfo): Promise<LoginResult> {
      const userKey = `u:${username.toLowerCase()}`;
      const ipKey = `ip:${client.ip ?? 'unknown'}`;
      const auditBase = { ip: client.ip, requestId: client.requestId ?? null, resource: 'user' };

      const retry = Math.max(usernameThrottle.retryAfter(userKey), ipThrottle.retryAfter(ipKey));
      if (retry > 0) {
        audit.record({ ...auditBase, action: 'LOGIN_FAILED', result: 'FAILURE', metadata: { username, reason: 'throttled' } });
        throw throttled(retry);
      }

      const user = users.findByUsername(username);
      const valid = await hasher.verify(password, user?.passwordHash ?? (await dummy()));

      if (!user || !valid) {
        if (usernameThrottle.fail(userKey)) {
          events?.emit('auth.login_throttled', { username, ip: client.ip, scope: 'username', retryAfterSeconds: Math.ceil(usernameThrottle.retryAfter(userKey) / 1000) });
        }
        if (ipThrottle.fail(ipKey)) {
          events?.emit('auth.login_throttled', { username, ip: client.ip, scope: 'ip', retryAfterSeconds: Math.ceil(ipThrottle.retryAfter(ipKey) / 1000) });
        }
        audit.record({ ...auditBase, action: 'LOGIN_FAILED', result: 'FAILURE', resourceId: user?.id, metadata: { username, reason: 'invalid_credentials' } });
        log?.info('sign-in failed', { component: 'auth', reason: 'invalid_credentials', ip: client.ip });
        throw new AppError('AUTHENTICATION_ERROR', INVALID_CREDENTIALS);
      }
      if (user.status !== 'ACTIVE') {
        audit.record({ ...auditBase, action: 'LOGIN_FAILED', result: 'FAILURE', resourceId: user.id, actor: { id: user.id, name: user.username }, metadata: { reason: 'user_disabled' } });
        throw new AppError('AUTHENTICATION_ERROR', 'This account is disabled.');
      }

      usernameThrottle.reset(userKey);
      const result = createSession(user, client);
      users.recordLogin(user.id, result.session.createdAt);
      result.user.lastLoginAt = result.session.createdAt;
      audit.record({ ...auditBase, action: 'LOGIN', result: 'SUCCESS', resourceId: user.id, actor: { id: user.id, name: user.username }, metadata: { sessionId: result.session.id } });
      events?.emit('user.signed_in', { userId: user.id });
      return result;
    },

    /** Creates a session for an already-verified user (initial setup). */
    startSession(user: User, client: ClientInfo): LoginResult {
      const result = createSession(user, client);
      users.recordLogin(user.id, result.session.createdAt);
      result.user.lastLoginAt = result.session.createdAt;
      return result;
    },

    /**
     * Resolves a session token. Returns null for unknown, revoked, expired
     * (idle or absolute) sessions and for disabled users. Slides the idle window.
     */
    resolve(token: string): (AuthenticatedSession & { sessionId: string }) | null {
      if (!token || token.length > 128) return null;
      const session = sessions.findByTokenHash(hashToken(token));
      const at = now();
      if (!session || !isLive(session, at.getTime())) return null;
      const user = users.findById(session.userId);
      if (!user || user.status !== 'ACTIVE') return null;
      if (at.getTime() - Date.parse(session.lastSeenAt) >= TOUCH_INTERVAL_MS) {
        session.lastSeenAt = at.toISOString();
        sessions.touch(session.id, session.lastSeenAt);
      }
      return { user: toUserSummary(user), session: toInfo(session, session.id), sessionId: session.id };
    },

    logout(token: string, client: ClientInfo): void {
      const session = token ? sessions.findByTokenHash(hashToken(token)) : undefined;
      if (!session || session.revokedAt) return;
      sessions.revoke(session.id, now().toISOString(), 'LOGOUT');
      const user = users.findById(session.userId);
      audit.record({
        action: 'LOGOUT', result: 'SUCCESS', resource: 'session', resourceId: session.id,
        actor: user ? { id: user.id, name: user.username } : null, ip: client.ip, requestId: client.requestId ?? null,
      });
      events?.emit('session.revoked', { sessionId: session.id, userId: session.userId, reason: 'LOGOUT' });
    },

    /** Lists the live sessions of a user. */
    listSessions(userId: string, currentSessionId?: string): SessionInfo[] {
      const at = now();
      return sessions.listActiveForUser(userId, at.toISOString()).filter((s) => isLive(s, at.getTime())).map((s) => toInfo(s, currentSessionId));
    },

    /**
     * Revokes one of `actor`'s own sessions. Returns false when it does not
     * exist or belongs to someone else (indistinguishable to the caller).
     */
    revokeOwnSession(actor: UserSummary, sessionId: string, client: ClientInfo, reason: SessionRevokeReason = 'REVOKED'): boolean {
      const session = sessions.findById(sessionId);
      if (!session || session.userId !== actor.id || session.revokedAt) return false;
      sessions.revoke(session.id, now().toISOString(), reason);
      audit.record({
        action: 'SESSION_REVOKED', result: 'SUCCESS', resource: 'session', resourceId: session.id,
        actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null,
      });
      events?.emit('session.revoked', { sessionId: session.id, userId: session.userId, reason });
      return true;
    },

    /** Revokes every session of a user (used when disabling users or changing passwords). */
    revokeAllSessions(userId: string, reason: SessionRevokeReason, exceptSessionId?: string): number {
      const ids = sessions.revokeAllForUser(userId, now().toISOString(), reason, exceptSessionId);
      for (const id of ids) events?.emit('session.revoked', { sessionId: id, userId, reason });
      return ids.length;
    },

    /**
     * Live sessions of every user (administration), paginated server-side.
     * `currentSessionId` marks the caller's own session.
     */
    listAllSessions(query: { page: number; pageSize: number; userId?: string; currentSessionId?: string }): { items: AdminSessionInfo[]; total: number } {
      const at = now();
      const { items, total } = sessions.listActive({
        now: at.toISOString(),
        idleCutoff: new Date(at.getTime() - idleMs).toISOString(),
        userId: query.userId,
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize,
      });
      const owners = new Map<string, User | undefined>();
      const owner = (id: string) => {
        if (!owners.has(id)) owners.set(id, users.findById(id));
        return owners.get(id);
      };
      return {
        total,
        items: items.map((s) => {
          const u = owner(s.userId);
          return {
            ...toInfo(s, query.currentSessionId),
            user: { id: s.userId, username: u?.username ?? '(deleted user)', displayName: u?.displayName ?? '(deleted user)' },
          };
        }),
      };
    },

    /**
     * Revokes any user's session (administration). Returns false when the
     * session does not exist or has already ended.
     */
    revokeSession(actor: UserSummary, sessionId: string, client: ClientInfo): boolean {
      const session = sessions.findById(sessionId);
      if (!session || session.revokedAt) return false;
      if (!sessions.revoke(session.id, now().toISOString(), 'REVOKED')) return false;
      audit.record({
        action: 'SESSION_REVOKED', result: 'SUCCESS', resource: 'session', resourceId: session.id,
        actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null,
        metadata: { userId: session.userId, scope: 'single', own: session.userId === actor.id },
      });
      events?.emit('session.revoked', { sessionId: session.id, userId: session.userId, reason: 'REVOKED' });
      return true;
    },

    /**
     * Revokes every live session of `userId` (administration, or a user signing
     * out everywhere else). One audit record covers the whole operation.
     */
    revokeUserSessions(actor: UserSummary, userId: string, client: ClientInfo, exceptSessionId?: string): number {
      const ids = sessions.revokeAllForUser(userId, now().toISOString(), 'REVOKED', exceptSessionId);
      if (ids.length) {
        audit.record({
          action: 'SESSION_REVOKED', result: 'SUCCESS', resource: 'user', resourceId: userId,
          actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null,
          metadata: { scope: exceptSessionId ? 'all_except_current' : 'all', count: ids.length, sessionIds: ids, own: userId === actor.id },
        });
      }
      for (const id of ids) events?.emit('session.revoked', { sessionId: id, userId, reason: 'REVOKED' });
      return ids.length;
    },

    /** Deletes sessions that ended more than a day ago. */
    purgeExpired(): number {
      return sessions.purge(new Date(now().getTime() - 24 * 3_600_000).toISOString());
    },
  };
}
