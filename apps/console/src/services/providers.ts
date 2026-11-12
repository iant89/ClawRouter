import type {
  ConnectionTestResult, CreateProviderRequest, ProviderDetail, ProviderInfo, ProviderKindInfo, UpdateProviderRequest,
} from '@clawapi/shared';
import { apiDelete, apiGet, apiPost, apiPut, request } from './api-client.ts';

export const fetchProviders = (signal?: AbortSignal) => apiGet<ProviderInfo[]>('/api/providers', { signal });
export const fetchProvider = (id: string, signal?: AbortSignal) => apiGet<ProviderDetail>(`/api/providers/${encodeURIComponent(id)}`, { signal });
export const fetchProviderKinds = (signal?: AbortSignal) => apiGet<ProviderKindInfo[]>('/api/providers/kinds', { signal });
export const createProvider = (body: CreateProviderRequest) => apiPost<ProviderInfo>('/api/providers', body);
export const updateProvider = (id: string, body: UpdateProviderRequest & { apiKey?: string }) =>
  request<ProviderInfo>('PATCH', `/api/providers/${encodeURIComponent(id)}`, body);
export const deleteProvider = (id: string) => apiDelete(`/api/providers/${encodeURIComponent(id)}`);
export const testProvider = (id: string) => apiPost<ConnectionTestResult>(`/api/providers/${encodeURIComponent(id)}/test`);
/** Write-only: the key goes to the server and is never read back. */
export const setProviderKey = (id: string, apiKey: string) => apiPut<ProviderInfo>(`/api/providers/${encodeURIComponent(id)}/credential`, { apiKey });
export const removeProviderKey = (id: string) => request<ProviderInfo>('DELETE', `/api/providers/${encodeURIComponent(id)}/credential`, undefined);
