import type { CreateModelRequest, DiscoveredModelInfo, ImportModelsResult, ModelInfo, ModelQuery, UpdateModelRequest } from '@clawapi/shared';
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
