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

// SEC-003 (configuration export and import) and SEC-001: an imported configuration is
// untrusted input. It never touches the filesystem and every value goes through the
// owning service, so the outbound policy and the no-escalation rules apply to it too.

import { describe, expect, test } from 'bun:test';
import { PERMISSIONS, type ApiSuccess, type ConfigurationDocument, type ImportResult } from '@clawrouter/shared';
import { createHarness } from '../../support/harness.ts';

const data = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;
const actor = { id: 'u1', username: 'admin' };

async function exported(): Promise<ConfigurationDocument> {
  const h = createHarness();
  const admin = await h.completeSetup();
  await h.providers.create(actor, { name: 'Public', identifier: 'public', kind: 'openai_compatible', endpoint: 'https://api.example.test/v1', apiKey: 'sk-import-canary-0123456789' }, { ip: null });
  return data<ConfigurationDocument>(await h.request('/api/configuration/export', { cookie: admin }));
}

describe('configuration import', () => {
  test.each([
    'http://169.254.169.254/latest/meta-data',
    'https://metadata.google.internal/v1',
    'https://192.168.1.10/v1',
    'https://[::ffff:192.168.0.1]/v1',
    'http://api.example.test/v1',
  ])('a provider endpoint the outbound policy refuses (%s) is not created', async (endpoint) => {
    const doc = await exported();
    doc.providers[0]!.endpoint = endpoint;
    const t = createHarness();
    const admin = await t.completeSetup();
    const result = await data<ImportResult>(await t.request('/api/configuration/import', { method: 'POST', cookie: admin, json: doc }));
    expect(result.failed?.message ?? '').toMatch(/not allowed|endpoint/i);
    expect(t.providers.list()).toEqual([]);
  });

  test('an export never carries a stored secret', async () => {
    const doc = JSON.stringify(await exported());
    expect(doc).not.toContain('sk-import-canary');
    expect(doc).not.toMatch(/"(apiKey|password|secret|ciphertext)"/);
  });

  test('a role that would hold every permission cannot be imported (only Administrator may)', async () => {
    const doc = await exported();
    doc.roles.push({ name: 'Shadow admin', description: 'every permission', permissions: [...PERMISSIONS] });
    const t = createHarness();
    const admin = await t.completeSetup();
    const res = await t.request('/api/configuration/import', { method: 'POST', cookie: admin, json: doc });
    const failed = res.ok ? ((await res.json()) as ApiSuccess<ImportResult>).data.failed : { message: 'refused' };
    expect(failed).not.toBeNull();
    expect(t.authz.listRoles().map((r) => r.name)).not.toContain('Shadow admin');
  });

  // Granting permissions the importer lacks is covered in packages/api/test/configuration-api.test.ts
  // ("importing needs every permission it touches").
});
