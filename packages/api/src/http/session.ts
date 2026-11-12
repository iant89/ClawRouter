import { AppError } from '@clawapi/core';
import type { AuthService } from '@clawapi/authentication';
import type { AuthorizationService } from '@clawapi/authorization';
import { CSRF_HEADER } from '@clawapi/shared';
import type { Middleware } from './context.ts';
import { parseCookies, serializeCookie } from './cookies.ts';

export interface SessionCookieConfig {
  secure: boolean;
}

/**
 * `__Host-` prefixed when Secure: the browser then guarantees the cookie was
 * set by this host over HTTPS with Path=/ and no Domain attribute.
 */
export function sessionCookieName(config: SessionCookieConfig): string {
  return config.secure ? '__Host-clawapi_session' : 'clawapi_session';
}

/** Sets the cookie for a freshly created session; it lives exactly as long as the session's absolute lifetime. */
export function setSessionCookie(headers: Headers, config: SessionCookieConfig, token: string, session: { createdAt: string; expiresAt: string }): void {
  headers.append('set-cookie', serializeCookie(sessionCookieName(config), token, {
    secure: config.secure,
    httpOnly: true,
    sameSite: 'Strict',
    maxAgeSeconds: (Date.parse(session.expiresAt) - Date.parse(session.createdAt)) / 1000,
  }));
}

export function clearSessionCookie(headers: Headers, config: SessionCookieConfig): void {
  headers.append('set-cookie', serializeCookie(sessionCookieName(config), '', { secure: config.secure, maxAgeSeconds: 0 }));
}

export function readSessionToken(request: Request, config: SessionCookieConfig): string | null {
  return parseCookies(request.headers.get('cookie')).get(sessionCookieName(config)) ?? null;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF protection for the administration API (defence in depth on top of
 * SameSite=Strict cookies and JSON-only bodies):
 *   - a cross-site Origin (or Sec-Fetch-Site) on an unsafe request is rejected;
 *   - cookie-authenticated unsafe requests must carry the `x-clawapi-csrf`
 *     header, which a cross-site page cannot add without a CORS preflight
 *     (and ClawAPI never answers CORS preflights for /api).
 */
export function csrfProtection(config: SessionCookieConfig): Middleware {
  const rejected = () => new AppError('AUTHORIZATION_ERROR', 'Cross-site request rejected.');
  return (ctx, next) => {
    if (!UNSAFE.has(ctx.method) || !ctx.url.pathname.startsWith('/api/')) return next();
    const origin = ctx.request.headers.get('origin');
    if (origin !== null) {
      let host: string | null = null;
      try {
        host = new URL(origin).host;
      } catch {
        // "null" or malformed origin
      }
      if (host !== ctx.url.host) throw rejected();
    } else {
      const site = ctx.request.headers.get('sec-fetch-site');
      if (site !== null && site !== 'same-origin' && site !== 'none') throw rejected();
    }
    if (readSessionToken(ctx.request, config) !== null && !ctx.request.headers.has(CSRF_HEADER)) throw rejected();
    return next();
  };
}

/**
 * Resolves the session cookie on `/api/*`. The external gateway (`/v1/*`)
 * never accepts console sessions (spec §32). An invalid cookie is cleared.
 */
export function sessionAuthentication(auth: AuthService, authz: AuthorizationService, config: SessionCookieConfig): Middleware {
  return (ctx, next) => {
    if (!ctx.url.pathname.startsWith('/api/')) return next();
    const token = readSessionToken(ctx.request, config);
    if (token !== null) {
      const resolved = auth.resolve(token);
      if (resolved) ctx.auth = { ...resolved, ...authz.principalFor(resolved.user.id) };
      else clearSessionCookie(ctx.responseHeaders, config);
    }
    return next();
  };
}

/** Copies `ctx.responseHeaders` onto the response (including error responses). */
export const applyResponseHeaders: Middleware = async (ctx, next) => {
  const response = await next();
  ctx.responseHeaders.forEach((value, key) => {
    if (key === 'set-cookie') return;
    response.headers.set(key, value);
  });
  for (const cookie of ctx.responseHeaders.getSetCookie()) response.headers.append('set-cookie', cookie);
  return response;
};
