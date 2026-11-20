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

// SEC-027 corpus: server-side request forgery through provider endpoints.

import { describe, expect, test } from 'bun:test';
import type { ApiSuccess } from '@clawrouter/shared';
import { createOutboundGuard, createOutboundPolicy, OutboundBlockedError, staticResolver } from '@clawrouter/security';
import { createHarness } from '../support.ts';

const recorder = () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => { calls.push(String(input)); return new Response('{}'); }) as typeof fetch;
  return { calls, fetchImpl };
};

describe('ssrf', () => {
  test.each([
    'https://169.254.169.254/latest/meta-data/iam/security-credentials/', 'https://metadata.google.internal/computeMetadata/v1/',
    'https://10.0.0.1/v1', 'https://192.168.1.1/v1', 'https://[::1]/v1', 'https://2130706433/v1', 'https://[::ffff:127.0.0.1]/v1', 'file:///etc/passwd',
  ])('CASE-001: %s is refused before any connection', async (url) => {
    const { calls, fetchImpl } = recorder();
    const guard = createOutboundGuard({ policy: createOutboundPolicy([]), resolver: staticResolver({}), env: {}, fetch: fetchImpl });
    await expect(guard.fetch(url)).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(calls).toEqual([]);
  });

  test('CASE-002: a gateway call refused by the policy is tried once, not retried, and the client is not told the address', async () => {
    const h = createHarness();
    const { calls, fetchImpl } = recorder();
    h.setProviderFetch(fetchImpl);
    const admin = await h.completeSetup();
    const created = (await (await h.request('/api/providers', { method: 'POST', cookie: admin, json: { name: 'internal', identifier: 'internal', kind: 'openai_compatible', endpoint: 'https://api.example.test/v1' } })).json()) as ApiSuccess<{ id: string }>;
    h.models.create({ id: 'u', username: 'admin' }, { providerId: created.data.id, providerModelId: 'm1', capabilities: ['CHAT'] }, { ip: null });
    // Stored before the policy existed (or edited in the database): only the call-time check stops it.
    h.db.run("UPDATE providers SET endpoint = 'https://172.16.0.9/v1' WHERE id = ?", [created.data.id]);
    const key = ((await (await h.request('/api/api-keys', { method: 'POST', cookie: admin, json: { name: 'app' } })).json()) as ApiSuccess<{ secret: string }>).data.secret;
    const res = await h.request('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, json: { model: 'internal/m1', messages: [{ role: 'user', content: 'hi' }] } });
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(text).toContain('1 attempt');
    expect(text).not.toContain('172.16');
    expect(calls).toEqual([]);
  });

  test('CASE-003: an allowlisted range does not open cloud metadata addresses', async () => {
    const { calls, fetchImpl } = recorder();
    const guard = createOutboundGuard({ policy: createOutboundPolicy(['169.254.0.0/16', 'fd00::/8']), resolver: staticResolver({ 'meta.example': ['169.254.169.254'] }), env: {}, fetch: fetchImpl });
    for (const url of ['https://169.254.169.254/latest', 'https://meta.example/latest', 'https://[fd00:ec2::254]/latest']) {
      await expect(guard.fetch(url)).rejects.toBeInstanceOf(OutboundBlockedError);
    }
    expect(calls).toEqual([]);
  });
});
