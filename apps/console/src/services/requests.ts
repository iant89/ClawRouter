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

import type { RequestDetail, RequestQuery, RequestRecord, UsageGroup, UsageReport } from '@clawrouter/shared';
import { apiGet, apiGetPage } from './api-client.ts';

export function fetchRequests(q: RequestQuery, signal?: AbortSignal) {
  const p = new URLSearchParams();
  if (q.page) p.set('page', String(q.page));
  if (q.pageSize) p.set('pageSize', String(q.pageSize));
  if (q.status) p.set('status', q.status);
  if (q.apiKeyId) p.set('apiKeyId', q.apiKeyId);
  if (q.providerId) p.set('providerId', q.providerId);
  if (q.model) p.set('model', q.model);
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  if (q.problemsOnly) p.set('problems', 'true');
  return apiGetPage<RequestRecord>(`/api/requests?${p}`, { signal });
}

export const fetchRequest = (id: string, signal?: AbortSignal) => apiGet<RequestDetail>(`/api/requests/${encodeURIComponent(id)}`, { signal });

export function fetchUsage(q: { from?: string; to?: string; bucket?: 'hour' | 'day'; groupBy?: UsageGroup }, signal?: AbortSignal) {
  const p = new URLSearchParams();
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  if (q.bucket) p.set('bucket', q.bucket);
  if (q.groupBy) p.set('groupBy', q.groupBy);
  return apiGet<UsageReport>(`/api/usage?${p}`, { signal });
}
