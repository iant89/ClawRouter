/** Authentication DTOs shared by the server and the console. Never contain secrets. */
export const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
}

/** A session as shown to its owner. The token never leaves the cookie. */
export interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  /** When the session ends unless used again (idle timeout). */
  idleExpiresAt: string;
  /** When the session ends regardless of activity. */
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/** GET /api/auth/session, POST /api/auth/login, POST /api/setup */
export interface AuthSession {
  user: UserSummary;
  session: SessionInfo;
}

/** GET /api/setup/status */
export interface SetupStatus {
  required: boolean;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface SetupRequest {
  setupToken: string;
  username: string;
  displayName: string;
  password: string;
}

/** Password policy, enforced by the server and mirrored in the console for feedback. */
export const PASSWORD_POLICY = { minLength: 12, maxLength: 256 } as const;

export const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/;

/** Header the console sends on state-changing requests (CSRF defence in depth). */
export const CSRF_HEADER = 'x-clawapi-csrf';

/** A session as shown to administrators: includes whose it is. */
export interface AdminSessionInfo extends SessionInfo {
  user: { id: string; username: string; displayName: string };
}

/** POST /api/sessions/revoke and POST /api/auth/sessions/revoke-others */
export interface RevokeResult {
  revoked: number;
}
