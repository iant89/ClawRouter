import { newRequestId, type Logger } from '@clawapi/core';
import type { HealthService } from '@clawapi/health';
import { compose, type Handler, type Middleware, type RequestContext } from './http/context.ts';
import { accessLog, errorBoundary, requestIdHeader, securityHeaders } from './http/middleware.ts';
import { Router } from './http/router.ts';
import { healthHandler } from './controllers/health.ts';

export interface ApiDependencies {
  log: Logger;
  health: HealthService;
}

export interface ApiApp {
  /** Handles a request under `/api/*` or `/v1/*`. */
  handle(request: Request, ip?: string | null): Promise<Response>;
  readonly router: Router;
}

/**
 * Builds the HTTP application. Controllers are thin: they parse/validate input,
 * call application services and format output. No business logic lives here.
 */
export function createApiApp(deps: ApiDependencies): ApiApp {
  const router = new Router();

  // Administration API
  router.get('/api/health', healthHandler(deps.health));

  // External gateway API (/v1/*) is introduced in Phase 8. Unknown paths return a normalized 404.

  const dispatch: Handler = (ctx) => {
    const match = router.match(ctx.method, ctx.url.pathname);
    ctx.params = match.params;
    return match.handler(ctx);
  };

  const pipeline: Middleware[] = [requestIdHeader, securityHeaders, accessLog, errorBoundary];
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
        state: {},
      };
      const response = await handler(ctx);
      return request.method === 'HEAD' ? new Response(null, response) : response;
    },
  };
}
