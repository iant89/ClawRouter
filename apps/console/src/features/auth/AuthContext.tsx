import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import type { LoginRequest, SetupRequest } from '@clawapi/shared';
import { setUnauthorizedHandler } from '../../services/api-client.ts';
import * as authApi from '../../services/auth.ts';
import { authReducer, type AuthState } from './auth-state.ts';

interface AuthValue {
  state: AuthState;
  signIn(body: LoginRequest): Promise<void>;
  completeSetup(body: SetupRequest): Promise<void>;
  signOut(): Promise<void>;
  retry(): void;
}

const AuthContext = createContext<AuthValue | null>(null);

/** How often to confirm the session is still valid (it can expire or be revoked elsewhere). */
const SESSION_CHECK_MS = 60_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(authReducer, { status: 'loading' });

  const resolve = useCallback(async () => {
    try {
      const [setup, session] = await Promise.all([authApi.fetchSetupStatus(), authApi.fetchSession()]);
      dispatch({ type: 'resolved', setupRequired: setup.required, session });
    } catch (error) {
      dispatch({ type: 'failed', message: error instanceof Error ? error.message : 'Cannot reach the ClawAPI server.' });
    }
  }, []);

  useEffect(() => {
    void resolve();
    setUnauthorizedHandler(() => dispatch({ type: 'expired' }));
    return () => setUnauthorizedHandler(null);
  }, [resolve]);

  const signedIn = state.status === 'signed-in';
  useEffect(() => {
    if (!signedIn) return;
    const id = window.setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      const session = await authApi.fetchSession().catch(() => undefined);
      if (session === null) dispatch({ type: 'expired' });
    }, SESSION_CHECK_MS);
    return () => window.clearInterval(id);
  }, [signedIn]);

  const value = useMemo<AuthValue>(() => ({
    state,
    async signIn(body) {
      dispatch({ type: 'signed-in', session: await authApi.login(body) });
    },
    async completeSetup(body) {
      dispatch({ type: 'signed-in', session: await authApi.completeSetup(body) });
    },
    async signOut() {
      try {
        await authApi.logout();
      } finally {
        dispatch({ type: 'signed-out' });
      }
    },
    retry: () => void resolve(),
  }), [state, resolve]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

/** The signed-in session. Only call below the authenticated part of the tree. */
export function useSession() {
  const { state } = useAuth();
  if (state.status !== 'signed-in') throw new Error('useSession requires a signed-in user');
  return state.session;
}
