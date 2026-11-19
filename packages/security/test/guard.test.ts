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

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOutboundGuard, createOutboundPolicy, OutboundBlockedError, staticResolver, systemResolver, usesProxy, type Resolver } from '../src/index.ts';

interface Seen {
  url: string;
  host: string | null;
  redirect: RequestRedirect | undefined;
  tls: Record<string, unknown> | undefined;
}

function recorder() {
  const seen: Seen[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit & { tls?: Record<string, unknown> }) => {
    seen.push({ url: String(input), host: new Headers(init?.headers).get('host'), redirect: init?.redirect, tls: init?.tls });
    return new Response('ok');
  }) as typeof fetch;
  return { seen, fake };
}

const noProxy = {};

describe('outbound guard (SEC-001, SEC-008)', () => {
  test('connects to the checked address, keeping the hostname for Host and TLS', async () => {
    const { seen, fake } = recorder();
    const guard = createOutboundGuard({ resolver: staticResolver({ 'api.provider.example': ['93.184.215.14'] }), fetch: fake, env: noProxy });
    await guard.fetch('https://api.provider.example/v1/models', { headers: { authorization: 'Bearer x' } });
    expect(seen[0]).toEqual({
      url: 'https://93.184.215.14/v1/models', host: 'api.provider.example', redirect: 'manual',
      tls: { serverName: 'api.provider.example', rejectUnauthorized: true },
    });
  });

  test('IPv6 answers are bracketed; ports are kept in Host', async () => {
    const { seen, fake } = recorder();
    const guard = createOutboundGuard({ resolver: staticResolver({ 'v6.example': ['2606:4700::6812:7c0'] }), fetch: fake, env: noProxy });
    await guard.fetch('https://v6.example:8443/v1');
    expect(seen[0]!.url).toBe('https://[2606:4700::6812:7c0]:8443/v1');
    expect(seen[0]!.host).toBe('v6.example:8443');
  });

  test('DNS rebinding: one lookup per request, and the connection goes to the address that was checked', async () => {
    const { seen, fake } = recorder();
    let lookups = 0;
    // A hostile name server: a public answer, then loopback for whoever asks next.
    const rebinding: Resolver = async () => (lookups++ === 0 ? ['93.184.215.14'] : ['127.0.0.1']);
    const guard = createOutboundGuard({ resolver: rebinding, fetch: fake, env: noProxy });
    await guard.fetch('https://rebind.example/v1');
    expect(lookups).toBe(1);
    expect(seen[0]!.url).toBe('https://93.184.215.14/v1');
    // The next request looks the name up again, sees loopback and never connects.
    const blocked = await guard.fetch('https://rebind.example/v1').catch((e) => e);
    expect(blocked).toBeInstanceOf(OutboundBlockedError);
    expect(blocked.message).toContain('loopback');
    expect(seen).toHaveLength(1);
  });

  test('a mix of public and private answers never connects', async () => {
    const { seen, fake } = recorder();
    const guard = createOutboundGuard({ resolver: staticResolver({ 'mixed.example': ['93.184.215.14', '10.0.0.8'] }), fetch: fake, env: noProxy });
    await expect(guard.fetch('https://mixed.example/')).rejects.toThrow('10.0.0.8');
    const v6 = createOutboundGuard({ resolver: staticResolver({ 'mixed.example': ['2606:4700::1', '::ffff:127.0.0.1'] }), fetch: fake, env: noProxy });
    await expect(v6.fetch('https://mixed.example/')).rejects.toThrow('loopback');
    expect(seen).toHaveLength(0);
  });

  test('literal addresses, metadata and unresolvable names', async () => {
    const { seen, fake } = recorder();
    const guard = createOutboundGuard({ resolver: staticResolver({}), fetch: fake, env: noProxy });
    await expect(guard.fetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow('never reachable');
    await expect(guard.fetch('https://[::1]:8080/')).rejects.toThrow('loopback');
    await expect(guard.fetch('https://nowhere.example/')).rejects.toThrow('could not be resolved');
    await expect(guard.fetch(new Request('https://x.example/'))).rejects.toThrow('not a Request');
    expect(seen).toHaveLength(0);
  });

  test('redirects are never followed, whatever the caller asks', async () => {
    const { seen, fake } = recorder();
    const guard = createOutboundGuard({ resolver: staticResolver({}, ['93.184.215.14']), fetch: fake, env: noProxy });
    await guard.fetch('https://a.example/', { redirect: 'follow' });
    expect(seen[0]!.redirect).toBe('manual');
  });

  test('allowlisted local hosts are reached over plain http, pinned too', async () => {
    const { seen, fake } = recorder();
    const guard = createOutboundGuard({ policy: createOutboundPolicy('ollama'), resolver: staticResolver({ ollama: ['172.18.0.4'] }), fetch: fake, env: noProxy });
    await guard.fetch('http://ollama:11434/v1/models');
    expect(seen[0]).toMatchObject({ url: 'http://172.18.0.4:11434/v1/models', host: 'ollama:11434', tls: undefined });
  });

  test('behind an egress proxy the checks run but the name is left for the proxy', async () => {
    const { seen, fake } = recorder();
    const env = { HTTPS_PROXY: 'http://proxy.internal:3128' };
    const guard = createOutboundGuard({ resolver: staticResolver({}, ['93.184.215.14']), fetch: fake, env });
    await guard.fetch('https://api.provider.example/v1');
    expect(seen[0]!.url).toBe('https://api.provider.example/v1');
    const blocked = createOutboundGuard({ resolver: staticResolver({}, ['10.0.0.1']), fetch: fake, env });
    await expect(blocked.fetch('https://api.provider.example/v1')).rejects.toThrow('private');
  });

  test('behind an egress proxy without local DNS, https names pass and http needs an allowlisted name', async () => {
    const { seen, fake } = recorder();
    const env = { HTTPS_PROXY: 'http://proxy.internal:3128', HTTP_PROXY: 'http://proxy.internal:3128' };
    const guard = createOutboundGuard({ resolver: staticResolver({}), fetch: fake, env });
    await guard.fetch('https://api.provider.example/v1');
    expect(seen[0]!.url).toBe('https://api.provider.example/v1');
    await expect(guard.fetch('http://api.provider.example/v1')).rejects.toThrow('plain http');
    await expect(guard.fetch('https://169.254.169.254/')).rejects.toThrow('never reachable');
    await expect(guard.fetch('https://metadata.google.internal/')).rejects.toThrow('never reachable');
    const local = createOutboundGuard({ policy: createOutboundPolicy('ollama'), resolver: staticResolver({}), fetch: fake, env });
    await local.fetch('http://ollama:11434/v1');
    // Without a proxy, a name that does not resolve is refused.
    const direct = createOutboundGuard({ resolver: staticResolver({}), fetch: fake, env: {} });
    await expect(direct.fetch('https://api.provider.example/v1')).rejects.toThrow('could not be resolved');
  });

  test('proxy detection follows HTTPS_PROXY, HTTP_PROXY and NO_PROXY', () => {
    const u = new URL('https://api.provider.example/v1');
    expect(usesProxy(u, {})).toBe(false);
    expect(usesProxy(u, { https_proxy: 'http://p:1' })).toBe(true);
    expect(usesProxy(u, { HTTP_PROXY: 'http://p:1' })).toBe(true);
    expect(usesProxy(u, { HTTPS_PROXY: 'http://p:1', NO_PROXY: '.provider.example' })).toBe(false);
    expect(usesProxy(u, { HTTPS_PROXY: 'http://p:1', NO_PROXY: 'api.provider.example' })).toBe(false);
    expect(usesProxy(u, { HTTPS_PROXY: 'http://p:1', NO_PROXY: '*' })).toBe(false);
    expect(usesProxy(new URL('http://x.example'), { HTTPS_PROXY: 'http://p:1' })).toBe(false);
  });

  test('the system resolver returns every address and refuses unknown names', async () => {
    const resolve = systemResolver(2_000);
    expect(await resolve('127.0.0.1')).toEqual(['127.0.0.1']);
    expect(await resolve('localhost')).toContain('127.0.0.1');
    await expect(resolve('no-such-host.invalid')).rejects.toThrow('could not be resolved');
  });
});

// A real TLS server on loopback with a certificate for "provider.test" only: pinning must keep
// certificate verification against the hostname (SEC-007), not the address it connects to.
const openssl = Bun.which('openssl');
describe.skipIf(!openssl)('pinned TLS connections (SEC-007)', () => {
  let dir = '';
  let cert = '';
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'clawrouter-tls-'));
    const made = Bun.spawnSync([openssl!, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
      '-days', '1', '-subj', '/CN=provider.test', '-addext', 'subjectAltName=DNS:provider.test'], { stderr: 'ignore', stdout: 'ignore' });
    if (made.exitCode !== 0) throw new Error('openssl could not create a test certificate');
    cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', tls: { cert, key: readFileSync(join(dir, 'key.pem'), 'utf8') }, fetch: (req) => new Response(`host=${req.headers.get('host')}`) });
  });
  afterAll(() => {
    server?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
  // Trust the test certificate authority; everything else is the guard's doing.
  const trusting = (() => ((input: RequestInfo | URL, init?: RequestInit & { tls?: Record<string, unknown> }) => fetch(input, { ...init, tls: { ...init?.tls, ca: cert } } as RequestInit))) as () => typeof fetch;
  const policy = createOutboundPolicy('127.0.0.0/8');

  test('the certificate is verified against the hostname while connecting to the checked address', async () => {
    const guard = createOutboundGuard({ policy, resolver: staticResolver({ 'provider.test': ['127.0.0.1'] }), fetch: trusting(), env: {} });
    const response = await guard.fetch(`https://provider.test:${server.port}/`);
    expect(await response.text()).toBe(`host=provider.test:${server.port}`);
  });

  test('a certificate for another name is refused', async () => {
    const guard = createOutboundGuard({ policy, resolver: staticResolver({ 'other.test': ['127.0.0.1'] }), fetch: trusting(), env: {} });
    await expect(guard.fetch(`https://other.test:${server.port}/`)).rejects.toThrow();
  });
});
