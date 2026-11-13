import type { HealthHistoryReport, HealthReport } from '@clawrouter/shared';
import { apiGet } from './api-client.ts';

export function fetchHealth(signal?: AbortSignal): Promise<HealthReport> {
  return apiGet<HealthReport>('/api/health', { signal, acceptStatus: [503] });
}

export function fetchHealthHistory(hours: number, signal?: AbortSignal): Promise<HealthHistoryReport> {
  return apiGet<HealthHistoryReport>(`/api/health/history?hours=${hours}`, { signal });
}
