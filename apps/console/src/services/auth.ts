import type { AuthSession, LoginRequest, SessionInfo, SetupRequest, SetupStatus } from '@clawapi/shared';
import { ApiClientError, apiDelete, apiGet, apiPost } from './api-client.ts';

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
export const revokeMySession = (id: string) => apiDelete(`/api/auth/sessions/${encodeURIComponent(id)}`);
