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

// SEC-010: secret scrubbing. Every kind of secret in the roadmap, in every place one can
// hide (JSON, nested JSON, arrays, URLs, query parameters, headers, exceptions, stack traces,
// tool arguments, provider errors), through `redact` / `scrubSecrets` and through the real
// logger, audit log, error responses and gateway. Each secret has a unique "material" part
// that must never come out; what is not a secret must come out unchanged.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createLogger, isSensitiveKey, redact, REDACTED, scrubSecrets, type LogRecord } from '@clawrouter/core';
import { ProviderCallError } from '@clawrouter/providers';
import type { ApiSuccess, CreatedApiKey } from '@clawrouter/shared';
import { createHarness } from '../support/harness.ts';
import { startMockProviders, type MockProviders } from '../support/mock-providers.ts';

/** Deterministic random-looking text of `n` characters from `alphabet`. */
function material(seed: number, n: number, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'): string {
  let x = seed * 7919 + 17;
  let out = '';
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += alphabet[x % alphabet.length];
  }
  return out;
}
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

interface Secret {
  name: string;
  /** The part that must never appear in any output. */
  material: string;
  /** How the secret appears in free text (a log message, an error, a provider's answer). */
  text: string;
  /** A field name it is stored under in objects. */
  field: string;
  /** Its value under that field. */
  value: string;
}

const crk = material(1, 43, B64URL);
const pem = `${material(2, 64)}\n${material(3, 64)}\n${material(4, 20)}==`;
const jwtSig = material(5, 43, B64URL);
const smtpPassword = material(6, 18);
const sessionToken = material(7, 43, B64URL);
const setupToken = material(8, 32, B64URL);
const password = `correct-horse-${material(9, 10)}`;

const SECRETS: Secret[] = [
  { name: 'ClawRouter API key', material: crk, text: `key crk_0a1b2c3d_${crk} was rejected`, field: 'apiKey', value: `crk_0a1b2c3d_${crk}` },
  { name: 'OpenAI API key', material: material(10, 40), text: `Incorrect API key provided: sk-proj-${material(10, 40)}`, field: 'apiKey', value: `sk-proj-${material(10, 40)}` },
  { name: 'Anthropic API key', material: material(11, 60), text: `x-api-key sk-ant-api03-${material(11, 60)} invalid`, field: 'x-api-key', value: `sk-ant-api03-${material(11, 60)}` },
  { name: 'OpenRouter API key', material: material(12, 64, 'abcdef0123456789'), text: `key sk-or-v1-${material(12, 64, 'abcdef0123456789')} has no credit`, field: 'api_key', value: `sk-or-v1-${material(12, 64, 'abcdef0123456789')}` },
  { name: 'Groq API key', material: material(13, 52), text: `Invalid API Key gsk_${material(13, 52)}`, field: 'apiKey', value: `gsk_${material(13, 52)}` },
  { name: 'Google API key', material: material(14, 35, B64URL), text: `API key not valid: AIza${material(14, 35, B64URL)}.`, field: 'x-goog-api-key', value: `AIza${material(14, 35, B64URL)}` },
  { name: 'bearer token', material: material(15, 40), text: `sent Authorization: Bearer ${material(15, 40)} upstream`, field: 'authorization', value: `Bearer ${material(15, 40)}` },
  { name: 'cookie', material: sessionToken, text: `Cookie: clawrouter_session=${sessionToken}; theme=dark`, field: 'cookie', value: `clawrouter_session=${sessionToken}; theme=dark` },
  { name: 'password', material: password, text: `login rejected for password=${password}`, field: 'password', value: password },
  { name: 'provider credential', material: material(16, 30), text: `{"provider":"groq","credential":"${material(16, 30)}"}`, field: 'credential', value: material(16, 30) },
  { name: 'SMTP credentials (URL)', material: smtpPassword, text: `cannot reach smtp://mailer:${smtpPassword}@smtp.example.com:587`, field: 'smtpPassword', value: smtpPassword },
  { name: 'SMTP credentials (AUTH PLAIN)', material: Buffer.from(`\0mailer\0${smtpPassword}`).toString('base64'), text: `C: AUTH PLAIN ${Buffer.from(`\0mailer\0${smtpPassword}`).toString('base64')}`, field: 'pass', value: smtpPassword },
  { name: 'session id', material: sessionToken, text: `session=${sessionToken} expired`, field: 'sessionId', value: sessionToken },
  { name: 'setup token', material: setupToken, text: `{"setupToken":"${setupToken}"}`, field: 'setupToken', value: setupToken },
  { name: 'OAuth token (Google)', material: material(17, 60, B64URL), text: `refresh failed for ya29.${material(17, 60, B64URL)}`, field: 'access_token', value: `ya29.${material(17, 60, B64URL)}` },
  { name: 'OAuth token (GitHub)', material: material(18, 36), text: `token gho_${material(18, 36)} revoked`, field: 'refreshToken', value: `gho_${material(18, 36)}` },
  { name: 'private key', material: pem.split('\n')[0]!, text: `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`, field: 'privateKey', value: `-----BEGIN RSA PRIVATE KEY-----\n${pem}\n-----END RSA PRIVATE KEY-----` },
  { name: 'JWT', material: jwtSig, text: `id_token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.${jwtSig} rejected`, field: 'jwt', value: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.${jwtSig}` },
  { name: 'MCP credential', material: material(19, 43, B64URL), text: `MCP client sent Bearer crk_99aa88bb_${material(19, 43, B64URL)}`, field: 'authorization', value: `Bearer crk_99aa88bb_${material(19, 43, B64URL)}` },
];

/** Nothing of any secret's material is in `out`. */
function clean(out: unknown, s: Secret) {
  const text = typeof out === 'string' ? out : JSON.stringify(out);
  expect(text).not.toContain(s.material);
  return text;
}

describe('every secret, in every container (SEC-010)', () => {
  for (const s of SECRETS) {
    describe(s.name, () => {
      test('JSON: under its field name and as text in any field', () => {
        clean(redact({ [s.field]: s.value }), s);
        clean(redact({ detail: s.text }), s);
      });

      test('nested JSON', () => {
        clean(redact({ a: { b: { c: { [s.field]: s.value, note: s.text } } } }), s);
        clean(redact({ request: { headers: { [s.field]: s.value } } }), s);
      });

      test('arrays', () => {
        clean(redact([s.text, { [s.field]: s.value }, [[s.text]]]), s);
      });

      test('exceptions, causes and stack traces', () => {
        const error = new Error(`upstream call failed: ${s.text}`, { cause: new Error(s.text) });
        const out = redact({ error });
        const text = clean(out, s);
        expect(text).toContain('upstream call failed');
        const stack = `Error: ${s.text}\n    at call (/srv/clawrouter/packages/providers/src/http.ts:42:7)`;
        clean(scrubSecrets(stack), s);
        clean(redact(new AggregateError([new Error(s.text)], 'several failed')), s);
      });

      test('tool arguments (JSON text inside a string)', () => {
        const args = JSON.stringify({ [s.field]: s.value, city: 'Paris' });
        const text = clean(redact({ tool_calls: [{ function: { name: 'login', arguments: args } }] }), s);
        expect(text).toContain('Paris');
        clean(redact({ arguments: JSON.stringify({ note: s.text }) }), s);
      });

      test('provider errors', () => {
        const error = new ProviderCallError('auth', `The provider said: ${s.text}`, 401);
        clean(redact({ error }), s);
        clean(scrubSecrets(JSON.stringify({ error: { message: s.text, type: 'invalid_request_error' } })), s);
      });
    });
  }
});

describe('URLs and query parameters (SEC-010)', () => {
  const token = material(30, 32);
  const cases = [
    `https://generativelanguage.googleapis.com/v1beta/models?key=${token}`,
    `https://api.example.com/v1/chat?api_key=${token}&model=x`,
    `https://api.example.com/oauth/callback?code=${token}&state=abc`,
    `https://api.example.com/x?access_token=${token}`,
    `https://storage.example.com/file?X-Amz-Signature=${token}&sig=${token}`,
    `https://example.com/?token=${token}#top`,
    `https://example.com/login?username=ian&password=${token}`,
    `https://ian:${token}@proxy.example.com:8080/`,
    `postgres://clawrouter:${token}@db.internal:5432/clawrouter`,
    `smtp://mailer:${token}@smtp.example.com:465`,
  ];
  for (const url of cases) {
    test(url.replace(token, '…'), () => {
      expect(scrubSecrets(url)).not.toContain(token);
      expect(scrubSecrets(`fetch ${url} failed`)).not.toContain(token);
      expect(JSON.stringify(redact({ url: new URL(url) }))).not.toContain(token);
      expect(JSON.stringify(redact({ detail: url }))).not.toContain(token);
    });
  }

  test('what is not secret in a URL stays readable', () => {
    const out = scrubSecrets(`https://example.com/x?key=${token}&model=gpt-4o&page=2`);
    expect(out).toContain('https://example.com/x?key=');
    expect(out).toContain('model=gpt-4o&page=2');
  });
});

describe('headers (SEC-010)', () => {
  const value = material(31, 40);
  const names = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-goog-api-key', 'api-key', 'x-auth-token', 'x-clawrouter-csrf', 'x-setup-token'];
  for (const name of names) {
    test(name, () => {
      // A Headers object, a plain object, and header lines in text (a raw request in an error, say).
      expect(JSON.stringify(redact(new Headers({ [name]: value, 'content-type': 'application/json' })))).not.toContain(value);
      expect(JSON.stringify(redact({ headers: { [name]: value } }))).not.toContain(value);
      expect(scrubSecrets(`POST /v1/chat HTTP/1.1\r\n${name}: ${value}\r\nhost: x`)).not.toContain(value);
      expect(scrubSecrets(`${name.toUpperCase()}: ${value}`)).not.toContain(value);
    });
  }

  test('authorization schemes stay readable, credentials do not', () => {
    for (const scheme of ['Bearer', 'Basic', 'Token', 'Bot', 'ApiKey']) {
      const out = scrubSecrets(`Authorization: ${scheme} ${value}`);
      expect(out).toBe(`Authorization: ${scheme} ${REDACTED}`);
    }
    expect(scrubSecrets(`Authorization: ${value}`)).toBe(`Authorization: ${REDACTED}`);
    const headers = redact(new Headers({ 'content-type': 'application/json', authorization: `Bearer ${value}` })) as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
  });
});

describe('what is not a secret is left alone (SEC-010)', () => {
  test('token counts, session settings and ordinary words', () => {
    const fields = {
      inputTokens: 12, outputTokens: 4, maxTokens: 100, max_tokens: 100, prompt_tokens: 7, tokensPerMinute: 1000, reasoning_tokens: 3,
      sessionIdleMinutes: 15, sessionLifetimeHours: 12, sessions: 2, passage: 'A long passage', bypassCache: false, keyPrefix: 'crk_0a1b2c3d',
      model: 'gpt-4o-mini', requestId: 'req_01JABCDEF', message: 'The password policy requires 12 characters.',
    };
    expect(redact(fields)).toEqual(fields);
    for (const key of Object.keys(fields)) expect(isSensitiveKey(key)).toBe(false);
  });

  test('sensitive names are recognised in every spelling', () => {
    for (const key of ['password', 'Password', 'pass', 'smtpPass', 'passwd', 'newPassword', 'secret', 'clientSecret', 'client_secret', 'token', 'accessToken', 'refresh_token', 'setupToken', 'authorization', 'Proxy-Authorization', 'auth', 'cookie', 'Set-Cookie', 'sessionId', 'session_token', 'clawrouter_session', 'apiKey', 'api_key', 'x-api-key', 'X-Goog-Api-Key', 'credential', 'credentials', 'privateKey', 'private_key', 'jwt', 'recoveryCodes', 'connectionString', 'dsn']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  test('ordinary text and identifiers survive scrubbing', () => {
    for (const text of [
      'The model provider failed while streaming the response.',
      'request req_01JABCDEF on openai/gpt-4o-mini took 412 ms',
      'key crk_0a1b2c3d (ci) is over its limit',
      'https://api.openai.com/v1/chat/completions',
      'Bearer tokens are sent in the Authorization header.',
      '{"model":"gpt-4o","max_tokens":100,"messages":[{"role":"user","content":"Hi"}]}',
    ]) expect(scrubSecrets(text)).toBe(text);
  });
});

describe('through the real outputs (SEC-010)', () => {
  let mock: MockProviders;
  beforeAll(() => {
    mock = startMockProviders();
  });
  afterAll(() => mock.stop());

  test('the logger writes no secret, in fields, messages or errors', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', sink: (_r: LogRecord, line: string) => lines.push(line) });
    for (const s of SECRETS) {
      log.error(`failed: ${s.text}`, { [s.field]: s.value, detail: s.text, nested: [{ [s.field]: s.value }], error: new Error(s.text) });
      log.info('pretty', { url: `https://x.example/?key=${s.material}` });
    }
    const all = lines.join('\n');
    for (const s of SECRETS) expect(all).not.toContain(s.material);
  });

  test('audit metadata keeps no secret', async () => {
    const h = createHarness();
    for (const s of SECRETS) {
      h.audit.record({ action: 'SETTINGS_CHANGED', result: 'SUCCESS', resource: 'system', resourceId: s.name, actor: { id: null, name: 'test' }, ip: null, requestId: null, metadata: { [s.field]: s.value, note: s.text } });
    }
    const all = JSON.stringify(h.audit.list({ action: 'SETTINGS_CHANGED' }));
    for (const s of SECRETS) expect(all).not.toContain(s.material);
  });

  test('a provider error that echoes an unshaped key reaches neither the client, the history nor the logs', async () => {
    const h = createHarness();
    h.setProviderFetch(fetch);
    const admin = await h.completeSetup();
    // Not shaped like any known key: only the exact-value scrub can catch it.
    const providerKey = `plain-provider-key-${material(40, 20)}`;
    const p = await h.providers.create({ id: 'u', username: 'admin' }, { name: 'OpenAI', identifier: 'openai', kind: 'openai', endpoint: `${mock.url}/openai/v1`, apiKey: providerKey, priority: 10 }, { ip: null });
    h.models.create({ id: 'u', username: 'admin' }, { providerId: p.id, providerModelId: 'gpt-4o-mini', capabilities: ['CHAT'] }, { ip: null });
    const created = (await ((await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'ci' } })).json()) as ApiSuccess<CreatedApiKey>).data;
    const res = await h.request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${created.secret}` }, json: { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.text();
    expect(body).not.toContain(material(40, 20));
    expect(body).not.toContain(created.secret.slice(14));
    const history = JSON.stringify(h.requests.list({}).items.map((r) => h.requests.get(r.id)));
    expect(history).not.toContain(material(40, 20));
    expect(JSON.stringify(h.logs)).not.toContain(material(40, 20));
    expect(JSON.stringify(h.logs)).not.toContain(created.secret.slice(14));
  });

  test('an unexpected server error answers without the secret it was thrown with', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    // A session cookie and a CSRF header are credentials: neither may be echoed in logs.
    await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { requestRetentionDays: 'x' } } });
    const logs = JSON.stringify(h.logs);
    const token = admin.split('=')[1]!.split(';')[0]!;
    expect(logs).not.toContain(token);
  });
});
