import type { ApiKeyInfo, CreateApiKeyRequest, CreatedApiKey, GatewayMetrics } from '@clawrouter/shared';
import { apiDelete, apiGet, apiPost } from './api-client.ts';

export const fetchApiKeys = (signal?: AbortSignal) => apiGet<ApiKeyInfo[]>('/api/api-keys', { signal });
/** The response is the only time the full key is available. Keep it in component state, never in storage. */
export const createApiKey = (body: CreateApiKeyRequest) => apiPost<CreatedApiKey>('/api/api-keys', body);
export const revokeApiKey = (id: string) => apiDelete<ApiKeyInfo>(`/api/api-keys/${encodeURIComponent(id)}`);
export const fetchGatewayMetrics = (signal?: AbortSignal) => apiGet<GatewayMetrics>('/api/gateway/metrics', { signal });
