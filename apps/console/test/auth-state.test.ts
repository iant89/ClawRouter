import { describe, expect, test } from 'bun:test';
import type { AuthSession } from '@clawapi/shared';
import { authReducer, redirectFor, safeNext, type AuthState } from '../src/features/auth/auth-state.ts';

const session = { user: { id: 'u', username: 'admin' }, session: { id: 's' } } as unknown as AuthSession;
const signedIn: AuthState = { status: 'signed-in', session };
const signedOut: AuthState = { status: 'signed-out', reason: 'none' };

describe('authReducer', () => {
  test('resolution', () => {
    expect(authReducer({ status: 'loading' }, { type: 'resolved', setupRequired: true, session: null })).toEqual({ status: 'setup-required' });
    expect(authReducer({ status: 'loading' }, { type: 'resolved', setupRequired: false, session })).toEqual(signedIn);
    expect(authReducer({ status: 'loading' }, { type: 'resolved', setupRequired: false, session: null })).toEqual(signedOut);
  });

  test('expiry only applies to a signed-in user', () => {
    expect(authReducer(signedIn, { type: 'expired' })).toEqual({ status: 'signed-out', reason: 'expired' });
    expect(authReducer(signedOut, { type: 'expired' })).toBe(signedOut);
  });

  test('sign out', () => {
    expect(authReducer(signedIn, { type: 'signed-out' })).toEqual({ status: 'signed-out', reason: 'signed-out' });
  });
});

describe('redirectFor', () => {
  test('setup required forces /setup', () => {
    expect(redirectFor({ status: 'setup-required' }, '/providers')).toBe('/setup');
    expect(redirectFor({ status: 'setup-required' }, '/setup')).toBeNull();
  });

  test('signed out goes to /login and keeps the deep link', () => {
    expect(redirectFor(signedOut, '/health')).toBe('/login?next=%2Fhealth');
    expect(redirectFor(signedOut, '/')).toBe('/login');
    expect(redirectFor(signedOut, '/setup')).toBe('/login');
    expect(redirectFor(signedOut, '/login')).toBeNull();
  });

  test('signed in leaves the auth pages for the requested page', () => {
    expect(redirectFor(signedIn, '/login', '?next=%2Fhealth')).toBe('/health');
    expect(redirectFor(signedIn, '/setup')).toBe('/');
    expect(redirectFor(signedIn, '/providers')).toBeNull();
  });

  test('loading and error states never redirect', () => {
    expect(redirectFor({ status: 'loading' }, '/x')).toBeNull();
    expect(redirectFor({ status: 'error', message: 'x' }, '/x')).toBeNull();
  });
});

describe('safeNext', () => {
  test.each([
    [null, '/'],
    ['/health', '/health'],
    ['https://evil.example', '/'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['/login', '/'],
  ])('%p -> %s', (input, out) => {
    expect(safeNext(input)).toBe(out);
  });
});

describe('refreshed', () => {
  const base = { user: { id: 'u', displayName: 'U' }, session: { id: 's' }, roles: ['VIEWER'], permissions: ['models.read'] } as unknown as AuthSession;
  const state: AuthState = { status: 'signed-in', session: base };

  test('keeps the same state object when nothing changed', () => {
    expect(authReducer(state, { type: 'refreshed', session: { ...base } })).toBe(state);
  });

  test('applies role and permission changes', () => {
    const next = { ...base, roles: ['ADMIN'], permissions: ['models.read', 'users.read'] };
    expect(authReducer(state, { type: 'refreshed', session: next })).toEqual({ status: 'signed-in', session: next });
  });

  test('never signs anyone in', () => {
    const out: AuthState = { status: 'signed-out', reason: 'none' };
    expect(authReducer(out, { type: 'refreshed', session: base })).toBe(out);
  });
});
