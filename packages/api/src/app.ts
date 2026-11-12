import { AppError, newRequestId, type Logger } from '@clawapi/core';
import type { AuthService, SetupService } from '@clawapi/authentication';
import type { AuthorizationService } from '@clawapi/authorization';
import type { NotificationService } from '@clawapi/notifications';
import type { HealthService } from '@clawapi/health';
import { compose, type Handler, type Middleware, type RequestContext } from './http/context.ts';
import { accessLog, errorBoundary, requestIdHeader, securityHeaders } from './http/middleware.ts';
import { Router } from './http/router.ts';
import { applyResponseHeaders, csrfProtection, sessionAuthentication, type SessionCookieConfig } from './http/session.ts';
import { healthHandler } from './controllers/health.ts';
import { authController } from './controllers/auth.ts';
import { accessController } from './controllers/access.ts';
import { notificationsController } from './controllers/notifications.ts';

export interface ApiDependencies {
  log: Logger;
  health: HealthService;
  auth: AuthService;
  authz: AuthorizationService;
  notifications: NotificationService;
  setup: SetupService;
  cookie: SessionCookieConfig;
}

export interface ApiApp {
  /** Handles a request under `/api/*` or `/v1/*`. */
  handle(request: Request, ip?: string | null): Promise<Response>;
  readonly router: Router;
}

/**
 * Builds the HTTP application. Controllers are thin: they parse/validate input,
 * call application services and format output. No business logic lives here.
 *
 * Every route declares its access: 'public', 'authenticated' (own data only),
 * or the permission it requires. The dispatcher enforces it before the handler
 * runs (spec §16: authorization is enforced server-side).
 */
export function createApiApp(deps: ApiDependencies): ApiApp {
  const router = new Router();
  const authRoutes = authController(deps);
  const access = accessController(deps.authz);
  const notes = notificationsController(deps.notifications);

  // Public: health for load balancers, setup and sign-in.
  router.get('/api/health', 'public', healthHandler(deps.health));
  router.get('/api/setup/status', 'public', authRoutes.setupStatus);
  router.post('/api/setup', 'public', authRoutes.completeSetup);
  router.post('/api/auth/login', 'public', authRoutes.login);
  router.post('/api/auth/logout', 'public', authRoutes.logout);

  // Any signed-in user, for their own session only.
  router.get('/api/auth/session', 'authenticated', authRoutes.session);
  router.get('/api/auth/sessions', 'authenticated', authRoutes.listSessions);
  router.post('/api/auth/sessions/revoke-others', 'authenticated', authRoutes.revokeOtherSessions);
  router.delete('/api/auth/sessions/:id', 'authenticated', authRoutes.revokeSession);
  router.get('/api/notifications', 'authenticated', notes.list);
  router.post('/api/notifications/read-all', 'authenticated', notes.markAllRead);
  router.post('/api/notifications/:id/read', 'authenticated', notes.markRead);
  router.delete('/api/notifications/:id', 'authenticated', notes.dismiss);

  // Administration
  router.get('/api/sessions', 'sessions.read', authRoutes.listAllSessions);
  router.post('/api/sessions/revoke', 'sessions.revoke', authRoutes.revokeUserSessions);
  router.delete('/api/sessions/:id', 'sessions.revoke', authRoutes.revokeAnySession);
  router.get('/api/roles', 'roles.read', access.listRoles);
  router.get('/api/users', 'users.read', access.listUsers);
  router.put('/api/users/:id/roles', 'roles.assign', access.setUserRoles);

  // External gateway API (/v1/*) is introduced in phase 8 with API-key authentication.

  const dispatch: Handler = (ctx) => {
    const match = router.match(ctx.method, ctx.url.pathname);
    if (match.access !== 'public') {
      if (!ctx.auth) throw new AppError('AUTHENTICATION_ERROR');
      if (match.access !== 'authenticated' && !ctx.auth.permissions.has(match.access)) {
        ctx.log.info('access denied', { component: 'authorization', userId: ctx.auth.user.id, permission: match.access, path: ctx.url.pathname });
        throw new AppError('AUTHORIZATION_ERROR');
      }
    }
    ctx.params = match.params;
    return match.handler(ctx);
  };

  const pipeline: Middleware[] = [
    requestIdHeader,
    securityHeaders,
    accessLog,
    applyResponseHeaders,
    errorBoundary,
    csrfProtection(deps.cookie),
    sessionAuthentication(deps.auth, deps.authz, deps.cookie),
  ];
  const handler = compose(pipeline, dispatch);

  return {
    router,
    async handle(request, ip = null) {
      const requestId = newRequestId();
      const ctx: RequestContext = {
        request,
        url: new URL(request.url),
        method: request.method.toUpperCase(),
        params: {},
        requestId,
        ip,
        log: deps.log.child({ requestId }),
        auth: null,
        responseHeaders: new Headers(),
        state: {},
      };
      const response = await handler(ctx);
      return request.method === 'HEAD' ? new Response(null, response) : response;
    },
  };
}
