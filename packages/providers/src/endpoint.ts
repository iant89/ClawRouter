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
import type { OutboundPolicy } from '@clawrouter/security';

/**
 * Endpoint checks for provider base URLs:
 *   - http(s) only, no credentials or query/fragment in the URL;
 *   - with a policy (always, in the provider service): the outbound network
 *     policy decides which hosts and schemes are allowed (SEC-001, SEC-007):
 *     https to public addresses, and private hosts or plain http only when
 *     CLAWROUTER_OUTBOUND_ALLOWLIST lists them. Metadata services never.
 * DNS is not consulted here; every call is checked again when it connects.
 */
export function checkEndpoint(raw: string, path = 'endpoint', policy?: OutboundPolicy): { url: string | null; issues: FieldIssue[] } {
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
  const refused = policy?.checkUrl(url);
  if (refused) return issue(`is not allowed: ${refused}`);
  return { url: url.toString().replace(/\/+$/, ''), issues: [] };
}
