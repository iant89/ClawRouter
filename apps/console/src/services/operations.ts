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
