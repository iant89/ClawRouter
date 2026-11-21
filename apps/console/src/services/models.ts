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

import type { CreateModelRequest, DiscoveredModelInfo, ImportModelsResult, ModelInfo, ModelQuery, UpdateModelRequest } from '@clawrouter/shared';
import { apiDelete, apiGet, apiGetPage, apiPost, request } from './api-client.ts';

export function fetchModels(query: ModelQuery, signal?: AbortSignal) {
  const params = new URLSearchParams();
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  if (query.providerId) params.set('providerId', query.providerId);
  if (query.capability) params.set('capability', query.capability);
  if (query.q) params.set('q', query.q);
  if (query.usableOnly) params.set('usable', 'true');
  return apiGetPage<ModelInfo>(`/api/models?${params}`, { signal });
}
export const createModel = (body: CreateModelRequest) => apiPost<ModelInfo>('/api/models', body);
export const updateModel = (id: string, body: UpdateModelRequest) => request<ModelInfo>('PATCH', `/api/models/${encodeURIComponent(id)}`, body);
export const deleteModel = (id: string) => apiDelete(`/api/models/${encodeURIComponent(id)}`);
export const discoverModels = (providerId: string, signal?: AbortSignal) =>
  apiGet<DiscoveredModelInfo[]>(`/api/providers/${encodeURIComponent(providerId)}/models/discover`, { signal });
export const importModels = (providerId: string, providerModelIds: string[]) =>
  apiPost<ImportModelsResult>(`/api/providers/${encodeURIComponent(providerId)}/models/import`, { providerModelIds });

/** Every model matching the query, page by page (at most `limit`), for pickers. */
export async function fetchAllModels(query: Omit<ModelQuery, 'page' | 'pageSize'>, signal?: AbortSignal, limit = 2000): Promise<ModelInfo[]> {
  const all: ModelInfo[] = [];
  for (let page = 1; all.length < limit; page += 1) {
    const result = await fetchModels({ ...query, page, pageSize: 200 }, signal);
    all.push(...result.items);
    if (all.length >= result.total || result.items.length === 0) break;
  }
  return all.slice(0, limit);
}
