import { AppError, errors } from '@clawrouter/core';
import type { AuditService } from '@clawrouter/audit';
import type { AuthorizationService } from '@clawrouter/authorization';
import type { TwoFactorService } from '@clawrouter/authentication';
import type { MailService } from '@clawrouter/mail';
import type { ModelService } from '@clawrouter/models';
import type { ProviderService } from '@clawrouter/providers';
import type { RateLimitService } from '@clawrouter/rate-limits';
import type { RoutingService } from '@clawrouter/routing';
import type { SettingsService } from '@clawrouter/settings';
import {
  BUILT_IN_ROLE_IDS, CONFIGURATION_FORMAT, CONFIGURATION_SECTIONS, isSettingKey, type ConfigurationDocument, type ConfigurationSection,
  type ExportedModel, type ExportedProvider, type FieldIssue, type ImportChange, type ImportPlan, type ImportResult, type Permission,
} from '@clawrouter/shared';

export interface ConfigurationActor {
  id: string;
  username: string;
  permissions: ReadonlySet<string>;
}

type Client = { ip: string | null; userAgent?: string | null; requestId?: string | null };

/** What reading and changing each section needs. */
const READ: Record<ConfigurationSection, Permission> = {
  roles: 'roles.read', providers: 'providers.read', models: 'models.read', routing: 'routing.read', rateLimits: 'rate_limits.read', settings: 'settings.read',
};
const WRITE: Record<ConfigurationSection, Permission> = {
  roles: 'roles.write', providers: 'providers.write', models: 'models.write', routing: 'routing.write', rateLimits: 'rate_limits.write', settings: 'settings.write',
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Fields of `next` (among `keys`) that differ from `current`. */
const changedFields = (current: object, next: object, keys: string[]): string[] => {
  const a = current as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  return keys.filter((k) => b[k] !== undefined && !same(a[k], b[k]));
};
const sortCaps = <T extends { capabilities: string[] }>(m: T): T => ({ ...m, capabilities: [...m.capabilities].sort() });

export type ConfigurationService = ReturnType<typeof createConfigurationService>;

/**
 * Configuration export and import (phase 17). Import merges: it creates what is
 * missing and updates what differs, matched by provider identifier, model
 * reference and role name, and never deletes. Every change goes through the
 * owning service, so it is validated, audited and announced as usual.
 */
export function createConfigurationService(o: {
  providers: ProviderService;
  models: ModelService;
  routing: RoutingService;
  limits: RateLimitService;
  authz: AuthorizationService;
  settings: SettingsService;
  twoFactor: TwoFactorService;
  mail: MailService;
  audit: AuditService;
  version: string;
  /** Takes a backup before an import is applied; returns its location (null: none). */
  backup?: () => Promise<string | null>;
  now?: () => Date;
}) {
  const now = o.now ?? (() => new Date());

  function exportDocument(actor: ConfigurationActor, client: Client): ConfigurationDocument {
    const missing = CONFIGURATION_SECTIONS.map((s) => READ[s]).filter((p) => !actor.permissions.has(p));
    if (missing.length) throw new AppError('AUTHORIZATION_ERROR', `Exporting the configuration needs ${missing.join(', ')}.`, { details: { missingPermissions: missing } });
    const providers = o.providers.list();
    const routing = o.routing.get();
    const limits = o.limits.get();
    const mail = o.mail.get();
    const policy = o.twoFactor.policy();
    const doc: ConfigurationDocument = {
      format: CONFIGURATION_FORMAT, formatVersion: 1, exportedAt: now().toISOString(), clawrouterVersion: o.version,
      providers: providers.map((p) => ({
        identifier: p.identifier, name: p.name, kind: p.kind, endpoint: p.endpoint, priority: p.priority, timeoutMs: p.timeoutMs,
        maxKeyLifetimeHours: p.maxKeyLifetimeHours, enabled: p.enabled, hadApiKey: p.credential.configured,
      })),
      models: o.models.listAll().map((m) => ({
        provider: m.provider.identifier, providerModelId: m.providerModelId, displayName: m.displayName, capabilities: m.capabilities,
        contextLength: m.contextLength, maxOutputTokens: m.maxOutputTokens, enabled: m.enabled,
        cost: m.cost ? { inputPerMTok: m.cost.inputPerMTok, outputPerMTok: m.cost.outputPerMTok } : null, maxKeyLifetimeHours: m.maxKeyLifetimeHours,
      })),
      routing: { defaultPolicy: routing.defaultPolicy, aliases: routing.aliases },
      rateLimits: { perKey: limits.perKey, perUser: limits.perUser, perModel: limits.perModel, global: limits.global, invalidKeysPerIp: limits.invalidKeysPerIp },
      roles: o.authz.listRoles().filter((r) => !r.builtIn).map((r) => ({ name: r.name, description: r.description, permissions: r.permissions })),
      settings: {
        system: Object.fromEntries(o.settings.list().filter((s) => s.overridden).map((s) => [s.key, s.value])),
        signIn: { methods: policy.methods, require: policy.require },
        mail: { enabled: mail.enabled, host: mail.host, port: mail.port, security: mail.security, username: mail.username, from: mail.from },
      },
    };
    o.audit.record({
      action: 'CONFIGURATION_EXPORTED', result: 'SUCCESS', resource: 'configuration', actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null,
      metadata: { providers: doc.providers.length, models: doc.models.length, aliases: doc.routing.aliases.length, roles: doc.roles.length },
    });
    return doc;
  }

  /** What importing `doc` would change, section by section. Reads only. */
  function plan(actor: ConfigurationActor, doc: ConfigurationDocument): ImportPlan {
    const changes: ImportChange[] = [];
    const add = (c: ImportChange) => changes.push(c);

    const roles = new Map(o.authz.listRoles().map((r) => [r.name.toLowerCase(), r]));
    const builtInNames = new Set(o.authz.listRoles().filter((r) => (BUILT_IN_ROLE_IDS as readonly string[]).includes(r.id)).map((r) => r.name.toLowerCase()));
    for (const r of doc.roles) {
      const current = roles.get(r.name.toLowerCase());
      if (builtInNames.has(r.name.toLowerCase())) add({ section: 'roles', name: r.name, action: 'skipped', note: 'built-in roles are the same everywhere and cannot be changed' });
      else if (!current) add({ section: 'roles', name: r.name, action: 'create' });
      else {
        const fields = changedFields({ description: current.description, permissions: [...current.permissions].sort() }, { description: r.description, permissions: [...r.permissions].sort() }, ['description', 'permissions']);
        add({ section: 'roles', name: r.name, action: fields.length ? 'update' : 'unchanged', fields });
      }
    }

    const providers = new Map(o.providers.list().map((p) => [p.identifier, p]));
    for (const p of doc.providers) {
      const current = providers.get(p.identifier);
      const keyNote = p.hadApiKey ? 'enter its API key on the Providers page (keys are never exported)' : undefined;
      if (!current) {
        add({ section: 'providers', name: p.identifier, action: 'create', note: keyNote });
        continue;
      }
      if (current.kind !== p.kind) {
        add({ section: 'providers', name: p.identifier, action: 'skipped', note: `it is a ${current.kind} provider here and ${p.kind} in the file` });
        continue;
      }
      const fields = changedFields(current, p, ['name', 'endpoint', 'priority', 'timeoutMs', 'maxKeyLifetimeHours', 'enabled']);
      const hostMoves = fields.includes('endpoint') && current.credential.configured && new URL(p.endpoint).origin !== new URL(current.endpoint).origin;
      const kept = hostMoves ? fields.filter((f) => f !== 'endpoint') : fields;
      add({
        section: 'providers', name: p.identifier, action: kept.length ? 'update' : 'unchanged', fields: kept,
        note: hostMoves ? 'the endpoint moves to another host: change it on the Providers page, where the API key must be entered again' : undefined,
      });
    }

    const models = new Map(o.models.listAll().map((m) => [m.ref, m]));
    const knownProviders = new Set([...providers.keys(), ...doc.providers.map((p) => p.identifier)]);
    for (const m of doc.models) {
      const ref = `${m.provider}/${m.providerModelId}`;
      const current = models.get(ref);
      if (!knownProviders.has(m.provider)) add({ section: 'models', name: ref, action: 'skipped', note: `provider ${m.provider} is neither here nor in the file` });
      else if (!current) add({ section: 'models', name: ref, action: 'create' });
      else {
        const cur = sortCaps({ ...current, cost: current.cost ? { inputPerMTok: current.cost.inputPerMTok, outputPerMTok: current.cost.outputPerMTok } : null });
        const fields = changedFields(cur, sortCaps(m), ['displayName', 'capabilities', 'contextLength', 'maxOutputTokens', 'enabled', 'cost', 'maxKeyLifetimeHours']);
        add({ section: 'models', name: ref, action: fields.length ? 'update' : 'unchanged', fields });
      }
    }

    const routing = o.routing.get();
    const routingFields = changedFields({ defaultPolicy: routing.defaultPolicy, aliases: routing.aliases }, doc.routing, ['defaultPolicy', 'aliases']);
    add({ section: 'routing', name: 'routing', action: routingFields.length ? 'update' : 'unchanged', fields: routingFields });

    const limits = o.limits.get();
    const limitFields = changedFields(limits, doc.rateLimits, ['perKey', 'perUser', 'perModel', 'global', 'invalidKeysPerIp']);
    add({ section: 'rateLimits', name: 'rate limits', action: limitFields.length ? 'update' : 'unchanged', fields: limitFields });

    const values = new Map(o.settings.list().map((s) => [s.key, s.value]));
    const systemFields = Object.entries(doc.settings.system).filter(([k, v]) => isSettingKey(k) && values.get(k) !== v).map(([k]) => k);
    add({ section: 'settings', name: 'system settings', action: systemFields.length ? 'update' : 'unchanged', fields: systemFields });
    // The mail server before the sign-in policy: a policy that requires email codes needs it.
    const mail = o.mail.get();
    const mailFields = changedFields(mail, doc.settings.mail, ['enabled', 'host', 'port', 'security', 'username', 'from']);
    add({
      section: 'settings', name: 'mail server', action: mailFields.length ? 'update' : 'unchanged', fields: mailFields,
      note: mailFields.length && doc.settings.mail.username && !mail.passwordSet ? 'enter the mail server password in Settings (it is never exported)' : undefined,
    });
    const policy = o.twoFactor.policy();
    const signInFields = changedFields({ methods: policy.methods, require: policy.require }, doc.settings.signIn, ['methods', 'require']);
    add({ section: 'settings', name: 'two-factor sign-in', action: signInFields.length ? 'update' : 'unchanged', fields: signInFields });

    const counts = Object.fromEntries(CONFIGURATION_SECTIONS.map((s) => [s, { create: 0, update: 0, unchanged: 0, skipped: 0 }])) as ImportPlan['counts'];
    for (const c of changes) counts[c.section][c.action] += 1;
    const touched = new Set(changes.filter((c) => c.action === 'create' || c.action === 'update').map((c) => c.section));
    // Roles: also only permissions the importer holds (no escalation), as when creating them by hand.
    const needed = new Set<Permission>([...touched].map((s) => WRITE[s]));
    for (const r of doc.roles) if (changes.some((c) => c.section === 'roles' && c.name === r.name && (c.action === 'create' || c.action === 'update'))) for (const p of r.permissions) needed.add(p);
    return { changes, counts, missingPermissions: [...needed].filter((p) => !actor.permissions.has(p)).sort() };
  }

  async function apply(actor: ConfigurationActor, doc: ConfigurationDocument, client: Client): Promise<ImportResult> {
    const planned = plan(actor, doc);
    if (planned.missingPermissions.length) {
      throw new AppError('AUTHORIZATION_ERROR', `This import needs ${planned.missingPermissions.join(', ')}, which you do not hold.`, { details: { missingPermissions: planned.missingPermissions } });
    }
    const todo = planned.changes.filter((c) => c.action === 'create' || c.action === 'update');
    const backup = todo.length && o.backup ? await o.backup() : null;
    const who = { id: actor.id, username: actor.username };
    let failed: ImportResult['failed'] = null;

    for (const change of todo) {
      try {
        if (change.section === 'roles') {
          const r = doc.roles.find((x) => x.name === change.name)!;
          const existing = o.authz.listRoles().find((x) => x.name.toLowerCase() === r.name.toLowerCase());
          if (existing) o.authz.updateRole(actor, existing.id, { description: r.description, permissions: r.permissions }, client);
          else o.authz.createRole(actor, { name: r.name, description: r.description, permissions: r.permissions }, client);
        } else if (change.section === 'providers') {
          const p = doc.providers.find((x) => x.identifier === change.name)!;
          const existing = o.providers.list().find((x) => x.identifier === p.identifier);
          const body = { name: p.name, priority: p.priority, timeoutMs: p.timeoutMs, maxKeyLifetimeHours: p.maxKeyLifetimeHours, enabled: p.enabled };
          if (existing) await o.providers.update(who, existing.id, { ...body, ...(change.fields?.includes('endpoint') ? { endpoint: p.endpoint } : {}) }, client);
          else await o.providers.create(who, { ...body, identifier: p.identifier, kind: p.kind, endpoint: p.endpoint }, client);
        } else if (change.section === 'models') {
          const m = doc.models.find((x) => `${x.provider}/${x.providerModelId}` === change.name)!;
          const body = { displayName: m.displayName, capabilities: m.capabilities, contextLength: m.contextLength, maxOutputTokens: m.maxOutputTokens, enabled: m.enabled, cost: m.cost, maxKeyLifetimeHours: m.maxKeyLifetimeHours };
          const existing = o.models.listAll().find((x) => x.ref === change.name);
          if (existing) o.models.update(who, existing.id, body, client);
          else {
            const provider = o.providers.list().find((x) => x.identifier === m.provider)!;
            o.models.create(who, { ...body, providerId: provider.id, providerModelId: m.providerModelId }, client);
          }
        } else if (change.section === 'routing') {
          o.routing.update(who, { version: o.routing.get().version, ...doc.routing }, client);
        } else if (change.section === 'rateLimits') {
          o.limits.update(who, { version: o.limits.get().version, ...doc.rateLimits }, client);
        } else if (change.name === 'system settings') {
          o.settings.update(who, Object.fromEntries(Object.entries(doc.settings.system).filter(([k]) => isSettingKey(k))), client);
        } else if (change.name === 'two-factor sign-in') {
          o.twoFactor.updatePolicy(who, doc.settings.signIn, { ip: client.ip, userAgent: client.userAgent ?? null, requestId: client.requestId ?? null });
        } else if (change.name === 'mail server') {
          await o.mail.update(who, doc.settings.mail, client);
        }
      } catch (error) {
        const issues = (error as AppError).details?.issues as FieldIssue[] | undefined;
        const message = error instanceof AppError && error.expose ? `${error.message}${issues?.length ? ` ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}` : ''}` : 'unexpected error';
        failed = { change, message };
        break;
      }
    }
    o.audit.record({
      action: 'CONFIGURATION_IMPORTED', result: failed ? 'FAILURE' : 'SUCCESS', resource: 'configuration', actor: { id: actor.id, name: actor.username }, ip: client.ip, requestId: client.requestId ?? null,
      metadata: {
        exportedAt: doc.exportedAt, from: doc.clawrouterVersion, backup,
        ...Object.fromEntries(CONFIGURATION_SECTIONS.map((s) => [s, { create: planned.counts[s].create, update: planned.counts[s].update }])),
        ...(failed ? { failedAt: `${failed.change.section} ${failed.change.name}`, reason: failed.message } : {}),
      },
    });
    return { ...planned, backup, failed };
  }

  return { export: exportDocument, plan, apply, parse: parseDocument };
}

/** Checks the document's shape; the services check every value when it is applied. */
export function parseDocument(value: unknown): ConfigurationDocument {
  const doc = value as Partial<ConfigurationDocument> | null;
  const issues: FieldIssue[] = [];
  if (typeof doc !== 'object' || doc === null || doc.format !== CONFIGURATION_FORMAT) throw errors.validation([{ path: 'format', message: `must be "${CONFIGURATION_FORMAT}": this is not a ClawRouter configuration export` }]);
  if (doc.formatVersion !== 1) issues.push({ path: 'formatVersion', message: 'must be 1 (a newer ClawRouter made this file)' });
  const list = <T>(path: string, v: unknown, check: (x: T) => boolean) => {
    if (!Array.isArray(v)) return issues.push({ path, message: 'must be a list' });
    v.forEach((x, i) => { if (typeof x !== 'object' || x === null || !check(x as T)) issues.push({ path: `${path}[${i}]`, message: 'is incomplete' }); });
    return 0;
  };
  list<ExportedProvider>('providers', doc.providers, (p) => typeof p.identifier === 'string' && typeof p.kind === 'string' && typeof p.endpoint === 'string' && typeof p.name === 'string');
  list<ExportedModel>('models', doc.models, (m) => typeof m.provider === 'string' && typeof m.providerModelId === 'string' && Array.isArray(m.capabilities));
  list<{ name: string; permissions: string[] }>('roles', doc.roles, (r) => typeof r.name === 'string' && Array.isArray(r.permissions));
  if (typeof doc.routing !== 'object' || doc.routing === null || !Array.isArray(doc.routing.aliases)) issues.push({ path: 'routing', message: 'must have defaultPolicy and aliases' });
  if (typeof doc.rateLimits !== 'object' || doc.rateLimits === null) issues.push({ path: 'rateLimits', message: 'is missing' });
  const s = doc.settings;
  if (typeof s !== 'object' || s === null || typeof s.system !== 'object' || typeof s.signIn !== 'object' || typeof s.mail !== 'object') issues.push({ path: 'settings', message: 'must have system, signIn and mail' });
  if (issues.length) throw errors.validation(issues);
  return doc as ConfigurationDocument;
}
