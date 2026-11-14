import type { ApiKeyInfo, ApiKeyStatus, CreateApiKeyRequest, CreatedApiKey, GatewayMetrics } from '@clawrouter/shared';
import { apiDelete, apiGet, apiGetPage, apiPost } from './api-client.ts';

/** One page of API keys (server-side paging and filtering, phase 16). `meta.active` counts every active key. */
export async function fetchApiKeys(query: { page?: number; pageSize?: number; q?: string; status?: ApiKeyStatus | null } = {}, signal?: AbortSignal) {
  const p = new URLSearchParams();
  if (query.page) p.set('page', String(query.page));
  if (query.pageSize) p.set('pageSize', String(query.pageSize));
  if (query.q) p.set('q', query.q);
  if (query.status) p.set('status', query.status);
  return apiGetPage<ApiKeyInfo>(`/api/api-keys?${p}`, { signal });
}
/** Active keys of non-administrators that last longer than `days` (shown when the maximum key lifetime is lowered). */
export const fetchKeysBeyondLifetime = (days: number, page: number, pageSize: number, signal?: AbortSignal) =>
  apiGetPage<ApiKeyInfo>(`/api/api-keys/beyond-lifetime?days=${days}&page=${page}&pageSize=${pageSize}`, { signal });
/** The response is the only time the full key is available. Keep it in component state, never in storage. */
export const createApiKey = (body: CreateApiKeyRequest) => apiPost<CreatedApiKey>('/api/api-keys', body);
export const revokeApiKey = (id: string) => apiDelete<ApiKeyInfo>(`/api/api-keys/${encodeURIComponent(id)}`);
export const fetchGatewayMetrics = (signal?: AbortSignal) => apiGet<GatewayMetrics>('/api/gateway/metrics', { signal });
