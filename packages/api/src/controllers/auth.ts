import { AppError, errors, v } from '@clawapi/core';
import type { AuthService, ClientInfo, SetupService } from '@clawapi/authentication';
import type { AuthorizationService } from '@clawapi/authorization';
import type { AdminSessionInfo, AuthSession, RevokeResult, SetupStatus } from '@clawapi/shared';
import { readJson } from '../http/body.ts';
import type { Handler, RequestContext } from '../http/context.ts';
import { noContent, ok } from '../http/responses.ts';
import { clearSessionCookie, readSessionToken, setSessionCookie, type SessionCookieConfig } from '../http/session.ts';

const loginBody = v.object({
  username: v.string({ min: 1, max: 64 }),
  // Not trimmed: whitespace is part of the password. Upper bound stops hashing huge inputs.
  password: v.string({ min: 1, max: 1024, trim: false }),
});

const setupBody = v.object({
  setupToken: v.string({ min: 1, max: 256 }),
  username: v.string({ min: 2, max: 64 }),
  displayName: v.string({ min: 1, max: 128 }),
  password: v.string({ min: 1, max: 1024, trim: false }),
});

const revokeUserBody = v.object({
  userId: v.string({ min: 1, max: 64 }),
  /** Keep the caller's own current session when revoking their own sessions. */
  keepCurrent: v.optional(v.boolean()),
});

function pageQuery(url: URL) {
  const int = (name: string, fallback: number, min: number, max: number) => {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw errors.validation([{ path: name, message: `must be an integer between ${min} and ${max}` }]);
    return n;
  };
  return { page: int('page', 1, 1, 1_000_000), pageSize: int('pageSize', 25, 1, 100) };
}

const client = (ctx: RequestContext): ClientInfo => ({
  ip: ctx.ip,
  userAgent: ctx.request.headers.get('user-agent'),
  requestId: ctx.requestId,
});

function requireAuth(ctx: RequestContext) {
  if (!ctx.auth) throw new AppError('AUTHENTICATION_ERROR');
  return ctx.auth;
}

export interface AuthControllerDeps {
  auth: AuthService;
  authz: AuthorizationService;
  setup: SetupService;
  cookie: SessionCookieConfig;
}

export function authController({ auth, authz, setup, cookie }: AuthControllerDeps) {
  /** The session body, with the roles and permissions the console uses to adapt its UI. */
  const sessionBody = (user: AuthSession['user'], info: AuthSession['session']): AuthSession => {
    const principal = authz.principalFor(user.id);
    return { user, session: info, roles: principal.roles, permissions: [...principal.permissions].sort() };
  };

  const login: Handler = async (ctx) => {
    const body = await readJson(ctx, loginBody);
    const result = await auth.login(body.username, body.password, client(ctx));
    setSessionCookie(ctx.responseHeaders, cookie, result.token, result.session);
    return ok<AuthSession>(sessionBody(result.user, result.session));
  };

  /** Always succeeds and clears the cookie, even if the session already ended. */
  const logout: Handler = (ctx) => {
    const token = readSessionToken(ctx.request, cookie);
    if (token) auth.logout(token, client(ctx));
    clearSessionCookie(ctx.responseHeaders, cookie);
    return noContent();
  };

  const session: Handler = (ctx) => {
    const { user, session: info } = requireAuth(ctx);
    return ok<AuthSession>(sessionBody(user, info));
  };

  const listSessions: Handler = (ctx) => {
    const current = requireAuth(ctx);
    return ok(auth.listSessions(current.user.id, current.sessionId));
  };

  const revokeSession: Handler = (ctx) => {
    const current = requireAuth(ctx);
    const id = ctx.params.id ?? '';
    if (!auth.revokeOwnSession(current.user, id, client(ctx))) throw errors.notFound('Session not found.');
    if (id === current.sessionId) clearSessionCookie(ctx.responseHeaders, cookie);
    return noContent();
  };

  /** Sign out everywhere except this browser. */
  const revokeOtherSessions: Handler = (ctx) => {
    const current = requireAuth(ctx);
    const revoked = auth.revokeUserSessions(current.user, current.user.id, client(ctx), current.sessionId);
    return ok<RevokeResult>({ revoked });
  };

  // Administration: sessions.read / sessions.revoke (enforced by the router).
  const listAllSessions: Handler = (ctx) => {
    const current = requireAuth(ctx);
    const { page, pageSize } = pageQuery(ctx.url);
    const userId = ctx.url.searchParams.get('userId') || undefined;
    const { items, total } = auth.listAllSessions({ page, pageSize, userId, currentSessionId: current.sessionId });
    return ok<AdminSessionInfo[]>(items, { meta: { page, pageSize, total } });
  };

  const revokeAnySession: Handler = (ctx) => {
    const current = requireAuth(ctx);
    const id = ctx.params.id ?? '';
    if (!auth.revokeSession(current.user, id, client(ctx))) throw errors.notFound('Session not found or already ended.');
    if (id === current.sessionId) clearSessionCookie(ctx.responseHeaders, cookie);
    return noContent();
  };

  const revokeUserSessions: Handler = async (ctx) => {
    const current = requireAuth(ctx);
    const body = await readJson(ctx, revokeUserBody);
    const keep = body.keepCurrent && body.userId === current.user.id ? current.sessionId : undefined;
    const revoked = auth.revokeUserSessions(current.user, body.userId, client(ctx), keep);
    if (body.userId === current.user.id && !keep && revoked > 0) clearSessionCookie(ctx.responseHeaders, cookie);
    return ok<RevokeResult>({ revoked });
  };

  const setupStatus: Handler = () => ok<SetupStatus>({ required: setup.isRequired() });

  const completeSetup: Handler = async (ctx) => {
    if (!setup.isRequired()) throw new AppError('CONFLICT', 'Initial setup has already been completed.');
    const body = await readJson(ctx, setupBody);
    const result = await setup.complete(body, client(ctx));
    setSessionCookie(ctx.responseHeaders, cookie, result.token, result.session);
    return ok<AuthSession>(sessionBody(result.user, result.session), { status: 201 });
  };

  return { login, logout, session, listSessions, revokeSession, revokeOtherSessions, listAllSessions, revokeAnySession, revokeUserSessions, setupStatus, completeSetup };
}
