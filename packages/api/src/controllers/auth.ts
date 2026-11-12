import { AppError, errors, v } from '@clawapi/core';
import type { AuthService, ClientInfo, SetupService } from '@clawapi/authentication';
import type { AuthSession, SetupStatus } from '@clawapi/shared';
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
  setup: SetupService;
  cookie: SessionCookieConfig;
}

export function authController({ auth, setup, cookie }: AuthControllerDeps) {
  const login: Handler = async (ctx) => {
    const body = await readJson(ctx, loginBody);
    const result = await auth.login(body.username, body.password, client(ctx));
    setSessionCookie(ctx.responseHeaders, cookie, result.token, result.session);
    return ok<AuthSession>({ user: result.user, session: result.session });
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
    return ok<AuthSession>({ user, session: info });
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

  const setupStatus: Handler = () => ok<SetupStatus>({ required: setup.isRequired() });

  const completeSetup: Handler = async (ctx) => {
    if (!setup.isRequired()) throw new AppError('CONFLICT', 'Initial setup has already been completed.');
    const body = await readJson(ctx, setupBody);
    const result = await setup.complete(body, client(ctx));
    setSessionCookie(ctx.responseHeaders, cookie, result.token, result.session);
    return ok<AuthSession>({ user: result.user, session: result.session }, { status: 201 });
  };

  return { login, logout, session, listSessions, revokeSession, setupStatus, completeSetup };
}
