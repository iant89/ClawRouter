import { AppError, newRequestId, type Logger } from '@clawrouter/core';
import type { AuthService, SetupService } from '@clawrouter/authentication';
import type { AuthorizationService } from '@clawrouter/authorization';
import type { NotificationService } from '@clawrouter/notifications';
import type { ProviderService } from '@clawrouter/providers';
import type { ModelService } from '@clawrouter/models';
import type { RoutingService } from '@clawrouter/routing';
import type { ApiKeyService, GatewayService } from '@clawrouter/gateway';
import type { RateLimitService } from '@clawrouter/rate-limits';
import type { HealthService } from '@clawrouter/health';
import { compose, type Handler, type Middleware, type RequestContext } from './http/context.ts';
import { accessLog, errorBoundary, requestIdHeader, securityHeaders } from './http/middleware.ts';
import { Router } from './http/router.ts';
import { apiKeyAuthentication, applyResponseHeaders, csrfProtection, sessionAuthentication, type SessionCookieConfig } from './http/session.ts';
import { healthHandler } from './controllers/health.ts';
import { authController } from './controllers/auth.ts';
import { accessController } from './controllers/access.ts';
import { notificationsController } from './controllers/notifications.ts';
import { providersController } from './controllers/providers.ts';
import { modelsController } from './controllers/models.ts';
import { routingController } from './controllers/routing.ts';
import { apiKeysController, gatewayController } from './controllers/gateway.ts';
import { rateLimitsController } from './controllers/rate-limits.ts';

export interface ApiDependencies {
  log: Logger;
  health: HealthService;
  auth: AuthService;
  authz: AuthorizationService;
  notifications: NotificationService;
  providers: ProviderService;
  models: ModelService;
  routing: RoutingService;
  apiKeys: ApiKeyService;
  gateway: GatewayService;
  limits: RateLimitService;
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
  const prov = providersController(deps.providers);
  const mod = modelsController(deps.models);
  const rt = routingController(deps.routing);
  const keys = apiKeysController(deps.apiKeys);
  const gw = gatewayController(deps.gateway);
  const rl = rateLimitsController(deps.limits);

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

  // AI infrastructure: providers (spec §31)
  router.get('/api/providers/kinds', 'providers.read', prov.kinds);
  router.get('/api/providers', 'providers.read', prov.list);
  router.post('/api/providers', 'providers.write', prov.create);
  router.get('/api/providers/:id', 'providers.read', prov.get);
  router.patch('/api/providers/:id', 'providers.write', prov.update);
  router.delete('/api/providers/:id', 'providers.write', prov.remove);
  router.post('/api/providers/:id/test', 'providers.write', prov.test);
  router.put('/api/providers/:id/credential', 'providers.write', prov.putKey);
  router.delete('/api/providers/:id/credential', 'providers.write', prov.deleteKey);
  // Discovery calls the provider, so it needs write access, like a connection test.
  router.get('/api/providers/:id/models/discover', 'models.write', mod.discover);
  router.post('/api/providers/:id/models/import', 'models.write', mod.importModels);

  // AI infrastructure: model registry (spec §31)
  router.get('/api/models', 'models.read', mod.list);
  router.post('/api/models', 'models.write', mod.create);
  router.get('/api/models/:id', 'models.read', mod.get);
  router.patch('/api/models/:id', 'models.write', mod.update);
  router.delete('/api/models/:id', 'models.write', mod.remove);

  // AI infrastructure: routing (spec §10, §31). The preview is a dry run: nothing is sent to a provider.
  router.get('/api/routing', 'routing.read', rt.get);
  router.put('/api/routing', 'routing.write', rt.put);
  router.post('/api/routing/preview', 'routing.read', rt.preview);

  // Administration
  router.get('/api/sessions', 'sessions.read', authRoutes.listAllSessions);
  router.post('/api/sessions/revoke', 'sessions.revoke', authRoutes.revokeUserSessions);
  router.delete('/api/sessions/:id', 'sessions.revoke', authRoutes.revokeAnySession);
  router.get('/api/roles', 'roles.read', access.listRoles);
  router.get('/api/users', 'users.read', access.listUsers);
  router.put('/api/users/:id/roles', 'roles.assign', access.setUserRoles);

  // Gateway administration: API keys (spec §14, §31) and live metrics.
  router.get('/api/api-keys', 'api_keys.read', keys.list);
  router.post('/api/api-keys', 'api_keys.write', keys.create);
  router.patch('/api/api-keys/:id', 'api_keys.write', keys.update);
  router.delete('/api/api-keys/:id', 'api_keys.write', keys.revoke);
  router.get('/api/gateway/metrics', 'requests.read', gw.metrics);
  router.get('/api/rate-limits', 'rate_limits.read', rl.get);
  router.put('/api/rate-limits', 'rate_limits.write', rl.put);
  router.get('/api/rate-limits/usage', 'rate_limits.read', rl.usage);

  // External AI API (spec §7, §32): API keys only, OpenAI-compatible.
  router.get('/v1/models', 'api_key', gw.models);
  router.post('/v1/chat/completions', 'api_key', gw.chat);
  router.post('/v1/embeddings', 'api_key', gw.embeddings);
  router.post('/v1/responses', 'api_key', gw.responses);

  const dispatch: Handler = (ctx) => {
    const match = router.match(ctx.method, ctx.url.pathname);
    if (match.access === 'api_key') {
      if (!ctx.apiKey) {
        const presented = ctx.request.headers.has('authorization') || ctx.request.headers.has('x-api-key');
        throw new AppError('AUTHENTICATION_ERROR', presented ? 'Invalid, expired or revoked API key.' : 'Missing API key. Send it as "Authorization: Bearer <key>".', { expose: true });
      }
    } else if (match.access !== 'public') {
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
    apiKeyAuthentication(deps.apiKeys, deps.limits),
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
        apiKey: null,
        responseHeaders: new Headers(),
        state: {},
      };
      const response = await handler(ctx);
      return request.method === 'HEAD' ? new Response(null, response) : response;
    },
  };
}
