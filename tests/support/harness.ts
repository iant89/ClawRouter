/**
 * Test harness: a fully wired ClawRouter core (in-memory SQLite, real services,
 * fast password hashing, controllable clock) without a network socket.
 */
import { createOperationService, createSqliteOperationRepository, type OperationService } from '@clawrouter/operations';
import { operationHandlers } from '../../apps/server/src/operation-handlers.ts';
import { createApiApp, type ApiApp } from '@clawrouter/api';
import { createAuditService, createSqliteAuditRepository, type AuditService } from '@clawrouter/audit';
import {
  createArgon2Hasher, createAuthService, createSetupService, createSqliteSessionRepository, createSqliteUserRepository, createTwoFactorService, createUserAdminService,
  type AuthService, type PasswordHasher, type SetupService, type TwoFactorService, type UserAdminService, type UserRepository,
} from '@clawrouter/authentication';
import { createAuthorizationService, createSqliteRoleRepository, peopleDirectory, userAccessPolicy, type AuthorizationService } from '@clawrouter/authorization';
import { createEventBus, createLogger, createSecretBox, generateSecretKey, LogBuffer, parseSecretKey, type EventBus, type LogRecord, type SecretBox } from '@clawrouter/core';
import { createDefaultRegistry, createProviderService, createSqliteProviderRepository, type ProviderService } from '@clawrouter/providers';
import { createModelService, createSqliteModelRepository, type ModelService } from '@clawrouter/models';
import { createRoutingService, createSqliteRoutingStore, seededRandom, type RoutingService } from '@clawrouter/routing';
import { createApiKeyService, createGatewayService, createKeyRequestService, type ApiKeyService, type GatewayService, type KeyRequestService } from '@clawrouter/gateway';
import { createRateLimitService, createSqliteRateLimitConfigStore, MemoryCounterStore, type RateLimitService } from '@clawrouter/rate-limits';
import { createRequestLogService, createSqliteRequestRepository, type RequestLogService } from '@clawrouter/requests';
import { createNotificationService, createSqliteNotificationRepository, type NotificationService } from '@clawrouter/notifications';
import { createSqliteSettingsRepository, migrations, openSqlite, runMigrations, type Database } from '@clawrouter/database';
import { createSettingsService, type SettingsService } from '@clawrouter/settings';
import { createMailService, type MailService } from '@clawrouter/mail';
import {
  createDatabaseCheck, createGatewayCheck, createHealthHistoryService, createHealthService, createSqliteHealthHistoryRepository,
  type HealthHistoryService, type HealthService,
} from '@clawrouter/health';
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
  userAdmin: UserAdminService;
  settings: SettingsService;
  twoFactor: TwoFactorService;
  mail: MailService;
  /** Messages "sent" by the mail service. */
  outbox: { to: string; subject: string; text: string }[];
  notifications: NotificationService;
  providers: ProviderService;
  models: ModelService;
  routing: RoutingService;
  apiKeys: ApiKeyService;
  keyRequests: KeyRequestService;
  gateway: GatewayService;
  limits: RateLimitService;
  requests: RequestLogService;
  secrets: SecretBox;
  /** Replaces the fetch used for provider calls. */
  setProviderFetch(fn: typeof fetch): void;
  setup: SetupService;
  health: HealthService;
  healthHistory: HealthHistoryService;
  operations: OperationService;
  api: ApiApp;
  logs: LogRecord[];
  logBuffer: LogBuffer;
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
  const logBuffer = new LogBuffer(2000);
  const log = createLogger({ level: 'debug', sink: (r) => logs.push(r), tap: logBuffer.push, now: clock.now });
  const events = createEventBus(log);
  const users = createSqliteUserRepository(db);
  const audit = createAuditService(createSqliteAuditRepository(db), log, clock.now);
  const settings = createSettingsService({
    repo: createSqliteSettingsRepository(db, clock.now), audit, events, log,
    defaults: { sessionIdleMinutes: options.idleMinutes ?? 60, sessionMaxHours: options.maxHours ?? 12, signInMaxFailures: 10, requestRetentionDays: 30, usageRetentionDays: 400, healthHistoryDays: 7 },
  });
  const auth = createAuthService({
    users,
    sessions: createSqliteSessionRepository(db),
    hasher: fastHasher,
    audit,
    policy: { get idleMinutes() { return settings.get('sessionIdleMinutes'); }, get maxHours() { return settings.get('sessionMaxHours'); }, get maxFailures() { return settings.get('signInMaxFailures'); } },
    secondStep: (user) => twoFactor.needsSecondStep(user.id),
    events,
    log,
    now: clock.now,
  });
  const authz = createAuthorizationService({ roles: createSqliteRoleRepository(db), audit, events, log, now: clock.now });
  const userAdmin = createUserAdminService({
    users, hasher: fastHasher, auth, audit, policy: userAccessPolicy(authz), events, log, now: clock.now,
    twoFactor: { reset: (actor, userId, client) => twoFactor.reset(actor, userId, client), emailChanged: (userId) => twoFactor.emailChanged(userId) },
  });
  const notifications = createNotificationService({ repo: createSqliteNotificationRepository(db), events, log, now: clock.now });
  notifications.subscribe(events);
  const setup = createSetupService({
    users, hasher: fastHasher, auth, audit, setupToken: SETUP_TOKEN, log, now: clock.now,
    grantAdministrator: (userId) => authz.grantInitialAdministrator(userId),
  });
  const secrets = createSecretBox(parseSecretKey(generateSecretKey()));
  // Mail goes to an in-memory outbox (h.outbox); configure the server through /api/settings/mail as usual.
  const outbox: { to: string; subject: string; text: string }[] = [];
  const mail = createMailService({ settings: createSqliteSettingsRepository(db, clock.now), secrets, audit, events, log, send: async (_cfg, message) => { outbox.push(message); } });
  const twoFactor = createTwoFactorService({
    db, users, hasher: fastHasher, secrets, settings: createSqliteSettingsRepository(db, clock.now), mail, audit, events, log, now: clock.now,
    isAdministrator: (userId) => authz.principalFor(userId).roles.includes('ADMIN'),
  });
  let providerFetch: typeof fetch = (() => Promise.reject(new Error('no network in tests'))) as unknown as typeof fetch;
  const providers = createProviderService({
    repo: createSqliteProviderRepository(db), registry: createDefaultRegistry(), secrets, audit, events, log, now: clock.now,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => providerFetch(input, init)) as typeof fetch,
  });
  const models = createModelService({ repo: createSqliteModelRepository(db), providers, audit, events, log, now: clock.now });
  models.subscribe(events);
  // Seeded randomness: weighted routing choices are reproducible in tests.
  const routing = createRoutingService({ store: createSqliteRoutingStore(db), models, providers, audit, events, log, now: clock.now, random: seededRandom(42) });
  const apiKeys = createApiKeyService({ db, audit, log, now: clock.now, catalog: () => ({ models: models.listAll(), aliases: routing.get().aliases }) });
  const keyRequests = createKeyRequestService({ db, apiKeys, directory: peopleDirectory(authz), audit, events, log, now: clock.now });
  // No retry backoff in tests: they would only get slower.
  const limits = createRateLimitService({
    store: createSqliteRateLimitConfigStore(db), counters: new MemoryCounterStore(() => clock.now().getTime()), audit, events, log, now: clock.now,
    knownModels: () => models.listAll().map((m) => m.ref), directory: apiKeys,
  });
  const requests = createRequestLogService({
    repo: createSqliteRequestRepository(db), models, log, now: clock.now,
    retention: { get requestDays() { return settings.get('requestRetentionDays'); }, get usageDays() { return settings.get('usageRetentionDays'); } },
  });
  const gateway = createGatewayService({ routing, providers, models, events, log, now: clock.now, backoffMs: 0, limits, requests });
  const health = createHealthService({
    checks: [
      createDatabaseCheck(db),
      createGatewayCheck({ metrics: () => gateway.metrics.snapshot(), models: () => ({ registered: models.listAll().length, usable: models.listAll().filter((m) => m.usable).length }) }),
    ],
    version: 'test', environment: 'test', now: clock.now,
  });
  const healthHistory = createHealthHistoryService({ repo: createSqliteHealthHistoryRepository(db), now: clock.now });
  const operations = createOperationService({ repo: createSqliteOperationRepository(db), handlers: operationHandlers({ providers, health }), audit, events, log, now: clock.now });
  const api = createApiApp({ log, logBuffer, audit, health, healthHistory, auth, authz, userAdmin, settings, twoFactor, mail, notifications, providers, models, routing, apiKeys, keyRequests, gateway, limits, requests, operations, setup, cookie: { secure: options.secureCookie ?? false } });

  const h: Harness = {
    db, clock, events, users, audit, auth, authz, userAdmin, settings, twoFactor, mail, outbox, notifications, providers, models, routing, apiKeys, keyRequests, gateway, limits, requests, secrets, setup, health, healthHistory, operations, api, logs, logBuffer,
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
