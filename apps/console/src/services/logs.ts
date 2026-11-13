import type { LogPage, LogQuery } from '@clawrouter/shared';
import { apiGet } from './api-client.ts';

export function fetchLogs(q: LogQuery, signal?: AbortSignal) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  return apiGet<LogPage>(`/api/logs?${p}`, { signal });
}
