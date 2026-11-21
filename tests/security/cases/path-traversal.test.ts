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

// SEC-027 corpus: reading files outside what ClawRouter means to serve.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HTMLBundle } from 'bun';
import { createConsoleAssets } from '../../../apps/server/src/console-assets.ts';
import { createHarness } from '../support.ts';

const root = mkdtempSync(join(tmpdir(), 'clawrouter-traversal-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const dir = join(root, 'dist');
mkdirSync(dir);
writeFileSync(join(root, 'secret.key'), 'TRAVERSAL-CANARY');
writeFileSync(join(dir, 'index.html'), '<!doctype html><title>ClawRouter</title>');
writeFileSync(join(dir, 'app-abc.js'), 'console.log(1)');
const bundle = {
  index: './index.html',
  files: [
    { path: './index.html', loader: 'html', isEntry: true, headers: { etag: '"page"', 'content-type': 'text/html;charset=utf-8' } },
    { path: './app-abc.js', loader: 'js', isEntry: false, headers: { etag: '"app"', 'content-type': 'text/javascript;charset=utf-8' } },
  ],
} as unknown as HTMLBundle;

describe('path traversal', () => {
  test.each([
    '/../secret.key', '/%2e%2e/secret.key', '/..%2fsecret.key', '/%2e%2e%2fsecret.key', '/app-abc.js/../../secret.key',
    '/..%5csecret.key', '/%252e%252e/secret.key', '/....//secret.key', '/./../secret.key', '/%c0%ae%c0%ae/secret.key',
  ])('CASE-008: %s never serves a file outside the bundle', async (path) => {
    const serve = createConsoleAssets(bundle, dir, { https: false })!;
    // Bun normalizes the URL; the server never maps a path to a file name, it looks it up in the bundle.
    const res = await serve(new Request(`http://localhost${path}`));
    expect(await res.text()).not.toContain('TRAVERSAL-CANARY');
  });

  test('CASE-009: an imported provider identifier cannot be a path', async () => {
    const h = createHarness();
    const admin = await h.completeSetup();
    const exported = ((await (await h.request('/api/configuration/export', { cookie: admin })).json()) as { data: Record<string, unknown> }).data;
    for (const identifier of ['../../etc', 'a/b', '..', 'a\\b']) {
      const doc = { ...exported, providers: [{ name: 'p', identifier, kind: 'openai_compatible', endpoint: 'https://api.example.test/v1', enabled: true, priority: 100, timeoutMs: 30000, maxKeyLifetimeHours: null }] };
      const res = await h.request('/api/configuration/import', { method: 'POST', cookie: admin, json: doc });
      expect([identifier, res.status]).toEqual([identifier, 400]);
    }
    expect(h.providers.list()).toEqual([]);
  });
});
