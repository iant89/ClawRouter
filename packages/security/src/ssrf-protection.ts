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

import { isIP } from 'node:net';
import { bareHost, createOutboundPolicy, type OutboundPolicy } from './outbound-network-policy.ts';
import { ResolveError, systemResolver, type Resolver } from './safe-dns.ts';

/** A connection the outbound policy refused. The message is safe to show administrators. */
export class OutboundBlockedError extends Error {
  override readonly name = 'OutboundBlockedError';
  /** The reason alone, without the "Blocked by …" prefix. */
  readonly reason: string;
  constructor(reason: string) {
    super(`Blocked by the outbound network policy: ${reason}`);
    this.reason = reason;
  }
}

/** Where a checked request will connect. */
export interface Destination {
  url: URL;
  /** Every address the host resolved to (all passed the policy). */
  addresses: string[];
  /** The address the connection is made to; null when an egress proxy resolves the name instead. */
  pinned: string | null;
}

export interface OutboundGuardOptions {
  policy?: OutboundPolicy;
  resolver?: Resolver;
  /** The fetch that does the actual I/O (tests inject a fake). */
  fetch?: typeof fetch;
  /** Environment for proxy detection (HTTPS_PROXY, HTTP_PROXY, NO_PROXY). */
  env?: Record<string, string | undefined>;
  /**
   * Connect to the checked address (default true). Only tests turn this off, so
   * fake fetches still see the hostname; the checks run either way.
   */
  pin?: boolean;
}

export interface OutboundGuard {
  readonly policy: OutboundPolicy;
  /** Validates a URL, resolves its host and checks every address. Throws OutboundBlockedError. */
  check(url: string | URL): Promise<Destination>;
  /**
   * fetch, restricted by the policy: no redirects (each hop would need a new
   * check, and could carry the API key to another host), and the connection
   * goes to the address that was checked, never to a second DNS answer.
   */
  readonly fetch: typeof fetch;
}

/** Stands for "some public address" when only the egress proxy can resolve a name (a documentation-free public IP). */
const UNRESOLVED_BEHIND_PROXY = '8.8.8.8';

/** Whether Bun will send this URL through an egress proxy (it reads the same variables). */
export function usesProxy(url: URL, env: Record<string, string | undefined>): boolean {
  const pick = (name: string) => env[name.toLowerCase()] ?? env[name.toUpperCase()];
  const proxy = url.protocol === 'https:' ? pick('https_proxy') ?? pick('http_proxy') : pick('http_proxy');
  if (!proxy?.trim()) return false;
  const host = bareHost(url);
  const noProxy = (pick('no_proxy') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return !noProxy.some((entry) => entry === '*' || host === entry.replace(/^\./, '') || host.endsWith(entry.startsWith('.') ? entry : `.${entry}`));
}

/**
 * The outbound security layer (SEC-001, SEC-007, SEC-008). Every connection a
 * provider adapter makes goes through `guard.fetch`:
 *
 *   URL -> policy (scheme, credentials, metadata, literal IPs) -> DNS (all
 *   addresses) -> policy (every address) -> connect to the checked address.
 *
 * DNS rebinding: the request is sent to the checked IP itself (the URL's host
 * is replaced by it), with the original `Host` header and, for https, the
 * original name as the TLS server name, so the certificate is still verified
 * against the hostname. A second lookup never happens, so a name that answers
 * a public address first and 127.0.0.1 next cannot reach 127.0.0.1.
 *
 * Behind an egress proxy (HTTPS_PROXY), the proxy resolves names: the checks
 * still run, but the connection is not pinned, and the proxy's own policy is
 * the last line. TLS verification is never turned off.
 */
export function createOutboundGuard(options: OutboundGuardOptions = {}): OutboundGuard {
  const policy = options.policy ?? createOutboundPolicy();
  const resolve = options.resolver ?? systemResolver();
  const inner = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const pin = options.pin ?? true;

  async function check(raw: string | URL): Promise<Destination> {
    let url: URL;
    try {
      url = new URL(raw.toString());
    } catch {
      throw new OutboundBlockedError('the URL is not valid');
    }
    const staticReason = policy.checkUrl(url);
    if (staticReason) throw new OutboundBlockedError(staticReason);
    const host = bareHost(url);
    const proxied = usesProxy(url, env);
    let addresses: string[];
    try {
      addresses = isIP(host) ? [host] : await resolve(host);
    } catch (error) {
      // Behind an egress proxy the proxy resolves names, and this machine often has no DNS for
      // outside names at all. The name is then judged as a public one: https passes, plain http
      // only when the hostname itself is allowlisted. The proxy's own policy is the last line.
      if (proxied) {
        const reason = policy.checkAddresses(url, [UNRESOLVED_BEHIND_PROXY]);
        if (reason) throw new OutboundBlockedError(reason);
        return { url, addresses: [], pinned: null };
      }
      throw new OutboundBlockedError(error instanceof ResolveError ? error.message : `${host} could not be resolved`);
    }
    const reason = policy.checkAddresses(url, addresses);
    if (reason) throw new OutboundBlockedError(reason);
    const pinned = !pin || proxied ? null : addresses[0]!;
    return { url, addresses, pinned };
  }

  const guardedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (input instanceof Request) throw new OutboundBlockedError('pass a URL and options, not a Request');
    const { url, pinned } = await check(input);
    const host = bareHost(url);
    const options: RequestInit & { tls?: Record<string, unknown> } = { ...init, redirect: 'manual' };
    if (pinned === null || isIP(host)) return inner(url.toString(), options);
    const target = new URL(url);
    target.hostname = pinned.includes(':') ? `[${pinned}]` : pinned;
    const headers = new Headers(init?.headers);
    headers.set('host', url.host);
    options.headers = headers;
    if (url.protocol === 'https:') {
      const tls = (init as { tls?: Record<string, unknown> } | undefined)?.tls ?? {};
      // The certificate is checked against the hostname, not the address (Bun sends it as SNI too).
      options.tls = { ...tls, serverName: host, rejectUnauthorized: true };
    }
    return inner(target.toString(), options);
  };

  return { policy, check, fetch: guardedFetch as typeof fetch };
}
