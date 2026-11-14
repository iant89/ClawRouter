import type { ApiKeyInfo, CreateApiKeyRequest, CreatedApiKey, GatewayMetrics } from '@clawrouter/shared';
import { apiDelete, apiGet, apiGetPage, apiPost } from './api-client.ts';

export const fetchApiKeys = (signal?: AbortSignal) => apiGet<ApiKeyInfo[]>('/api/api-keys', { signal });
/** Active keys of non-administrators that last longer than `days` (shown when the maximum key lifetime is lowered). */
export const fetchKeysBeyondLifetime = (days: number, page: number, pageSize: number, signal?: AbortSignal) =>
  apiGetPage<ApiKeyInfo>(`/api/api-keys/beyond-lifetime?days=${days}&page=${page}&pageSize=${pageSize}`, { signal });
/** The response is the only time the full key is available. Keep it in component state, never in storage. */
export const createApiKey = (body: CreateApiKeyRequest) => apiPost<CreatedApiKey>('/api/api-keys', body);
export const revokeApiKey = (id: string) => apiDelete<ApiKeyInfo>(`/api/api-keys/${encodeURIComponent(id)}`);
export const fetchGatewayMetrics = (signal?: AbortSignal) => apiGet<GatewayMetrics>('/api/gateway/metrics', { signal });
