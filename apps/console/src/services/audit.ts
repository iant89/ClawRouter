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

import type { AuditRecord, AuditSearch, PageMeta } from '@clawrouter/shared';
import { requestEnvelope } from './api-client.ts';

export interface AuditPage {
  items: AuditRecord[];
  total: number;
  page: number;
  pageSize: number;
  /** Resource types present in the log, for the filter. */
  resources: string[];
}

export async function fetchAudit(q: AuditSearch, signal?: AbortSignal): Promise<AuditPage> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  const env = await requestEnvelope<AuditRecord[]>('GET', `/api/audit?${p}`, undefined, { signal });
  const meta = (env.meta ?? {}) as Partial<PageMeta> & { resources?: string[] };
  return { items: env.data, total: meta.total ?? env.data.length, page: meta.page ?? 1, pageSize: meta.pageSize ?? env.data.length, resources: meta.resources ?? [] };
}

/** "API_KEY_CREATED" → "API key created". */
export function auditActionLabel(action: string): string {
  const words = action.toLowerCase().split('_');
  const text = words.join(' ').replace(/\bapi key\b/, 'API key');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
