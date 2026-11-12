import type { HTMLBundle, Server } from 'bun';
import { createApiApp, type ApiApp } from '@clawapi/api';
import { createAuditService, createSqliteAuditRepository, type AuditService } from '@clawapi/audit';
import {
  createArgon2Hasher, createAuthService, createSetupService, createSqliteSessionRepository, createSqliteUserRepository,
  type AuthService, type PasswordHasher, type SetupService,
} from '@clawapi/authentication';
import { createAuthorizationService, createSqliteRoleRepository, type AuthorizationService } from '@clawapi/authorization';
import { createEventBus, type Config, type EventBus, type Logger } from '@clawapi/core';
import { createNotificationService, createSqliteNotificationRepository, type NotificationService } from '@clawapi/notifications';
import { createDefaultRegistry, createProviderService, createSqliteProviderRepository, type ProviderService } from '@clawapi/providers';
import { createModelService, createSqliteModelRepository, type ModelService } from '@clawapi/models';
import { migrations, openSqlite, runMigrations, type Database } from '@clawapi/database';
import { createDatabaseCheck, createHealthService, createPlatformCheck, createProvidersCheck, type HealthService } from '@clawapi/health';
import { loadSecretBox } from './secret-key.ts';
import { provisionSetupToken, type SetupToken } from './setup-token.ts';

export interface ClawApiOptions {
  config: Config;
  log: Logger;
  version: string;
  /** The console's HTML entry (Bun bundles it on the fly in development). Omit to run headless. */
  consoleHtml?: HTMLBundle;
  /** Override password hashing cost (tests). */
  hasher?: PasswordHasher;
  /** Override the fetch used for provider calls (tests). */
  providerFetch?: typeof fetch;
}

export interface ClawApi {
  server: Server<undefined>;
  db: Database;
  events: EventBus;
  health: HealthService;
  auth: AuthService;
  authz: AuthorizationService;
  notifications: NotificationService;
  providers: ProviderService;
  models: ModelService;
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
export async function startClawApi({ config, log, version, consoleHtml, hasher = createArgon2Hasher(), providerFetch }: ClawApiOptions): Promise<ClawApi> {
  const db = openSqlite({ path: config.database.path });
  try {
    runMigrations(db, migrations, log);
  } catch (error) {
    db.close();
    throw error;
  }

  const events = createEventBus(log);
  const audit = createAuditService(createSqliteAuditRepository(db), log);
  const secrets = loadSecretBox(config, log);
  const providers = createProviderService({
    repo: createSqliteProviderRepository(db), registry: createDefaultRegistry(), secrets, audit, events, log, fetch: providerFetch,
  });
  const models = createModelService({ repo: createSqliteModelRepository(db), providers, audit, events, log });
  const unsubscribeModels = models.subscribe(events);
  const health = createHealthService({
    checks: [createPlatformCheck(), createDatabaseCheck(db), createProvidersCheck(providers)],
    version,
    environment: config.env,
    events,
    log,
  });

  const users = createSqliteUserRepository(db);
  const auth = createAuthService({
    users,
    sessions: createSqliteSessionRepository(db),
    hasher,
    audit,
    policy: { idleMinutes: config.auth.sessionIdleMinutes, maxHours: config.auth.sessionMaxHours },
    events,
    log,
  });
  const authz = createAuthorizationService({ roles: createSqliteRoleRepository(db), audit, events, log });
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
      const notes = notifications.purgeOld();
      const checks = providers.pruneHistory();
      if (removed || notes || checks) log.debug('housekeeping', { component: 'server', sessionsPurged: removed, notificationsPurged: notes, providerChecksPruned: checks });
    } catch (error) {
      log.error('housekeeping failed', { component: 'server', error });
    }
  }, 60 * 60_000);
  purgeTimer.unref();

  // Background health checks, so health changes are noticed (and notified)
  // even when nobody has the console open. History arrives in phase 12.
  const runHealth = () => void health.report().catch((error: unknown) => log.error('scheduled health check failed', { component: 'health', error }));
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

  const api = createApiApp({ log, health, auth, authz, notifications, providers, models, setup, cookie: { secure: config.auth.cookieSecure } });

  const handle = (request: Request, srv: Server<undefined>) => api.handle(request, srv.requestIP(request)?.address ?? null);
  const serveConsole = config.console.enabled && consoleHtml !== undefined;

  const routes: Record<string, HTMLBundle | typeof handle> = { '/api/*': handle, '/v1/*': handle };
  // Every other path serves the console's single-page app (deep links work).
  if (serveConsole) routes['/*'] = consoleHtml;

  const server = Bun.serve({
    hostname: config.server.host,
    port: config.server.port,
    development: config.env === 'development' && { hmr: true, console: false },
    routes,
    fetch: handle,
    error(error) {
      log.error('unhandled server error', { component: 'server', error });
      return new Response('Internal Server Error', { status: 500 });
    },
  });

  const url = new URL(server.url.href);
  log.info('ClawAPI listening', { component: 'server', url: url.href, env: config.env, console: serveConsole, version });
  if (!config.auth.cookieSecure && !['127.0.0.1', 'localhost', '::1'].includes(config.server.host)) {
    log.warn('session cookies are not marked Secure; serve ClawAPI over HTTPS and set CLAWAPI_COOKIE_SECURE=true', { component: 'server' });
  }

  let stopped = false;
  return {
    server, db, events, health, auth, authz, notifications, providers, models, setup, audit, api, url,
    get setupToken() {
      return setupToken;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(purgeTimer);
      clearInterval(healthTimer);
      if (providerKickoff) clearTimeout(providerKickoff);
      if (providerTimer) clearInterval(providerTimer);
      unsubscribeNotifications();
      unsubscribeModels();
      await server.stop();
      db.close();
      log.info('ClawAPI stopped', { component: 'server' });
    },
  };
}
