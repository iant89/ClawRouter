import type { HTMLBundle, Server } from 'bun';
import { createApiApp, type ApiApp } from '@clawapi/api';
import { createEventBus, type Config, type EventBus, type Logger } from '@clawapi/core';
import { migrations, openSqlite, runMigrations, type Database } from '@clawapi/database';
import { createDatabaseCheck, createHealthService, createPlatformCheck, type HealthService } from '@clawapi/health';

export interface ClawApiOptions {
  config: Config;
  log: Logger;
  version: string;
  /** The console's HTML entry (Bun bundles it on the fly in development). Omit to run headless. */
  consoleHtml?: HTMLBundle;
}

export interface ClawApi {
  server: Server<undefined>;
  db: Database;
  events: EventBus;
  health: HealthService;
  api: ApiApp;
  url: URL;
  stop(): Promise<void>;
}

/**
 * Composition root: wires configuration, persistence, domain services and the
 * HTTP layer together, then starts listening. Everything is created here and
 * passed down explicitly; no module-level singletons.
 */
export async function startClawApi({ config, log, version, consoleHtml }: ClawApiOptions): Promise<ClawApi> {
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
  const api = createApiApp({ log, health });

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
  if (config.env === 'production' && !['127.0.0.1', 'localhost', '::1'].includes(config.server.host)) {
    log.warn('authentication is not implemented yet (Phase 2); do not expose this server to untrusted networks', { component: 'server' });
  }

  let stopped = false;
  return {
    server, db, events, health, api, url,
    async stop() {
      if (stopped) return;
      stopped = true;
      await server.stop();
      db.close();
      log.info('ClawAPI stopped', { component: 'server' });
    },
  };
}
