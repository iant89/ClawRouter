import type { AuthSession } from '@clawapi/shared';

/** Console authentication state (spec §34: auth state is separate from server and UI state). */
export type AuthState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'setup-required' }
  | { status: 'signed-out'; reason: 'none' | 'signed-out' | 'expired' }
  | { status: 'signed-in'; session: AuthSession };

export type AuthEvent =
  | { type: 'resolved'; setupRequired: boolean; session: AuthSession | null }
  | { type: 'failed'; message: string }
  | { type: 'signed-in'; session: AuthSession }
  | { type: 'signed-out' }
  | { type: 'expired' };

export function authReducer(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case 'resolved':
      if (event.setupRequired) return { status: 'setup-required' };
      return event.session ? { status: 'signed-in', session: event.session } : { status: 'signed-out', reason: 'none' };
    case 'failed':
      return { status: 'error', message: event.message };
    case 'signed-in':
      return { status: 'signed-in', session: event.session };
    case 'signed-out':
      return { status: 'signed-out', reason: 'signed-out' };
    case 'expired':
      // Only a signed-in user can "expire"; ignore stray 401s on the sign-in screen.
      return state.status === 'signed-in' ? { status: 'signed-out', reason: 'expired' } : state;
  }
}

/** Paths that belong to the signed-out flow. */
export const PUBLIC_PATHS = ['/login', '/setup'] as const;

/**
 * Where the console should be for a given auth state, or null to stay.
 * Keeps deep links: the original path is passed as `?next=` to the sign-in page.
 */
export function redirectFor(state: AuthState, pathname: string, search = ''): string | null {
  const next = new URLSearchParams(search).get('next');
  switch (state.status) {
    case 'setup-required':
      return pathname === '/setup' ? null : '/setup';
    case 'signed-out':
      if (pathname === '/login') return null;
      return pathname === '/' || pathname === '/setup' ? '/login' : `/login?next=${encodeURIComponent(pathname)}`;
    case 'signed-in':
      if (pathname === '/login' || pathname === '/setup') return safeNext(next);
      return null;
    default:
      return null;
  }
}

/** Only same-origin absolute paths are followed (no open redirects). */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (next === '/login' || next === '/setup') return '/';
  return next;
}
