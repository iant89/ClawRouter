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

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Resolves a hostname to every address it has (IPv4 and IPv6). */
export type Resolver = (hostname: string) => Promise<string[]>;

/** Why a name could not be resolved. The message is safe to show administrators. */
export class ResolveError extends Error {
  override readonly name = 'ResolveError';
}

/**
 * The system resolver (getaddrinfo, so /etc/hosts and the container's DNS
 * apply), asking for **all** addresses: the policy checks each of them, and
 * the connection is then made to one of exactly those (SEC-008).
 */
export function systemResolver(timeoutMs = 5_000): Resolver {
  return async (hostname) => {
    if (isIP(hostname)) return [hostname];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ResolveError(`looking up ${hostname} took longer than ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      const found = await Promise.race([lookup(hostname, { all: true, verbatim: true }), timeout]);
      return [...new Set(found.map((a) => a.address))];
    } catch (error) {
      if (error instanceof ResolveError) throw error;
      const code = (error as { code?: string }).code;
      throw new ResolveError(`${hostname} could not be resolved${code ? ` (${code})` : ''}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** A fixed resolver for tests: names map to addresses; IP literals resolve to themselves. */
export function staticResolver(table: Record<string, string[]>, fallback?: string[]): Resolver {
  return async (hostname) => {
    if (isIP(hostname)) return [hostname];
    const found = table[hostname.toLowerCase()] ?? fallback;
    if (!found) throw new ResolveError(`${hostname} could not be resolved (ENOTFOUND)`);
    return found;
  };
}
