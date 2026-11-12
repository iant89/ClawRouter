/**
 * Test harness: a fully wired ClawRouter core (in-memory SQLite, real services,
 * fast password hashing, controllable clock) without a network socket.
 */
import { createApiApp, type ApiApp } from '@clawrouter/api';
import { createAuditService, createSqliteAuditRepository, type AuditService } from '@clawrouter/audit';
import {
  createArgon2Hasher, createAuthService, createSetupService, createSqliteSessionRepository, createSqliteUserRepository,
  type AuthService, type PasswordHasher, type SetupService, type UserRepository,
} from '@clawrouter/authentication';
import { createAuthorizationService, createSqliteRoleRepository, type AuthorizationService } from '@clawrouter/authorization';
import { createEventBus, createLogger, createSecretBox, generateSecretKey, parseSecretKey, type EventBus, type LogRecord, type SecretBox } from '@clawrouter/core';
import { createDefaultRegistry, createProviderService, createSqliteProviderRepository, type ProviderService } from '@clawrouter/providers';
import { createModelService, createSqliteModelRepository, type ModelService } from '@clawrouter/models';
import { createRoutingService, createSqliteRoutingStore, seededRandom, type RoutingService } from '@clawrouter/routing';
import { createApiKeyService, createGatewayService, type ApiKeyService, type GatewayService } from '@clawrouter/gateway';
import { createRateLimitService, createSqliteRateLimitConfigStore, MemoryCounterStore, type RateLimitService } from '@clawrouter/rate-limits';
import { createNotificationService, createSqliteNotificationRepository, type NotificationService } from '@clawrouter/notifications';
import { migrations, openSqlite, runMigrations, type Database } from '@clawrouter/database';
import { createDatabaseCheck, createHealthService, type HealthService } from '@clawrouter/health';
import { CSRF_HEADER } from '@clawrouter/shared';

/** Low-cost argon2id so tests stay fast. Never use these parameters in production. */
export const fastHasher: PasswordHasher = createArgon2Hasher({ memoryCost: 256, timeCost: 1 });

export const SETUP_TOKEN = 'test-setup-token-0123456789';
export const ADMIN = { username: 'admin', displayName: 'Ada Admin', password: 'correct horse battery staple' };

export class Clock {
  constructor(public time = new Date('2026-01-01T00:00:00Z').getTime()) {}
  now = () => new Date(this.time);
  advance(ms: number) {
    this.time += ms;
  }
}

export interface Harness {
  db: Database;
  clock: Clock;
  events: EventBus;
  users: UserRepository;
  audit: AuditService;
  auth: AuthService;
  authz: AuthorizationService;
  notifications: NotificationService;
  providers: ProviderService;
  models: ModelService;
  routing: RoutingService;
  apiKeys: ApiKeyService;
  gateway: GatewayService;
  limits: RateLimitService;
  secrets: SecretBox;
  /** Replaces the fetch used for provider calls. */
  setProviderFetch(fn: typeof fetch): void;
  setup: SetupService;
  health: HealthService;
  api: ApiApp;
  logs: LogRecord[];
  /** Sends a request through the full API pipeline. */
  request(path: string, init?: RequestInit & { json?: unknown; cookie?: string | null; csrf?: boolean; ip?: string }): Promise<Response>;
  /** Completes setup with ADMIN and returns the session cookie (`name=value`). */
  completeSetup(): Promise<string>;
  /** Signs in and returns the session cookie. */
  login(username?: string, password?: string): Promise<string>;
  /** Inserts an extra ACTIVE user directly (user management is phase 14), with optional roles. */
  addUser(username: string, roles?: string[], password?: string): Promise<{ id: string }>;
}

export function cookieFrom(response: Response): string {
  const header = response.headers.getSetCookie().find((c) => c.includes('clawrouter_session=') && !c.includes('Max-Age=0'));
  if (!header) throw new Error(`no session cookie in response (status ${response.status})`);
  return header.split(';')[0]!;
}

export function createHarness(options: { idleMinutes?: number; maxHours?: number; secureCookie?: boolean } = {}): Harness {
  const db = openSqlite({ path: ':memory:' });
  runMigrations(db, migrations);
  const clock = new Clock();
  const logs: LogRecord[] = [];
  const log = createLogger({ level: 'debug', sink: (r) => logs.push(r), now: clock.now });
  const events = createEventBus(log);
  const users = createSqliteUserRepository(db);
  const audit = createAuditService(createSqliteAuditRepository(db), log, clock.now);
  const auth = createAuthService({
    users,
    sessions: createSqliteSessionRepository(db),
    hasher: fastHasher,
    audit,
    policy: { idleMinutes: options.idleMinutes ?? 60, maxHours: options.maxHours ?? 12 },
    events,
    log,
    now: clock.now,
  });
  const authz = createAuthorizationService({ roles: createSqliteRoleRepository(db), audit, events, log, now: clock.now });
  const notifications = createNotificationService({ repo: createSqliteNotificationRepository(db), events, log, now: clock.now });
  notifications.subscribe(events);
  const setup = createSetupService({
    users, hasher: fastHasher, auth, audit, setupToken: SETUP_TOKEN, log, now: clock.now,
    grantAdministrator: (userId) => authz.grantInitialAdministrator(userId),
  });
  const secrets = createSecretBox(parseSecretKey(generateSecretKey()));
  let providerFetch: typeof fetch = (() => Promise.reject(new Error('no network in tests'))) as unknown as typeof fetch;
  const providers = createProviderService({
    repo: createSqliteProviderRepository(db), registry: createDefaultRegistry(), secrets, audit, events, log, now: clock.now,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => providerFetch(input, init)) as typeof fetch,
  });
  const models = createModelService({ repo: createSqliteModelRepository(db), providers, audit, events, log, now: clock.now });
  models.subscribe(events);
  // Seeded randomness: weighted routing choices are reproducible in tests.
  const routing = createRoutingService({ store: createSqliteRoutingStore(db), models, providers, audit, events, log, now: clock.now, random: seededRandom(42) });
  const apiKeys = createApiKeyService({ db, audit, log, now: clock.now });
  // No retry backoff in tests: they would only get slower.
  const limits = createRateLimitService({
    store: createSqliteRateLimitConfigStore(db), counters: new MemoryCounterStore(() => clock.now().getTime()), audit, events, log, now: clock.now,
    knownModels: () => models.listAll().map((m) => m.ref), directory: apiKeys,
  });
  const gateway = createGatewayService({ routing, providers, models, events, log, now: clock.now, backoffMs: 0, limits });
  const health = createHealthService({ checks: [createDatabaseCheck(db)], version: 'test', environment: 'test', now: clock.now });
  const api = createApiApp({ log, health, auth, authz, notifications, providers, models, routing, apiKeys, gateway, limits, setup, cookie: { secure: options.secureCookie ?? false } });

  const h: Harness = {
    db, clock, events, users, audit, auth, authz, notifications, providers, models, routing, apiKeys, gateway, limits, secrets, setup, health, api, logs,
    setProviderFetch(fn) {
      providerFetch = fn;
    },
    request(path, init = {}) {
      const { json, cookie, csrf = true, ip = '203.0.113.7', ...rest } = init;
      const headers = new Headers(rest.headers);
      if (json !== undefined) headers.set('content-type', 'application/json');
      if (cookie) headers.set('cookie', cookie);
      if (cookie && csrf) headers.set(CSRF_HEADER, '1');
      return api.handle(
        new Request(`http://clawrouter.test${path}`, { ...rest, headers, body: json === undefined ? rest.body : JSON.stringify(json) }),
        ip,
      );
    },
    async completeSetup() {
      const res = await h.request('/api/setup', { method: 'POST', json: { setupToken: SETUP_TOKEN, ...ADMIN } });
      return cookieFrom(res);
    },
    async addUser(username, roles = [], password = ADMIN.password) {
      const id = crypto.randomUUID();
      users.insert({ id, username, displayName: username, passwordHash: await fastHasher.hash(password), status: 'ACTIVE', now: clock.now().toISOString() });
      if (roles.length) createSqliteRoleRepository(db).setUserRoles(id, roles, clock.now().toISOString(), null);
      return { id };
    },
    async login(username = ADMIN.username, password = ADMIN.password) {
      const res = await h.request('/api/auth/login', { method: 'POST', json: { username, password } });
      return cookieFrom(res);
    },
  };
  return h;
}
