import { AppError, newRequestId, type Logger } from '@clawapi/core';
import type { AuthService, SetupService } from '@clawapi/authentication';
import type { HealthService } from '@clawapi/health';
import { compose, type Handler, type Middleware, type RequestContext } from './http/context.ts';
import { accessLog, errorBoundary, requestIdHeader, securityHeaders } from './http/middleware.ts';
import { Router } from './http/router.ts';
import { applyResponseHeaders, csrfProtection, sessionAuthentication, type SessionCookieConfig } from './http/session.ts';
import { healthHandler } from './controllers/health.ts';
import { authController } from './controllers/auth.ts';

export interface ApiDependencies {
  log: Logger;
  health: HealthService;
  auth: AuthService;
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
 * Every route requires an authenticated session unless registered with
 * `{ public: true }`.
 */
export function createApiApp(deps: ApiDependencies): ApiApp {
  const router = new Router();
  const authRoutes = authController(deps);
  const pub = { public: true };

  // Public: health for load balancers, setup and sign-in.
  router.get('/api/health', healthHandler(deps.health), pub);
  router.get('/api/setup/status', authRoutes.setupStatus, pub);
  router.post('/api/setup', authRoutes.completeSetup, pub);
  router.post('/api/auth/login', authRoutes.login, pub);
  router.post('/api/auth/logout', authRoutes.logout, pub);

  // Authenticated
  router.get('/api/auth/session', authRoutes.session);
  router.get('/api/auth/sessions', authRoutes.listSessions);
  router.delete('/api/auth/sessions/:id', authRoutes.revokeSession);

  // External gateway API (/v1/*) is introduced in phase 8 with API-key authentication.

  const dispatch: Handler = (ctx) => {
    const match = router.match(ctx.method, ctx.url.pathname);
    if (!match.public && !ctx.auth) throw new AppError('AUTHENTICATION_ERROR');
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
    sessionAuthentication(deps.auth, deps.cookie),
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
