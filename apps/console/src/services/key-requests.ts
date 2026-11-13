import type {
  ApiKeyInfo, ApiKeyRequestInfo, ApproveKeyRequestBody, CreateApiKeyRequest, CreateKeyRequestBody, CreatedApiKey, DenyKeyRequestBody, KeyRequestStatus,
} from '@clawrouter/shared';
import { apiDelete, apiGet, apiGetPage, apiPost } from './api-client.ts';

const enc = encodeURIComponent;

// Your own keys. The create responses are the only time a secret is available: keep it in component state only.
export const fetchMyKeys = (signal?: AbortSignal) => apiGet<ApiKeyInfo[]>('/api/me/api-keys', { signal });
export const createMyKey = (body: Omit<CreateApiKeyRequest, 'rateLimit' | 'expiresAt'>) => apiPost<CreatedApiKey>('/api/me/api-keys', body);
export const revokeMyKey = (id: string) => apiDelete<ApiKeyInfo>(`/api/me/api-keys/${enc(id)}`);

// Your key requests.
export const fetchMyRequests = (signal?: AbortSignal) => apiGet<ApiKeyRequestInfo[]>('/api/me/api-key-requests', { signal });
export const requestKey = (body: CreateKeyRequestBody) => apiPost<ApiKeyRequestInfo>('/api/me/api-key-requests', body);
export const cancelRequest = (id: string) => apiDelete<ApiKeyRequestInfo>(`/api/me/api-key-requests/${enc(id)}`);
export const createKeyFromRequest = (id: string) => apiPost<CreatedApiKey & { request: ApiKeyRequestInfo }>(`/api/me/api-key-requests/${enc(id)}/create`);

// Approvers (api_keys.write).
export const fetchKeyRequests = (query: { status?: KeyRequestStatus; page?: number; pageSize?: number }, signal?: AbortSignal) => {
  const p = new URLSearchParams();
  if (query.status) p.set('status', query.status);
  p.set('page', String(query.page ?? 1));
  p.set('pageSize', String(query.pageSize ?? 50));
  return apiGetPage<ApiKeyRequestInfo>(`/api/api-key-requests?${p}`, { signal });
};
export const approveRequest = (id: string, body: ApproveKeyRequestBody) => apiPost<ApiKeyRequestInfo>(`/api/api-key-requests/${enc(id)}/approve`, body);
export const denyRequest = (id: string, body: DenyKeyRequestBody) => apiPost<ApiKeyRequestInfo>(`/api/api-key-requests/${enc(id)}/deny`, body);
