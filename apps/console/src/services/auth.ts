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

import type { AdminSessionInfo, AuthSession, ChangePasswordRequest, LoginRequest, RevokeResult, SessionInfo, SetupRequest, SetupStatus, SignInChallenge, UserSummary, VerifySignInRequest } from '@clawrouter/shared';
import { ApiClientError, apiDelete, apiGet, apiGetPage, apiPost } from './api-client.ts';

const quiet = { ignoreUnauthorized: true };

export const fetchSetupStatus = () => apiGet<SetupStatus>('/api/setup/status', quiet);

/** The current session, or null when signed out. */
export async function fetchSession(): Promise<AuthSession | null> {
  try {
    return await apiGet<AuthSession>('/api/auth/session', quiet);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) return null;
    throw error;
  }
}

/** A session, or a challenge when the account has two-factor sign-in. */
export const login = (body: LoginRequest) => apiPost<AuthSession | SignInChallenge>('/api/auth/login', body, quiet);
export const verifySignIn = (body: VerifySignInRequest) => apiPost<AuthSession>('/api/auth/login/verify', body, quiet);
export const sendSignInCode = (challenge: string) => apiPost<{ sentTo: string }>('/api/auth/login/email-code', { challenge }, quiet);
export const completeSetup = (body: SetupRequest) => apiPost<AuthSession>('/api/setup', body, quiet);
export const logout = () => apiPost<void>('/api/auth/logout', undefined, quiet);
export const fetchMySessions = () => apiGet<SessionInfo[]>('/api/auth/sessions');

/**
 * Notifies open session lists (Sessions page, My sessions) after any
 * revocation made from this browser, so none of them shows stale rows.
 * Revocations made elsewhere arrive with the WebSocket events in phase 11.
 */
const sessionListeners = new Set<() => void>();
export function onSessionsChanged(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}
async function changing<T>(action: Promise<T>): Promise<T> {
  try {
    return await action;
  } finally {
    for (const listener of sessionListeners) listener();
  }
}

export const revokeMySession = (id: string) => changing(apiDelete(`/api/auth/sessions/${encodeURIComponent(id)}`));
export const revokeMyOtherSessions = () => changing(apiPost<RevokeResult>('/api/auth/sessions/revoke-others'));

// Session administration (all users)
export function fetchAllSessions(query: { page: number; pageSize: number; userId?: string }, signal?: AbortSignal) {
  const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
  if (query.userId) params.set('userId', query.userId);
  return apiGetPage<AdminSessionInfo>(`/api/sessions?${params}`, { signal });
}
export const revokeSession = (id: string) => changing(apiDelete(`/api/sessions/${encodeURIComponent(id)}`));
export const revokeUserSessions = (userId: string, keepCurrent = false) => changing(apiPost<RevokeResult>('/api/sessions/revoke', { userId, keepCurrent }));

/** Changes the signed-in user's own password; their other sessions end. */
export const changePassword = (body: ChangePasswordRequest) => apiPost<UserSummary>('/api/auth/password', body);
