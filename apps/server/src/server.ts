import type { HTMLBundle, Server } from 'bun';
import { createApiApp, type ApiApp } from '@clawapi/api';
import { createAuditService, createSqliteAuditRepository, type AuditService } from '@clawapi/audit';
import {
  createArgon2Hasher, createAuthService, createSetupService, createSqliteSessionRepository, createSqliteUserRepository,
  type AuthService, type PasswordHasher, type SetupService,
} from '@clawapi/authentication';
import { createEventBus, type Config, type EventBus, type Logger } from '@clawapi/core';
import { migrations, openSqlite, runMigrations, type Database } from '@clawapi/database';
import { createDatabaseCheck, createHealthService, createPlatformCheck, type HealthService } from '@clawapi/health';
import { provisionSetupToken, type SetupToken } from './setup-token.ts';

export interface ClawApiOptions {
  config: Config;
  log: Logger;
  version: string;
  /** The console's HTML entry (Bun bundles it on the fly in development). Omit to run headless. */
  consoleHtml?: HTMLBundle;
  /** Override password hashing cost (tests). */
  hasher?: PasswordHasher;
}

export interface ClawApi {
  server: Server<undefined>;
  db: Database;
  events: EventBus;
  health: HealthService;
  auth: AuthService;
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
export async function startClawApi({ config, log, version, consoleHtml, hasher = createArgon2Hasher() }: ClawApiOptions): Promise<ClawApi> {
  const db = openSqlite({ path: config.database.path });
  try {
    runMigrations(db, migrations, log);
  } catch (error) {
    db.close();
    throw error;
  }

  const events = createEventBus(log);
  const health = createHealthService({
    checks: [createPlatformCheck(), createDatabaseCheck(db)],
    version,
    environment: config.env,
    events,
    log,
  });

  const audit = createAuditService(createSqliteAuditRepository(db), log);
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
  let setupToken: SetupToken | null = users.count() === 0 ? provisionSetupToken(config, log) : null;
  const setup = createSetupService({
    users,
    hasher,
    auth,
    audit,
    // A random value nobody knows when setup is not required: setup is closed.
    setupToken: setupToken?.value ?? crypto.randomUUID() + crypto.randomUUID(),
    log,
    onCompleted: () => {
      setupToken?.discard();
      setupToken = null;
    },
  });
  const purgeTimer = setInterval(() => {
    try {
      const removed = auth.purgeExpired();
      if (removed) log.debug('expired sessions purged', { component: 'auth', removed });
    } catch (error) {
      log.error('session purge failed', { component: 'auth', error });
    }
  }, 60 * 60_000);
  purgeTimer.unref();

  const api = createApiApp({ log, health, auth, setup, cookie: { secure: config.auth.cookieSecure } });

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
    server, db, events, health, auth, setup, audit, api, url,
    get setupToken() {
      return setupToken;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(purgeTimer);
      await server.stop();
      db.close();
      log.info('ClawAPI stopped', { component: 'server' });
    },
  };
}
