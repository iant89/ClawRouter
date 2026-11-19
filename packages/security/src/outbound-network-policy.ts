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

import { cidrContains, classifyAddress, parseCidr, type Cidr } from './ip-classifier.ts';

/** The environment variable that widens the policy. Named in every refusal so operators know the fix. */
export const ALLOWLIST_VARIABLE = 'CLAWROUTER_OUTBOUND_ALLOWLIST';

/** Names that reach cloud metadata services without an IP address. Never reachable. */
const METADATA_NAMES = new Set([
  'metadata', 'metadata.google.internal', 'metadata.goog', 'metadata.azure.com', 'metadata.azure.internal',
  'instance-data', 'instance-data.ec2.internal', 'metadata.tencentyun.com', 'metadata.oraclecloud.com',
]);

const HOSTNAME = /^(\*\.)?(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,62})(?:\.[a-z0-9_](?:[a-z0-9_-]{0,62}))*\.?$/i;

/**
 * Outbound network policy (SEC-001, SEC-007): which destinations ClawRouter may
 * connect to on behalf of an administrator's configuration.
 *
 *   - http and https only; no credentials in the URL.
 *   - Public addresses: https only.
 *   - Loopback, private, link-local, reserved, multicast and unspecified
 *     addresses, and plain http to anything, only for destinations on the
 *     allowlist (`CLAWROUTER_OUTBOUND_ALLOWLIST`: hostnames, `*.suffix`
 *     wildcards, IP addresses and CIDR ranges).
 *   - Cloud metadata services: never, whatever the allowlist says.
 *
 * Every address a name resolves to must pass, so a name with one public and
 * one private address is refused (the client could pick either).
 */
export interface OutboundPolicy {
  /** Allowlist entries as configured. */
  readonly allowlist: readonly string[];
  /** Checks what can be known without DNS. Null: no objection (yet). */
  checkUrl(url: URL): string | null;
  /** Checks the addresses `url`'s host resolved to. Null: every one may be reached. */
  checkAddresses(url: URL, addresses: readonly string[]): string | null;
}

export interface ParsedAllowlist {
  hosts: string[];
  suffixes: string[];
  cidrs: Cidr[];
  entries: string[];
  invalid: string[];
}

/** Parses a comma-separated allowlist. Invalid entries are returned, not thrown. */
export function parseAllowlist(raw: string | readonly string[] | undefined): ParsedAllowlist {
  const items = typeof raw === 'string' || raw === undefined ? (raw ?? '').split(',') : [...raw];
  const out: ParsedAllowlist = { hosts: [], suffixes: [], cidrs: [], entries: [], invalid: [] };
  for (const item of items.map((s) => s.trim()).filter(Boolean)) {
    const cidr = parseCidr(item.replace(/^\[|\]$/g, ''));
    if (cidr) out.cidrs.push(cidr);
    else if (HOSTNAME.test(item) && !/^[\d.]+$/.test(item)) {
      const lower = item.toLowerCase().replace(/\.$/, '');
      if (lower.startsWith('*.')) out.suffixes.push(lower.slice(1));
      else out.hosts.push(lower);
    } else {
      out.invalid.push(item);
      continue;
    }
    out.entries.push(item);
  }
  return out;
}

export const bareHost = (url: URL) => url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');

export function createOutboundPolicy(allowlist: string | readonly string[] = []): OutboundPolicy {
  const parsed = parseAllowlist(allowlist);
  if (parsed.invalid.length) throw new Error(`${ALLOWLIST_VARIABLE} has invalid entries: ${parsed.invalid.join(', ')}`);
  const hostAllowed = (host: string) => parsed.hosts.includes(host) || parsed.suffixes.some((s) => host.endsWith(s) && host.length > s.length);
  const addressAllowed = (address: string) => parsed.cidrs.some((c) => cidrContains(c, address));
  const hint = (what: string) => `${what}; add it to ${ALLOWLIST_VARIABLE} to allow it`;

  return {
    allowlist: parsed.entries,

    checkUrl(url) {
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'only http and https are allowed';
      if (url.username || url.password) return 'the URL must not contain credentials';
      const host = bareHost(url);
      if (!host) return 'the URL has no host';
      if (METADATA_NAMES.has(host)) return `${host} is a cloud metadata service and is never reachable`;
      const literal = classifyAddress(host);
      if (literal) {
        if (literal.kind === 'metadata') return `${host} is a ${literal.note} and is never reachable`;
        if (literal.kind !== 'public' && !addressAllowed(host)) return hint(`${host} is a ${literal.note} address`);
        if (url.protocol === 'http:' && !addressAllowed(host)) return hint(`plain http to ${host} is not allowed (use https)`);
        return null;
      }
      // A name: plain http is decided here only when no CIDR entry could still allow it after DNS.
      if (url.protocol === 'http:' && !hostAllowed(host) && parsed.cidrs.length === 0) return hint(`plain http to ${host} is not allowed (use https)`);
      return null;
    },

    checkAddresses(url, addresses) {
      const host = bareHost(url);
      if (addresses.length === 0) return `${host} did not resolve to any address`;
      const trustedName = classifyAddress(host) === null && hostAllowed(host);
      for (const address of addresses) {
        const c = classifyAddress(address);
        if (!c) return `${host} resolved to something that is not an IP address`;
        if (c.kind === 'metadata') return `${host} resolves to ${address}, a ${c.note}, which is never reachable`;
        if (trustedName || addressAllowed(address)) continue;
        if (c.kind !== 'public') return hint(`${host} resolves to ${address}, a ${c.note} address`);
        if (url.protocol === 'http:') return hint(`plain http to ${host} is not allowed (use https)`);
      }
      return null;
    },
  };
}
