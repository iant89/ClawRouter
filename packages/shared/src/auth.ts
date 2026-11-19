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

import type { OnboardingInfo } from './onboarding.ts';
import type { UserQuota } from './quotas.ts';

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
  /** The longest an API key this user creates may last, in hours; null: no limit (Administrators). */
  keyLifetimeLimitHours: number | null;
  /** Effective permissions, for showing and hiding UI. The server re-checks every request. */
  permissions: string[];
  /** First-run setup wizard and guided tour. */
  onboarding: OnboardingInfo;
  /** Whether ClawRouter's MCP server (/v1/mcp) is on (the mcpEnabled setting): the console shows MCP access on keys only then. */
  mcpServer: boolean;
  /** Whether the playground is on (the playgroundEnabled setting). Opening it also needs playground.use. */
  playground: boolean;
  /** The user's console theme (their choice, or the default). */
  theme: ThemeChoice;
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
  /** Optional; needed for email sign-in codes. */
  email?: string | null;
  /** Optional usage quota (see quotas.ts); null or absent for none. */
  quota?: UserQuota | null;
}

/** PATCH /api/users/:id (users.write). */
export interface UpdateUserRequest {
  displayName?: string;
  status?: 'ACTIVE' | 'DISABLED';
  /** null removes the address. Changing it turns email sign-in codes off until confirmed again. */
  email?: string | null;
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

/**
 * Error details when a feature an administrator turned off in Settings is used:
 * `{ reason: 'feature_disabled', feature: 'playground' }` with 403, so programs can tell
 * "turned off" apart from "not allowed".
 */
export const FEATURE_DISABLED = 'feature_disabled';

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

/** Console colour themes a user can choose (owner request, 2026-11-17). `system` follows the device. */
export const THEME_CHOICES = ['light', 'dark', 'system'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];
/** Spec §18: dense, dark, technical. */
export const DEFAULT_THEME: ThemeChoice = 'dark';
