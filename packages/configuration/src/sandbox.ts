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

import { errors } from '@clawrouter/core';
import { EMAIL_PATTERN, addressOf } from '@clawrouter/mail';
import { upgradeSettings, validateRateLimits } from '@clawrouter/rate-limits';
import {
  ALIAS_NAME_PATTERN, CAPABILITIES, classifyConfigurationPath, CONFIGURATION_FORMAT, FAILOVER_POLICIES, IDENTIFIER_PATTERN, isPermission, isSettingKey, KEY_EXPIRY_MAX_HOURS,
  MAIL_SECURITY, PERMISSIONS, PROVIDER_KINDS, RATE_WINDOWS, REQUEST_LIMIT_RANGES, SETTING_DEFINITIONS, TWO_FACTOR_REQUIREMENTS,
  type ConfigurationDocument, type FieldIssue,
} from '@clawrouter/shared';

/**
 * SEC-017: the configuration import sandbox. An imported file is untrusted input,
 * so the whole document is checked here, before anything is applied: its schema
 * (every object has only known fields, every field the right type), ranges, URLs,
 * names, providers, rate limits, roles and permissions. A document with any problem
 * is refused as a whole, with every problem listed, and nothing changes.
 *
 * - Unknown fields are refused, not ignored. A field that holds a secret anywhere in
 *   ClawRouter (a provider `apiKey`, the mail `password`: SEC-016) is refused with
 *   its own message: secrets are never imported, they are entered in the console.
 * - No field is a filesystem path or a command, and nothing in an import is read
 *   from or written to disk or run: such fields are unknown and refused like any other.
 * - `__proto__`, `constructor` and `prototype` keys are refused anywhere.
 * - Privilege escalation is refused by the plan (`missingPermissions`), as before.
 *
 * The services check every value again when it is applied.
 */

/** Limits on the size of a document (a real export with thousands of models stays far below). */
export const IMPORT_LIMITS = { providers: 1_000, models: 100_000, roles: 500, aliases: 500, issues: 100 } as const;

type Field = Schema & { optional?: true };
type Schema =
  | { type: 'string'; max: number; min?: number; pattern?: RegExp; message?: string; nullable?: true; multiline?: true }
  | { type: 'integer' | 'number'; min?: number; max?: number; nullable?: true }
  | { type: 'boolean' }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'list'; of: Schema; max: number }
  | { type: 'object'; fields: Record<string, Field>; nullable?: true }
  | { type: 'map'; key: (k: string) => boolean; keyMessage: string; of: Schema };

const str = (max: number, extra: Partial<Extract<Schema, { type: 'string' }>> = {}): Schema => ({ type: 'string', max, ...extra });
const int = (min?: number, max?: number, nullable?: true): Schema => ({ type: 'integer', min, max, nullable });
const num = (min?: number, max?: number, nullable?: true): Schema => ({ type: 'number', min, max, nullable });
const bool: Schema = { type: 'boolean' };
const opt = (s: Schema): Field => ({ ...s, optional: true });
const obj = (fields: Record<string, Field>, nullable?: true): Schema => ({ type: 'object', fields, nullable });
const list = (of: Schema, max: number): Schema => ({ type: 'list', of, max });
const oneOf = (values: readonly string[]): Schema => ({ type: 'enum', values });

const policy = obj({ failover: oneOf(FAILOVER_POLICIES), maxAttempts: int(), retriesPerTarget: int() });
const rateLimitFields = {
  window: opt(oneOf(RATE_WINDOWS)), requests: opt(int(undefined, undefined, true)), tokens: opt(int(undefined, undefined, true)),
  bucket: opt(obj({ capacity: int(), refillAmount: int(), refillEverySeconds: int() }, true)),
};
const costFields = { hour: opt(num(undefined, undefined, true)), day: opt(num(undefined, undefined, true)), month: opt(num(undefined, undefined, true)) };
const modelRef = str(300);

/** The configuration document, field by field (`ConfigurationDocument` in shared). */
export const DOCUMENT_SCHEMA = obj({
  format: oneOf([CONFIGURATION_FORMAT]),
  formatVersion: int(1, 1),
  exportedAt: opt(str(40)),
  clawrouterVersion: opt(str(40)),
  providers: list(obj({
    identifier: str(63, { pattern: IDENTIFIER_PATTERN, message: 'must be 2–63 lowercase letters, digits or dashes, starting with a letter or digit' }),
    name: str(100, { min: 1 }),
    kind: oneOf(PROVIDER_KINDS),
    endpoint: str(2048, { min: 1 }),
    priority: opt(int(0, 10_000)),
    timeoutMs: opt(int(1_000, 600_000)),
    maxKeyLifetimeHours: opt(int(1, KEY_EXPIRY_MAX_HOURS, true)),
    enabled: opt(bool),
    hadApiKey: opt(bool),
  }), IMPORT_LIMITS.providers),
  models: list(obj({
    provider: str(63, { pattern: IDENTIFIER_PATTERN, message: 'must be a provider identifier' }),
    providerModelId: str(256, { min: 1, pattern: /^\S+$/, message: 'must be 1–256 characters without spaces' }),
    displayName: opt(str(200, { min: 1 })),
    capabilities: list(oneOf(CAPABILITIES), 50),
    contextLength: opt(int(1, undefined, true)),
    maxOutputTokens: opt(int(1, undefined, true)),
    enabled: opt(bool),
    cost: opt(obj({ inputPerMTok: num(0, 100_000, true), outputPerMTok: num(0, 100_000, true) }, true)),
    maxKeyLifetimeHours: opt(int(1, KEY_EXPIRY_MAX_HOURS, true)),
  }), IMPORT_LIMITS.models),
  routing: obj({
    defaultPolicy: policy,
    aliases: list(obj({
      name: str(64, { pattern: ALIAS_NAME_PATTERN, message: 'must be 1–64 letters, digits, dot, dash, colon or underscore, without "/"' }),
      description: opt(str(300, { multiline: true })),
      enabled: opt(bool),
      capabilities: opt(list(oneOf(CAPABILITIES), 50)),
      targets: list(obj({ modelRef, priority: int(), weight: int() }), 1_000),
      policy: opt({ ...policy, nullable: true } as Schema),
    }), IMPORT_LIMITS.aliases),
  }),
  rateLimits: obj({
    perKey: obj(rateLimitFields),
    perUser: obj(rateLimitFields),
    perModel: list(obj({ model: modelRef, ...rateLimitFields }), 10_000),
    global: obj({ ...rateLimitFields, maxConcurrent: opt(int(undefined, undefined, true)) }),
    invalidKeysPerIp: int(),
    costLimits: opt(obj({
      perKey: opt(obj(costFields)), perUser: opt(obj(costFields)), global: opt(obj(costFields)),
      perModel: opt(list(obj({ model: modelRef, ...costFields }), 10_000)),
      perProvider: opt(list(obj({ provider: str(63), ...costFields }), 10_000)),
      maxEstimatedCostPerRequest: opt(num(undefined, undefined, true)),
    })),
    requestLimits: opt(obj(Object.fromEntries(Object.keys(REQUEST_LIMIT_RANGES).map((k) => [k, opt(int(undefined, undefined, true))])))),
  }),
  roles: list(obj({
    name: str(64, { min: 1 }),
    description: opt(str(300, { multiline: true })),
    permissions: list(oneOf(PERMISSIONS), PERMISSIONS.length * 2),
  }), IMPORT_LIMITS.roles),
  settings: obj({
    system: { type: 'map', key: isSettingKey, keyMessage: 'is not a setting', of: int() },
    signIn: obj({ methods: obj({ totp: opt(bool), email: opt(bool) }), require: oneOf(TWO_FACTOR_REQUIREMENTS) }),
    mail: obj({
      enabled: bool,
      host: str(255, { pattern: /^$|^[A-Za-z0-9.-]{1,253}$|^\[[0-9a-fA-F:.]+\]$/, message: 'must be a host name or IP address' }),
      port: int(1, 65_535),
      security: oneOf(MAIL_SECURITY),
      username: str(320, { nullable: true }),
      from: str(300),
    }),
  }),
});

/** Keys that would reach an object's prototype if code ever copied them carelessly. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Control characters (NUL, escape, line breaks…); descriptions may hold line breaks and tabs. */
const CONTROL = /[\u0000-\u001f\u007f]/;
const CONTROL_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const describe = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v);

function check(value: unknown, schema: Schema, path: string, issues: FieldIssue[]): void {
  if (issues.length >= IMPORT_LIMITS.issues) return;
  const at = path || 'document';
  const issue = (message: string) => issues.push({ path: at, message });
  if (value === null && 'nullable' in schema && schema.nullable) return;
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return void issue(`must be text, not ${describe(value)}`);
      if (value.length > schema.max) return void issue(`must be at most ${schema.max} characters`);
      if (schema.min !== undefined && value.trim().length < schema.min) return void issue('must not be empty');
      if ((schema.multiline ? CONTROL_MULTILINE : CONTROL).test(value)) return void issue('must not contain control characters');
      if (schema.pattern && !schema.pattern.test(value)) issue(schema.message ?? 'has the wrong format');
      return;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return void issue(`must be a number, not ${describe(value)}`);
      if (schema.type === 'integer' && !Number.isInteger(value)) return void issue('must be a whole number');
      if ((schema.min !== undefined && value < schema.min) || (schema.max !== undefined && value > schema.max)) issue(`must be from ${schema.min ?? '-∞'} to ${schema.max ?? '∞'}`);
      return;
    }
    case 'boolean':
      if (typeof value !== 'boolean') issue(`must be true or false, not ${describe(value)}`);
      return;
    case 'enum':
      if (typeof value !== 'string' || !schema.values.includes(value)) issue(schema.values.length > 12 ? 'is not a known value' : `must be one of ${schema.values.join(', ')}`);
      return;
    case 'list': {
      if (!Array.isArray(value)) return void issue(`must be a list, not ${describe(value)}`);
      if (value.length > schema.max) return void issue(`must have at most ${schema.max} entries`);
      value.forEach((v, i) => check(v, schema.of, `${path}[${i}]`, issues));
      return;
    }
    case 'map':
    case 'object': {
      if (!isPlainObject(value)) return void issue(`must be an object, not ${describe(value)}`);
      for (const key of Object.keys(value)) {
        const child = path ? `${path}.${key}` : key;
        if (FORBIDDEN_KEYS.has(key)) { issues.push({ path: child, message: 'is not allowed' }); continue; }
        const cls = classifyConfigurationPath(child);
        if (cls === 'SECRET' || cls === 'SECURITY_CRITICAL') {
          issues.push({ path: child, message: 'is a secret: secrets are never imported (enter it in the console after the import)' });
          continue;
        }
        if (schema.type === 'map') {
          if (!schema.key(key)) issues.push({ path: child, message: schema.keyMessage });
          else check(value[key], schema.of, child, issues);
        } else if (!Object.hasOwn(schema.fields, key)) {
          issues.push({ path: child, message: 'is not a known field' });
        }
      }
      if (schema.type === 'object') {
        for (const [key, field] of Object.entries(schema.fields)) {
          const child = path ? `${path}.${key}` : key;
          if (value[key] === undefined) { if (!field.optional) issues.push({ path: child, message: 'is required' }); }
          else check(value[key], field, child, issues);
        }
      }
    }
  }
}

/** Duplicates within a list, compared by `keyOf` (case-insensitive). */
function duplicates<T>(items: T[], section: string, field: string, keyOf: (x: T) => string, issues: FieldIssue[]) {
  const seen = new Map<string, number>();
  items.forEach((x, i) => {
    const k = keyOf(x).toLowerCase();
    if (seen.has(k)) issues.push({ path: `${section}[${i}].${field}`, message: `is the same as ${section}[${seen.get(k)}]` });
    else seen.set(k, i);
  });
}

const prefixed = (prefix: string, list: FieldIssue[]) => list.map((i) => ({ path: `${prefix}.${i.path}`, message: i.message }));

/**
 * Parses an imported configuration document: refuses anything malformed (every
 * problem listed, at most `IMPORT_LIMITS.issues`), and returns the document with
 * rate limits in today's shape. Checks that need the server's state (model
 * references, names already taken) are in the configuration service's plan.
 */
export function parseDocument(value: unknown): ConfigurationDocument {
  if (!isPlainObject(value) || value.format !== CONFIGURATION_FORMAT) {
    throw errors.validation([{ path: 'format', message: `must be "${CONFIGURATION_FORMAT}": this is not a ClawRouter configuration export` }]);
  }
  if (value.formatVersion !== 1) throw errors.validation([{ path: 'formatVersion', message: 'must be 1 (a newer ClawRouter made this file)' }]);
  // Limits written before windows existed are upgraded first, as everywhere else.
  const doc: Record<string, unknown> = { ...value, ...(isPlainObject(value.rateLimits) ? { rateLimits: upgradeSettings(value.rateLimits) } : {}) };
  const issues: FieldIssue[] = [];
  check(doc, DOCUMENT_SCHEMA, '', issues);
  if (issues.length) throw errors.validation(issues);
  const d = doc as unknown as ConfigurationDocument;

  // Values: the rules the services apply, checked up front so nothing is half imported.
  duplicates(d.providers, 'providers', 'identifier', (p) => p.identifier, issues);
  duplicates(d.providers, 'providers', 'name', (p) => p.name.trim(), issues);
  duplicates(d.models, 'models', 'providerModelId', (m) => `${m.provider}/${m.providerModelId}`, issues);
  duplicates(d.roles, 'roles', 'name', (r) => r.name.trim(), issues);
  d.roles.forEach((r, i) => {
    const unique = new Set(r.permissions.filter(isPermission));
    if (!unique.size) issues.push({ path: `roles[${i}].permissions`, message: 'choose at least one permission' });
    if (unique.size === PERMISSIONS.length) issues.push({ path: `roles[${i}].permissions`, message: 'only the Administrator role may have every permission' });
  });
  issues.push(...prefixed('rateLimits', validateRateLimits(d.rateLimits)));
  for (const [key, v] of Object.entries(d.settings.system)) {
    const def = SETTING_DEFINITIONS[key as keyof typeof SETTING_DEFINITIONS];
    if (typeof v === 'number' && (v < def.min || v > def.max)) issues.push({ path: `settings.system.${key}`, message: `must be a whole number from ${def.min} to ${def.max}` });
  }
  const mail = d.settings.mail;
  if (mail.from && !EMAIL_PATTERN.test(addressOf(mail.from))) issues.push({ path: 'settings.mail.from', message: 'must be an email address, optionally as "Name <address>"' });
  if (mail.enabled && (!mail.host || !mail.from)) issues.push({ path: 'settings.mail.enabled', message: 'needs a host and a sender address' });
  const methods = d.settings.signIn.methods;
  if (d.settings.signIn.require !== 'off' && !methods.totp && !methods.email) issues.push({ path: 'settings.signIn.require', message: 'needs at least one allowed method' });
  if (issues.length) throw errors.validation(issues.slice(0, IMPORT_LIMITS.issues));
  return d;
}
