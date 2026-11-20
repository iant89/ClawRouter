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

// SEC-016: configuration security classification. Every configuration value is classified
// (packages/shared/src/classification.ts), and SECRET / SECURITY_CRITICAL values are never
// logged, never in normal API answers, never through MCP, never in errors, never in exports.
// The second half plants such values in a real server and looks for them everywhere.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, createLogger, generateSecretKey, isSensitiveKey, loadConfig, parseSecretKey, type LogRecord } from '@clawrouter/core';
import {
  classifyConfigurationPath, CONFIGURATION_FIELD_CLASSIFICATION, CSRF_HEADER, ENVIRONMENT_CLASSIFICATION, isProtectedClass, SETTING_CLASSIFICATION, SETTING_KEYS,
  type ApiSuccess, type CreatedApiKey, type ProviderInfo, type TotpSetup,
} from '@clawrouter/shared';
import { startClawRouter, type ClawRouter } from '../../../apps/server/src/server.ts';
import { ADMIN, fastHasher } from '../../support/harness.ts';

const root = join(import.meta.dir, '..', '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'test' || name === 'node_modules' ? [] : sources(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('every configuration value is classified (SEC-016)', () => {
  test('every environment variable the server and its tools read, and nothing that no longer exists', () => {
    const files = [join(root, 'packages/core/src/config.ts'), ...sources(join(root, 'apps/server/src')), ...sources(join(root, 'scripts'))];
    const used = new Set(files.flatMap((f) => readFileSync(f, 'utf8').match(/\bCLAWROUTER_[A-Z0-9_]+\b/g) ?? []));
    const classified = Object.keys(ENVIRONMENT_CLASSIFICATION).filter((k) => k.startsWith('CLAWROUTER_'));
    expect([...used].filter((k) => !(k in ENVIRONMENT_CLASSIFICATION)).sort()).toEqual([]);
    expect(classified.filter((k) => !used.has(k)).sort()).toEqual([]);
  });

  test('settings are classified and never secrets', () => {
    expect(Object.keys(SETTING_CLASSIFICATION).sort()).toEqual([...SETTING_KEYS].sort());
    for (const c of Object.values(SETTING_CLASSIFICATION)) expect(isProtectedClass(c)).toBe(false);
  });

  test('the names of protected values are redacted by the logger wherever they appear', () => {
    const names = [
      ...Object.entries(ENVIRONMENT_CLASSIFICATION).filter(([, c]) => isProtectedClass(c)).map(([k]) => k),
      ...Object.entries(CONFIGURATION_FIELD_CLASSIFICATION).filter(([, c]) => isProtectedClass(c)).map(([k]) => k.split(/[.\]]/).pop()!),
    ];
    expect(names.length).toBeGreaterThan(5);
    for (const n of names) expect([n, isSensitiveKey(n)]).toEqual([n, true]);
  });

  test('path lookup: the longest classified prefix wins, unknown paths have no class', () => {
    expect(classifyConfigurationPath('providers[3].apiKey')).toBe('SECRET');
    expect(classifyConfigurationPath('providers[0].endpoint')).toBe('SENSITIVE');
    expect(classifyConfigurationPath('rateLimits.perModel[2].bucket.capacity')).toBe('SENSITIVE');
    expect(classifyConfigurationPath('settings.mail.password')).toBe('SECRET');
    expect(classifyConfigurationPath('providers[0].command')).toBeNull();
    expect(classifyConfigurationPath('backupPath')).toBeNull();
  });
});

describe('errors never carry protected configuration values (SEC-016)', () => {
  const key = generateSecretKey();
  const message = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return `${(e as Error).message} ${JSON.stringify((e as AppError).details ?? {})}`;
    }
    throw new Error('expected an error');
  };

  test('invalid environment values', () => {
    const token = 'tooshort-QX7Z';
    expect(message(() => loadConfig({ CLAWROUTER_ENV: 'test', CLAWROUTER_SETUP_TOKEN: token }))).not.toContain(token);
    const both = message(() => loadConfig({ CLAWROUTER_ENV: 'test', CLAWROUTER_SECRET_KEY: key, CLAWROUTER_SECRET_KEY_FILE: '/run/secrets/key' }));
    expect(both).toContain('CLAWROUTER_SECRET_KEY');
    expect(both).not.toContain(key);
  });

  test('a secret key that cannot be read', () => {
    const wrong = `${key.slice(0, -6)}QX7Z!!`;
    expect(message(() => parseSecretKey(wrong))).not.toContain(wrong);
  });
});

// ---------------------------------------------------------------------------------------------
// Planted values in a real server.

const SECRET_KEY = generateSecretKey();
const keyBytes = Buffer.from(SECRET_KEY, 'base64');
const CANARIES: Record<string, string> = {
  'secret key (base64)': SECRET_KEY,
  'secret key (hex)': keyBytes.toString('hex'),
  'secret key (base64url)': keyBytes.toString('base64url'),
  'setup token': 'setup-canary-QX7Z-0123456789abcdef',
  // Deliberately not secret-shaped: protection must not depend on pattern scrubbing.
  'provider API key': 'provkey-canary-QX7Z-0123456789',
  'mail password': 'mailpass-canary-QX7Z',
  'admin password': ADMIN.password,
};

describe('planted secrets never leave the server (SEC-016)', () => {
  let app: ClawRouter;
  let dir: string;
  let cookie = '';
  let apiKey = '';
  let providerId = '';
  let userId = '';
  const records: LogRecord[] = [];
  const answers: { what: string; text: string }[] = [];

  const url = (p: string) => new URL(p, app.url);
  const call = async (what: string, path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers: Record<string, string> = { cookie, origin: app.url.origin, [CSRF_HEADER]: '1', ...(init.headers as Record<string, string>) };
    if (init.json !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(url(path), { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
    const text = await res.text();
    answers.push({ what: `${what} (${res.status})`, text: text + JSON.stringify([...res.headers]) });
    return { res, text };
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'clawrouter-sec016-'));
    const config = loadConfig({
      CLAWROUTER_ENV: 'test', CLAWROUTER_PORT: '0', CLAWROUTER_DATABASE_PATH: join(dir, 'clawrouter.db'),
      CLAWROUTER_SECRET_KEY: SECRET_KEY, CLAWROUTER_SETUP_TOKEN: CANARIES['setup token'],
    });
    const log = createLogger({ level: 'debug', sink: (r) => records.push(r) });
    app = await startClawRouter({ config, log, version: 'test', hasher: fastHasher });

    const setup = await fetch(url('/api/setup'), { method: 'POST', headers: { 'content-type': 'application/json', origin: app.url.origin }, body: JSON.stringify({ setupToken: CANARIES['setup token'], ...ADMIN }) });
    expect(setup.status).toBe(201);
    cookie = setup.headers.getSetCookie()[0]!.split(';')[0]!;
    userId = ((await (await fetch(url('/api/auth/session'), { headers: { cookie } })).json()) as ApiSuccess<{ user: { id: string } }>).data.user.id;

    const provider = await call('create provider', '/api/providers', { method: 'POST', json: { name: 'Planted', identifier: 'planted', kind: 'openai_compatible', endpoint: 'https://api.example.test/v1', apiKey: CANARIES['provider API key'] } });
    expect(provider.res.status).toBe(201);
    providerId = (JSON.parse(provider.text) as ApiSuccess<ProviderInfo>).data.id;
    expect((await call('mail', '/api/settings/mail', { method: 'PUT', json: { host: 'smtp.example.test', port: 587, security: 'starttls', username: 'ada', from: 'ClawRouter <cr@example.test>', password: CANARIES['mail password'] } })).res.status).toBe(200);
    const totp = await call('totp', '/api/auth/2fa/totp', { method: 'POST' });
    CANARIES['authenticator secret'] = (JSON.parse(totp.text) as ApiSuccess<TotpSetup>).data.secret;
    expect((await call('settings', '/api/settings', { method: 'PUT', json: { values: { mcpEnabled: 1 } } })).res.status).toBe(200);
    apiKey = (JSON.parse((await call('key', '/api/api-keys', { method: 'POST', json: { name: 'agent', mcpAccess: true } })).text) as ApiSuccess<CreatedApiKey>).data.secret;
    // The creation answers above are the only places a secret is ever returned (write-once); forget them.
    answers.length = 0;
  });
  afterAll(async () => {
    await app?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const leaks = (texts: { what: string; text: string }[]) =>
    texts.flatMap(({ what, text }) => Object.entries(CANARIES).filter(([, v]) => text.includes(v)).map(([name]) => `${name} in ${what}`));

  test('every GET route of the console API, as an Administrator (exports included)', async () => {
    const routes = app.api.router.list().filter((r) => r.method === 'GET' && r.pattern.startsWith('/api/') && r.pattern !== '/api/ws');
    expect(routes.length).toBeGreaterThan(40);
    for (const r of routes) {
      const ids = r.pattern.includes(':') ? [providerId, userId] : [''];
      for (const id of ids) await call(r.pattern, r.pattern.replace(/:[a-zA-Z]+/g, id));
    }
    expect(answers.some((a) => a.what.startsWith('/api/configuration/export (200)'))).toBe(true);
    expect(answers.filter((a) => a.what.endsWith('(200)')).length).toBeGreaterThan(30);
    expect(leaks(answers)).toEqual([]);
  });

  test('the gateway API and every MCP tool, with an MCP key', async () => {
    const before = answers.length;
    await call('/v1/models', '/v1/models', { headers: { authorization: `Bearer ${apiKey}` } });
    const rpc = (body: unknown) => call('mcp', '/v1/mcp', { method: 'POST', json: body, headers: { authorization: `Bearer ${apiKey}` } });
    const list = JSON.parse((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).text) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.length).toBeGreaterThan(5);
    for (const [i, t] of list.result.tools.entries()) await rpc({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name: t.name, arguments: { providerId } } });
    expect(answers.length - before).toBeGreaterThan(list.result.tools.length);
    expect(leaks(answers.slice(before))).toEqual([]);
  });

  test('errors about protected values never repeat them', async () => {
    const before = answers.length;
    const bad = `${CANARIES['provider API key']} with spaces`;
    await call('bad provider key', `/api/providers/${providerId}/credential`, { method: 'PUT', json: { apiKey: bad } });
    await call('bad mail password', '/api/settings/mail', { method: 'PUT', json: { password: `${CANARIES['mail password']}\nline` } });
    await call('import with a key', '/api/configuration/import/preview', { method: 'POST', json: { format: 'clawrouter-configuration', formatVersion: 1, providers: [{ apiKey: CANARIES['provider API key'] }] } });
    await call('setup again', '/api/setup', { method: 'POST', json: { setupToken: CANARIES['setup token'], ...ADMIN } });
    for (const a of answers.slice(before)) expect(a.what).toMatch(/\((400|409|403)\)$/);
    expect(leaks(answers.slice(before)).filter((l) => !l.startsWith('admin password'))).toEqual([]);
    expect(answers.slice(before).some((a) => a.text.includes(bad))).toBe(false);
  });

  test('nothing above was logged, from startup to here', () => {
    expect(records.length).toBeGreaterThan(20);
    expect(leaks(records.map((r, i) => ({ what: `log record ${i} (${r.msg})`, text: JSON.stringify(r) })))).toEqual([]);
  });

  test('nor written into the audit trail', () => {
    const audit = app.db.all<{ metadata: string | null }>('SELECT metadata FROM audit_log');
    expect(audit.length).toBeGreaterThan(5);
    expect(leaks(audit.map((a, i) => ({ what: `audit record ${i}`, text: a.metadata ?? '' })))).toEqual([]);
  });
});
