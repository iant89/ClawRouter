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

// SEC-021 (with SEC-017): configuration imports. A full export with things changed goes through
// the sandbox, the preview and the import itself. The sandbox refuses with a list of problems or
// accepts a document that parses again to itself and carries no secret; a preview never changes
// anything; an import is applied as a whole or refused as a whole, never fails half-way with a 500,
// and the server works normally afterwards.

import { beforeAll, describe, expect, test } from 'bun:test';
import { parseDocument } from '@clawrouter/configuration';
import type { ApiSuccess, ConfigurationDocument } from '@clawrouter/shared';
import type { Harness } from '../../support/harness.ts';
import { actor, client, createHarness, data } from '../support.ts';
import { expectClientError, expectHandledResponse, forAll, hostileJsonText, mutate } from './fuzz.ts';

let seed: ConfigurationDocument;

/** A full export: a provider with a key, models, an alias, rate limits, a custom role, mail and settings. */
beforeAll(async () => {
  const h = createHarness();
  const admin = await h.completeSetup();
  const p = await h.providers.create(actor, { name: 'Public', identifier: 'public', kind: 'openai_compatible', endpoint: 'https://api.example.test/v1', apiKey: 'sk-import-fuzz-0123456789' }, client);
  h.models.create(actor, { providerId: p.id, providerModelId: 'chat-1', capabilities: ['CHAT', 'TOOL_USE'] }, client);
  h.models.create(actor, { providerId: p.id, providerModelId: 'embed-1', capabilities: ['EMBEDDINGS'] }, client);
  h.routing.update(actor, { version: h.routing.get().version, defaultPolicy: h.routing.get().defaultPolicy, aliases: [{ name: 'fast', description: 'line one\nline two', enabled: true, capabilities: [], targets: [{ modelRef: 'public/chat-1', priority: 0, weight: 1 }], policy: null }] }, client);
  h.authz.createRole(actor, { name: 'Auditors', description: '', permissions: ['audit.read', 'logs.read'] }, client);
  await h.request('/api/settings/mail', { method: 'PUT', cookie: admin, json: { host: 'smtp.example.test', port: 587, security: 'starttls', username: 'ada', from: 'cr@example.test', password: 'mail-fuzz-pass' } });
  await h.request('/api/settings', { method: 'PUT', cookie: admin, json: { values: { keyMaxLifetimeDays: 14 } } });
  seed = await data<ConfigurationDocument>(await h.request('/api/configuration/export', { cookie: admin }));
});

const SECRET = /sk-import-fuzz|mail-fuzz-pass|"(apiKey|password|secret)"/;

describe('the sandbox', () => {
  test('refuses with problems, or accepts a document that parses to itself and holds no secret', async () => {
    await forAll('config sandbox', 3000, (r) => mutate(r, seed), (doc) => {
      const out = expectClientError(() => parseDocument(doc));
      if (out instanceof Error) {
        const issues = (out as { details?: { issues?: unknown[] } }).details?.issues;
        expect(Array.isArray(issues) && issues.length > 0).toBe(true);
        return;
      }
      const text = JSON.stringify(out);
      expect(SECRET.test(text)).toBe(false);
      expect(JSON.stringify(parseDocument(JSON.parse(text)))).toBe(text);
    });
  });

  test('the seed is accepted (or the fuzzing above proves little)', () => {
    parseDocument(seed);
  });
});

describe('preview and import over HTTP', () => {
  let h: Harness;
  let admin: string;
  beforeAll(async () => {
    h = createHarness();
    admin = await h.completeSetup();
  });

  test('a preview answers and never changes anything', async () => {
    const exported = async () => JSON.stringify(await data<ConfigurationDocument>(await h.request('/api/configuration/export', { cookie: admin })));
    const before = await exported();
    await forAll('config preview', 500, (r) => (r.bool(0.85) ? JSON.stringify(mutate(r, seed)) : hostileJsonText(r, seed)), async (body) => {
      h.logs.length = 0;
      const res = await h.request('/api/configuration/import/preview', { method: 'POST', cookie: admin, body, headers: { 'content-type': 'application/json' } });
      await expectHandledResponse(res, h.logs);
    });
    expect(await exported()).toBe(before);
  }, 120_000);

  test('an import is applied whole or refused whole, and the server works afterwards', async () => {
    let applied = 0;
    await forAll('config import', 60, (r) => (r.bool(0.1) ? seed : mutate(r, seed, 1 + r.int(2))), async (doc) => {
      const t = createHarness();
      const cookie = await t.completeSetup();
      const exportOf = async () => (await t.request('/api/configuration/export', { cookie })).json() as Promise<ApiSuccess<ConfigurationDocument>>;
      const before = JSON.stringify((await exportOf()).data);
      t.logs.length = 0;
      const res = await t.request('/api/configuration/import', { method: 'POST', cookie, json: doc });
      await expectHandledResponse(res, t.logs);
      const after = (await exportOf()).data;
      if (res.status === 200) {
        applied += 1;
        // What was imported exports again as a document the sandbox accepts.
        parseDocument(after);
      } else {
        expect(res.status).toBe(400);
        expect(JSON.stringify(after)).toBe(before);
      }
      expect((await t.request('/api/providers', { cookie })).status).toBe(200);
    });
    expect(applied).toBeGreaterThan(5);
  }, 120_000);
});
