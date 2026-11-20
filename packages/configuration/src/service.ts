/*
 * ClawRouter - Self-hosted AI gateway and control platform
 * https://github.com/iant89/ClawRouter
 *
 * Copyright (C) 2026 Ian Thomas
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * in the LICENSE file for more details.
 */

import { AppError, errors } from '@clawrouter/core';
import { validateRoutingConfig } from '@clawrouter/routing';
import { parseDocument } from './sandbox.ts';
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
  type FieldIssue, type ImportChange, type ImportPlan, type ImportResult, type Permission,
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
      rateLimits: {
        perKey: limits.perKey, perUser: limits.perUser, perModel: limits.perModel, global: limits.global, invalidKeysPerIp: limits.invalidKeysPerIp,
        costLimits: limits.costLimits, requestLimits: limits.requestLimits,
      },
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

  /**
   * SEC-017: the checks of the import sandbox that need this server's state. A
   * document that fails one is refused as a whole, before anything is applied.
   */
  function stateIssues(doc: ConfigurationDocument): FieldIssue[] {
    const issues: FieldIssue[] = [];
    // Every endpoint, against the URL rules and the outbound policy (SSRF), whether or not it would change.
    doc.providers.forEach((p, i) => issues.push(...o.providers.endpointIssues(p.endpoint, `providers[${i}].endpoint`)));
    // A provider name belongs to one provider: the file must not give it to another one here.
    const here = o.providers.list();
    doc.providers.forEach((p, i) => {
      const owner = here.find((x) => x.name.toLowerCase() === p.name.trim().toLowerCase());
      if (owner && owner.identifier !== p.identifier) issues.push({ path: `providers[${i}].name`, message: `is the name of provider ${owner.identifier} here` });
    });
    // Alias targets must be models that exist here or are created by this import.
    const knownProviders = new Set([...here.map((p) => p.identifier), ...doc.providers.map((p) => p.identifier)]);
    const refs = new Set([...o.models.listAll().map((m) => m.ref), ...doc.models.filter((m) => knownProviders.has(m.provider)).map((m) => `${m.provider}/${m.providerModelId}`)]);
    issues.push(...validateRoutingConfig(doc.routing, refs).map((i) => ({ path: `routing.${i.path}`, message: i.message })));
    // Email-only sign-in codes need the mail server this import leaves in place.
    const { signIn, mail } = doc.settings;
    if (signIn.require !== 'off' && !signIn.methods.totp && signIn.methods.email && !(mail.enabled && mail.host && mail.from)) {
      issues.push({ path: 'settings.signIn.require', message: 'email codes need a configured mail server; allow the authenticator app or include one' });
    }
    return issues;
  }

  /** What importing `doc` would change, section by section. Reads only. Refuses a document the server cannot take. */
  function plan(actor: ConfigurationActor, input: unknown): ImportPlan {
    // Always through the sandbox, also when called directly rather than through the API.
    const doc = parseDocument(input);
    const invalid = stateIssues(doc);
    if (invalid.length) throw errors.validation(invalid.slice(0, 100));
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
    const limitFields = changedFields(limits, doc.rateLimits, ['perKey', 'perUser', 'perModel', 'global', 'invalidKeysPerIp', 'costLimits', 'requestLimits']);
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
    // Changing an existing role also involves the permissions it has now (as updateRole checks).
    for (const r of doc.roles) {
      if (!changes.some((c) => c.section === 'roles' && c.name === r.name && (c.action === 'create' || c.action === 'update'))) continue;
      for (const p of r.permissions) needed.add(p);
      for (const p of roles.get(r.name.toLowerCase())?.permissions ?? []) needed.add(p);
    }
    return { changes, counts, missingPermissions: [...needed].filter((p) => !actor.permissions.has(p)).sort() };
  }

  async function apply(actor: ConfigurationActor, input: unknown, client: Client): Promise<ImportResult> {
    const doc = parseDocument(input);
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
          o.routing.update(who, { defaultPolicy: doc.routing.defaultPolicy, aliases: doc.routing.aliases, version: o.routing.get().version }, client);
        } else if (change.section === 'rateLimits') {
          const l = doc.rateLimits;
          o.limits.update(who, {
            perKey: l.perKey, perUser: l.perUser, perModel: l.perModel, global: l.global, invalidKeysPerIp: l.invalidKeysPerIp,
            ...(l.costLimits ? { costLimits: l.costLimits } : {}), ...(l.requestLimits ? { requestLimits: l.requestLimits } : {}), version: o.limits.get().version,
          }, client);
        } else if (change.name === 'system settings') {
          o.settings.update(who, Object.fromEntries(Object.entries(doc.settings.system).filter(([k]) => isSettingKey(k))), client);
        } else if (change.name === 'two-factor sign-in') {
          o.twoFactor.updatePolicy(who, { methods: doc.settings.signIn.methods, require: doc.settings.signIn.require }, { ip: client.ip, userAgent: client.userAgent ?? null, requestId: client.requestId ?? null });
        } else if (change.name === 'mail server') {
          // Only the exported fields: never a password, even if a caller skipped the sandbox.
          const { enabled, host, port, security, username, from } = doc.settings.mail;
          await o.mail.update(who, { enabled, host, port, security, username, from }, client);
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

