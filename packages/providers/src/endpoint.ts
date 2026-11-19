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

import type { FieldIssue } from '@clawrouter/shared';

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata', 'metadata.azure.com', '169.254.169.254', '[fd00:ec2::254]']);

function isLoopbackOrPrivate(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // IPv6 unique local
  // Single-label hosts (e.g. a Docker service name "ollama") are on the local network.
  return !h.includes('.') && !h.includes(':');
}

/**
 * Endpoint policy for provider base URLs:
 *   - http(s) only, no credentials or query/fragment in the URL;
 *   - plain http only for loopback / private / single-label hosts (local models);
 *   - cloud metadata addresses and link-local ranges are refused.
 * Admins choose endpoints, so private hosts stay allowed for local providers.
 */
export function checkEndpoint(raw: string, path = 'endpoint'): { url: string | null; issues: FieldIssue[] } {
  const issue = (message: string) => ({ url: null, issues: [{ path, message }] });
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return issue('must be a valid URL, e.g. https://api.example.com/v1');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return issue('must use http or https');
  if (url.username || url.password) return issue('must not contain credentials; set the API key separately');
  if (url.search || url.hash) return issue('must not contain a query string or fragment');
  const host = url.hostname.toLowerCase();
  if (METADATA_HOSTS.has(host) || /^169\.254\./.test(host) || /^\[?fe80:/i.test(host)) return issue('must not point at a cloud metadata or link-local address');
  if (url.protocol === 'http:' && !isLoopbackOrPrivate(host)) return issue('must use https for hosts outside the local network');
  return { url: url.toString().replace(/\/+$/, ''), issues: [] };
}
