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
  /** Set by an administrator reset or a new account: the user must choose a new password before doing anything else. */
  mustChangePassword: boolean;
  /** Where sign-in codes and security mail go; null when not set. */
  email: string | null;
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
  /** Role ids held by the user (phase 3). */
  roles: string[];
  /** Two-factor sign-in is required for this user and not set up yet: only setting it up is allowed. */
  twoFactorSetupRequired: boolean;
  /** Effective permissions, for showing and hiding UI. The server re-checks every request. */
  permissions: string[];
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

/** POST /api/users (users.write). The password is temporary: the user must change it at first sign-in. */
export interface CreateUserRequest {
  username: string;
  displayName: string;
  password: string;
  roles: string[];
}

/** PATCH /api/users/:id (users.write). */
export interface UpdateUserRequest {
  displayName?: string;
  status?: 'ACTIVE' | 'DISABLED';
}

/** POST /api/users/:id/password (users.write): sets a temporary password and signs the user out. */
export interface ResetPasswordRequest {
  password: string;
}

/** POST /api/auth/password: a signed-in user changes their own password. */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/** Error details when a route is refused because the user must change their password first. */
export const PASSWORD_CHANGE_REQUIRED = 'password_change_required';

/** Password policy, enforced by the server and mirrored in the console for feedback. */
export const PASSWORD_POLICY = { minLength: 12, maxLength: 256 } as const;

export const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/;

/** Header the console sends on state-changing requests (CSRF defence in depth). */
export const CSRF_HEADER = 'x-clawrouter-csrf';

/** A session as shown to administrators: includes whose it is. */
export interface AdminSessionInfo extends SessionInfo {
  user: { id: string; username: string; displayName: string };
}

/** POST /api/sessions/revoke and POST /api/auth/sessions/revoke-others */
export interface RevokeResult {
  revoked: number;
}
