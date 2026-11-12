import type { AdminSessionInfo, AuthSession, LoginRequest, RevokeResult, SessionInfo, SetupRequest, SetupStatus } from '@clawapi/shared';
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

export const login = (body: LoginRequest) => apiPost<AuthSession>('/api/auth/login', body, quiet);
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
