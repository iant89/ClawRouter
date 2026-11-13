import type { HTMLBundle, Server } from 'bun';
import { createApiApp, createRealtimeHub, type ApiApp, type RealtimeHub, type SocketData } from '@clawrouter/api';
import { createAuditService, createSqliteAuditRepository, type AuditService } from '@clawrouter/audit';
import {
  createArgon2Hasher, createAuthService, createSetupService, createSqliteSessionRepository, createSqliteUserRepository, createTwoFactorService, createUserAdminService,
  type AuthService, type PasswordHasher, type SetupService,
} from '@clawrouter/authentication';
import { createAuthorizationService, createSqliteRoleRepository, peopleDirectory, userAccessPolicy, type AuthorizationService } from '@clawrouter/authorization';
import { clientAddress, createEventBus, parseTrustedProxies, type Config, type EventBus, type LogBuffer, type Logger } from '@clawrouter/core';
import { REALTIME_PATH } from '@clawrouter/shared';
import { createConsoleAssets } from './console-assets.ts';
import { createNotificationService, createSqliteNotificationRepository, type NotificationService } from '@clawrouter/notifications';
import { createDefaultRegistry, createProviderService, createSqliteProviderRepository, type ProviderService } from '@clawrouter/providers';
import { createModelService, createSqliteModelRepository, type ModelService } from '@clawrouter/models';
import { createRoutingService, createSqliteRoutingStore, type RoutingService } from '@clawrouter/routing';
import { createApiKeyService, createGatewayService, createKeyRequestService, type ApiKeyService, type GatewayService } from '@clawrouter/gateway';
import { createRateLimitService, createSqliteRateLimitConfigStore, MemoryCounterStore, type RateLimitService } from '@clawrouter/rate-limits';
import { createRequestLogService, createSqliteRequestRepository, type RequestLogService } from '@clawrouter/requests';
import { createSqliteSettingsRepository, migrations, openSqlite, runMigrations, type Database } from '@clawrouter/database';
import { createSettingsService, settingDefaults } from '@clawrouter/settings';
import { createMailService } from '@clawrouter/mail';
import {
  createDatabaseCheck, createGatewayCheck, createHealthHistoryService, createHealthService, createPlatformCheck, createProvidersCheck,
  createSqliteHealthHistoryRepository, createWebSocketCheck, type HealthHistoryService, type HealthService,
} from '@clawrouter/health';
import { loadSecretBox } from './secret-key.ts';
import { provisionSetupToken, type SetupToken } from './setup-token.ts';
import { operationHandlers } from './operation-handlers.ts';
import { createOperationService, createSqliteOperationRepository, type OperationService } from '@clawrouter/operations';

export interface ClawRouterOptions {
  config: Config;
  log: Logger;
  version: string;
  /** The console's HTML entry (Bun bundles it on the fly in development). Omit to run headless. */
  consoleHtml?: HTMLBundle;
  /** Directory the production console files are in (the bundle's directory). */
  consoleDir?: string;
  /** Override password hashing cost (tests). */
  hasher?: PasswordHasher;
  /** Recent log records the logger also writes to (see main.ts), for the Logs page. */
  logBuffer?: LogBuffer;
  /** Override the fetch used for provider calls (tests). */
  providerFetch?: typeof fetch;
}

export interface ClawRouter {
  server: Server<SocketData>;
  realtime: RealtimeHub;
  healthHistory: HealthHistoryService;
  operations: OperationService;
  db: Database;
  events: EventBus;
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
  requests: RequestLogService;
  setup: SetupService;
  audit: AuditService;
  /** Present while initial setup is pending. */
  setupToken: SetupToken | null;
  api: ApiApp;
  url: URL;
  stop(): Promise<void>;
}

/**
 * Composition root: wires configuration, persistence, domain services and the
 * HTTP layer together, then starts listening. Everything is created here and
 * passed down explicitly; no module-level singletons.
 */
export async function startClawRouter({ config, log, logBuffer, version, consoleHtml, consoleDir, hasher = createArgon2Hasher(), providerFetch }: ClawRouterOptions): Promise<ClawRouter> {
  const db = openSqlite({ path: config.database.path });
  try {
    runMigrations(db, migrations, log);
  } catch (error) {
    db.close();
    throw error;
  }

  const events = createEventBus(log);
  const audit = createAuditService(createSqliteAuditRepository(db), log);
  // System settings: read at use time by the services below, so console changes apply without a restart.
  const settings = createSettingsService({ repo: createSqliteSettingsRepository(db), defaults: settingDefaults(config), audit, events, log });
  const secrets = loadSecretBox(config, log);
  const providers = createProviderService({
    repo: createSqliteProviderRepository(db), registry: createDefaultRegistry(), secrets, audit, events, log, fetch: providerFetch,
  });
  const models = createModelService({ repo: createSqliteModelRepository(db), providers, audit, events, log });
  const unsubscribeModels = models.subscribe(events);
  const routing = createRoutingService({ store: createSqliteRoutingStore(db), models, providers, audit, events, log });
  // Keys for specific models must fit their maximum key lifetime: the service reads the registry and aliases.
  // Owner rule: Administrators may create keys that never expire; everyone else is limited by a setting.
  const apiKeys = createApiKeyService({
    db, audit, log, catalog: () => ({ models: models.listAll(), aliases: routing.get().aliases }),
    creatorLimitHours: (userId) => (authz.principalFor(userId).roles.includes('ADMIN') ? null : settings.get('keyMaxLifetimeDays') * 24),
  });
  // Counters live in memory (single node); the CounterStore interface allows a shared store later (spec §12).
  const limits = createRateLimitService({
    store: createSqliteRateLimitConfigStore(db), counters: new MemoryCounterStore(), audit, events, log,
    knownModels: () => models.listAll().map((m) => m.ref), directory: apiKeys,
  });
  const requests = createRequestLogService({
    repo: createSqliteRequestRepository(db), models, log,
    retention: { get requestDays() { return settings.get('requestRetentionDays'); }, get usageDays() { return settings.get('usageRetentionDays'); } },
  });
  // Requests a previous process left in progress can never finish.
  requests.recoverInterrupted();
  const gateway = createGatewayService({ routing, providers, models, events, log, limits, requests });
  let liveHub: RealtimeHub | null = null;
  const healthHistory = createHealthHistoryService({ repo: createSqliteHealthHistoryRepository(db), log, get retentionDays() { return settings.get('healthHistoryDays'); } });
  const health = createHealthService({
    checks: [
      createPlatformCheck(), createDatabaseCheck(db), createProvidersCheck(providers),
      createGatewayCheck({
        metrics: () => gateway.metrics.snapshot(),
        models: () => {
          const all = models.listAll();
          return { registered: all.length, usable: all.filter((m) => m.usable).length };
        },
      }),
      // The live channel starts after the API app; until then (and after stop) it reports OFFLINE.
      createWebSocketCheck({ connections: () => liveHub?.size ?? null }),
    ],
    version,
    environment: config.env,
    events,
    log,
  });

  // Long-running work (spec §26): the handlers wire providers and health in.
  const operations = createOperationService({ repo: createSqliteOperationRepository(db), handlers: operationHandlers({ providers, health }), audit, events, log });
  operations.recoverInterrupted();

  const users = createSqliteUserRepository(db);
  const auth = createAuthService({
    users,
    sessions: createSqliteSessionRepository(db),
    hasher,
    audit,
    policy: {
      get idleMinutes() { return settings.get('sessionIdleMinutes'); },
      get maxHours() { return settings.get('sessionMaxHours'); },
      get maxFailures() { return settings.get('signInMaxFailures'); },
    },
    events,
    log,
    // Two-factor sign-in: after a correct password, a second step when the user has a method set up.
    secondStep: (user) => twoFactor.needsSecondStep(user.id),
  });
  const authz = createAuthorizationService({ roles: createSqliteRoleRepository(db), audit, events, log });
  const userAdmin = createUserAdminService({
    users, hasher, auth, audit, policy: userAccessPolicy(authz), events, log,
    twoFactor: { reset: (actor, userId, client) => twoFactor.reset(actor, userId, client), emailChanged: (userId) => twoFactor.emailChanged(userId) },
  });
  const mail = createMailService({ settings: createSqliteSettingsRepository(db), secrets, audit, events, log });
  const twoFactor = createTwoFactorService({
    db, users, hasher, secrets, settings: createSqliteSettingsRepository(db), mail, audit, events, log,
    isAdministrator: (userId) => authz.principalFor(userId).roles.includes('ADMIN'),
  });
  const keyRequests = createKeyRequestService({ db, apiKeys, directory: peopleDirectory(authz), audit, events, log });
  const notifications = createNotificationService({ repo: createSqliteNotificationRepository(db), events, log });
  const unsubscribeNotifications = notifications.subscribe(events);
  let setupToken: SetupToken | null = users.count() === 0 ? provisionSetupToken(config, log) : null;
  const setup = createSetupService({
    users,
    hasher,
    auth,
    audit,
    // A random value nobody knows when setup is not required: setup is closed.
    setupToken: setupToken?.value ?? crypto.randomUUID() + crypto.randomUUID(),
    log,
    grantAdministrator: (userId) => authz.grantInitialAdministrator(userId),
    onCompleted: () => {
      setupToken?.discard();
      setupToken = null;
    },
  });
  const purgeTimer = setInterval(() => {
    try {
      const removed = auth.purgeExpired();
      twoFactor.purgeExpired();
      const notes = notifications.purgeOld();
      const checks = providers.pruneHistory();
      const history = requests.prune();
      healthHistory.prune();
      operations.prune();
      if (removed || notes || checks || history.requests || history.usageRecords) {
        log.debug('housekeeping', { component: 'server', sessionsPurged: removed, notificationsPurged: notes, providerChecksPruned: checks, requestsPruned: history.requests, usageRecordsPruned: history.usageRecords });
      }
    } catch (error) {
      log.error('housekeeping failed', { component: 'server', error });
    }
  }, 60 * 60_000);
  purgeTimer.unref();

  // Background health checks, so health changes are noticed (and notified)
  // even when nobody has the console open. History arrives in phase 12.
  // Only scheduled checks are recorded, so history has a regular rhythm.
  const runHealth = () => void health.report().then((r) => healthHistory.record(r)).catch((error: unknown) => log.error('scheduled health check failed', { component: 'health', error }));
  runHealth();
  const healthTimer = setInterval(runHealth, config.health.intervalSeconds * 1000);
  healthTimer.unref();

  // Provider health monitor (spec §8 healthCheck). First run shortly after startup.
  const providerInterval = config.providers.healthIntervalSeconds * 1000;
  const checkProviders = () => void providers.checkAll().then(runHealth).catch((error: unknown) => log.error('provider health checks failed', { component: 'providers', error }));
  const providerKickoff = providerInterval ? setTimeout(checkProviders, 5_000) : null;
  const providerTimer = providerInterval ? setInterval(checkProviders, providerInterval) : null;
  providerKickoff?.unref();
  providerTimer?.unref();

  const api = createApiApp({ log, logBuffer, audit, health, healthHistory, auth, authz, userAdmin, settings, twoFactor, mail, notifications, providers, models, routing, apiKeys, keyRequests, gateway, limits, requests, operations, setup, cookie: { secure: config.auth.cookieSecure } });

  // The console's live channel (spec §25): session-authenticated, same-origin only.
  const realtime = createRealtimeHub({
    events, auth, authz, cookie: { secure: config.auth.cookieSecure }, metrics: () => gateway.metrics.snapshot(), log,
    blocked: (userId) => (twoFactor.setupRequired(userId) ? 'Set up two-factor sign-in first.' : null),
  });
  realtime.start();
  liveHub = realtime;

  const proxies = parseTrustedProxies(config.server.trustedProxies.join(',')).proxies;
  if (proxies.entries.length) log.info('trusting X-Forwarded-For from reverse proxies', { component: 'server', proxies: proxies.entries });
  const handle = (request: Request, srv: Server<SocketData>): Response | Promise<Response> | undefined => {
    if (new URL(request.url).pathname === REALTIME_PATH) {
      const check = realtime.authorize(request);
      if (!check.ok) return check.response;
      if (srv.upgrade(request, { data: check.data })) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }
    // Behind trusted proxies the client is in X-Forwarded-For; otherwise it is the socket peer.
    return api.handle(request, clientAddress(srv.requestIP(request)?.address ?? null, request.headers.get('x-forwarded-for'), proxies));
  };
  const serveConsole = config.console.enabled && consoleHtml !== undefined;

  const routes: Record<string, HTMLBundle | ((request: Request, srv: Server<SocketData>) => Response | Promise<Response> | undefined)> = { '/api/*': handle, '/v1/*': handle };
  // Every other path serves the console's single-page app (deep links work).
  // Production builds are served with the console's security headers; development keeps Bun's hot-reloading route.
  if (serveConsole) routes['/*'] = createConsoleAssets(consoleHtml, consoleDir ?? process.cwd(), { https: config.auth.cookieSecure }) ?? consoleHtml;

  const server = Bun.serve({
    hostname: config.server.host,
    port: config.server.port,
    // Bun closes idle connections after 10 s by default, which would cut off slow
    // model responses and streams. 255 s is Bun's maximum.
    idleTimeout: 255,
    development: config.env === 'development' && { hmr: true, console: false },
    routes,
    fetch: handle,
    websocket: {
      open: (ws) => realtime.open(ws),
      message: (ws, message) => realtime.message(ws, message),
      close: (ws) => realtime.close(ws),
      // Bun pings idle connections, so dead peers are noticed; clients also send pings.
      idleTimeout: 120,
      maxPayloadLength: 4096,
    },
    error(error) {
      log.error('unhandled server error', { component: 'server', error });
      return new Response('Internal Server Error', { status: 500 });
    },
  });

  const url = new URL(server.url.href);
  log.info('ClawRouter listening', { component: 'server', url: url.href, env: config.env, console: serveConsole, version });
  if (!config.auth.cookieSecure && !['127.0.0.1', 'localhost', '::1'].includes(config.server.host)) {
    log.warn('session cookies are not marked Secure; serve ClawRouter over HTTPS and set CLAWROUTER_COOKIE_SECURE=true', { component: 'server' });
  }

  let stopped = false;
  return {
    server, realtime, healthHistory, operations, db, events, health, auth, authz, notifications, providers, models, routing, apiKeys, gateway, limits, requests, setup, audit, api, url,
    get setupToken() {
      return setupToken;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(purgeTimer);
      clearInterval(healthTimer);
      realtime.stop();
      operations.stop();
      liveHub = null;
      if (providerKickoff) clearTimeout(providerKickoff);
      if (providerTimer) clearInterval(providerTimer);
      unsubscribeNotifications();
      unsubscribeModels();
      await server.stop();
      db.close();
      log.info('ClawRouter stopped', { component: 'server' });
    },
  };
}
