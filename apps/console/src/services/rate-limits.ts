import type { ApiKeyInfo, PutRateLimitsRequest, RateLimitConfigView, RateLimitUsage, UpdateApiKeyRequest } from '@clawrouter/shared';
import { apiGet, apiPut, request } from './api-client.ts';

export const fetchRateLimits = (signal?: AbortSignal) => apiGet<RateLimitConfigView>('/api/rate-limits', { signal });
export const saveRateLimits = (body: PutRateLimitsRequest) => apiPut<RateLimitConfigView>('/api/rate-limits', body);
export const fetchRateLimitUsage = (signal?: AbortSignal) => apiGet<RateLimitUsage>('/api/rate-limits/usage', { signal });
export const updateApiKey = (id: string, body: UpdateApiKeyRequest) => request<ApiKeyInfo>('PATCH', `/api/api-keys/${encodeURIComponent(id)}`, body);
