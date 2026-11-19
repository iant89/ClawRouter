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

import type { OperationInfo, OperationQuery, OperationType } from '@clawrouter/shared';
import { apiGet, apiGetPage, apiPost } from './api-client.ts';

export function fetchOperations(q: OperationQuery, signal?: AbortSignal) {
  const p = new URLSearchParams();
  if (q.page) p.set('page', String(q.page));
  if (q.pageSize) p.set('pageSize', String(q.pageSize));
  if (q.status) p.set('status', q.status);
  if (q.type) p.set('type', q.type);
  return apiGetPage<OperationInfo>(`/api/operations?${p}`, { signal });
}

export const fetchOperation = (id: string, signal?: AbortSignal) => apiGet<OperationInfo>(`/api/operations/${encodeURIComponent(id)}`, { signal });
export const startOperation = (type: OperationType, targetId?: string) => apiPost<OperationInfo>('/api/operations', { type, ...(targetId ? { targetId } : {}) });
export const cancelOperation = (id: string) => apiPost<OperationInfo>(`/api/operations/${encodeURIComponent(id)}/cancel`);
