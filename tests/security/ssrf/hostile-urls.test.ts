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

// SEC-012 SSRF: a corpus of hostile provider URLs against the production policy (public https
// only, no allowlist). The guard's own tests are in packages/security/test; the API-level ones in
// packages/api/test/outbound-api.test.ts.

import { describe, expect, test } from 'bun:test';
import { createOutboundGuard, createOutboundPolicy, OutboundBlockedError, staticResolver, type Resolver } from '@clawrouter/security';

const PUBLIC = '93.184.215.14';
const names: Record<string, string[]> = {
  'api.provider.example': [PUBLIC],
  'loopback.example': ['127.0.0.1'],
  'private.example': ['10.1.2.3'],
  'v6-private.example': ['fd00::1'],
  'metadata-alias.example': ['169.254.169.254'],
  'mapped.example': ['::ffff:127.0.0.1'],
  'mixed.example': [PUBLIC, '192.168.0.10'],
  'nat64.example': ['64:ff9b::a9fe:a9fe'], // 169.254.169.254 through NAT64
};

function guard(resolver: Resolver = staticResolver(names)) {
  const connected: string[] = [];
  const g = createOutboundGuard({
    policy: createOutboundPolicy([]), resolver, env: {},
    fetch: (async (input: RequestInfo | URL) => { connected.push(String(input)); return new Response('{}'); }) as typeof fetch,
  });
  return { g, connected };
}

describe('hostile provider URLs are refused before any connection (SEC-012 ssrf)', () => {
  test.each([
    'http://api.provider.example/v1', // plain http to a public host
    'https://127.0.0.1/v1', 'https://127.1/v1', 'https://2130706433/v1', 'https://0x7f000001/v1', 'https://0177.0.0.1/v1',
    'https://[::1]/v1', 'https://[::ffff:127.0.0.1]/v1', 'https://[::ffff:7f00:1]/v1',
    'https://0.0.0.0/v1', 'https://[::]/v1',
    'https://10.0.0.1/v1', 'https://172.31.255.255/v1', 'https://192.168.1.1/v1', 'https://100.64.0.1/v1', 'https://[fd12::1]/v1',
    'https://169.254.169.254/latest/meta-data/', 'https://[fe80::1]/v1', 'https://metadata.google.internal/computeMetadata/v1/',
    'https://metadata/v1', 'https://169.254.170.2/v2/credentials', 'https://[fd00:ec2::254]/latest',
    'https://loopback.example/v1', 'https://private.example/v1', 'https://v6-private.example/v1', 'https://metadata-alias.example/v1',
    'https://mapped.example/v1', 'https://mixed.example/v1', 'https://nat64.example/v1',
    'file:///etc/passwd', 'gopher://api.provider.example/', 'ftp://api.provider.example/', 'ws://api.provider.example/',
    'https://user:pass@127.0.0.1/', 'not a url', 'https://unresolvable.example/v1',
  ])('%s', async (url) => {
    const { g, connected } = guard();
    await expect(g.fetch(url)).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(connected).toEqual([]);
  });

  test('a public https host is allowed, pinned to the address that was checked', async () => {
    const { g, connected } = guard();
    await g.fetch('https://api.provider.example/v1/models');
    expect(connected).toEqual([`https://${PUBLIC}/v1/models`]);
  });

  test('DNS rebinding: a name that turns private between lookups never reaches the private address', async () => {
    let n = 0;
    const { g, connected } = guard(async () => (n++ % 2 === 0 ? [PUBLIC] : ['127.0.0.1']));
    await g.fetch('https://rebind.example/v1');
    await expect(g.fetch('https://rebind.example/v1')).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(connected).toEqual([`https://${PUBLIC}/v1`]);
  });

  test('redirects are not followed (a public host cannot bounce a request inward)', async () => {
    const seen: RequestInit[] = [];
    const g = createOutboundGuard({
      policy: createOutboundPolicy([]), resolver: staticResolver(names), env: {},
      fetch: (async (_i: RequestInfo | URL, init?: RequestInit) => { seen.push(init ?? {}); return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }); }) as typeof fetch,
    });
    const res = await g.fetch('https://api.provider.example/v1', { redirect: 'follow' });
    expect(res.status).toBe(302);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.redirect).toBe('manual');
  });

  test('metadata addresses stay refused even when an administrator allowlists everything private', async () => {
    const g = createOutboundGuard({ policy: createOutboundPolicy(['10.0.0.0/8', '169.254.0.0/16', '127.0.0.0/8']), resolver: staticResolver(names), env: {}, fetch: (async () => new Response('')) as unknown as typeof fetch });
    await expect(g.fetch('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(g.fetch('http://10.0.0.5/v1')).resolves.toBeInstanceOf(Response);
  });
});
