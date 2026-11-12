import type { RequestDetail, RequestQuery, RequestRecord, UsageGroup, UsageReport } from '@clawrouter/shared';
import { apiGet, apiGetPage } from './api-client.ts';

export function fetchRequests(q: RequestQuery, signal?: AbortSignal) {
  const p = new URLSearchParams();
  if (q.page) p.set('page', String(q.page));
  if (q.pageSize) p.set('pageSize', String(q.pageSize));
  if (q.status) p.set('status', q.status);
  if (q.apiKeyId) p.set('apiKeyId', q.apiKeyId);
  if (q.providerId) p.set('providerId', q.providerId);
  if (q.model) p.set('model', q.model);
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  if (q.problemsOnly) p.set('problems', 'true');
  return apiGetPage<RequestRecord>(`/api/requests?${p}`, { signal });
}

export const fetchRequest = (id: string, signal?: AbortSignal) => apiGet<RequestDetail>(`/api/requests/${encodeURIComponent(id)}`, { signal });

export function fetchUsage(q: { from?: string; to?: string; bucket?: 'hour' | 'day'; groupBy?: UsageGroup }, signal?: AbortSignal) {
  const p = new URLSearchParams();
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  if (q.bucket) p.set('bucket', q.bucket);
  if (q.groupBy) p.set('groupBy', q.groupBy);
  return apiGet<UsageReport>(`/api/usage?${p}`, { signal });
}
