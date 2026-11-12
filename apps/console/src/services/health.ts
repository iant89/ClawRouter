import type { HealthReport } from '@clawapi/shared';
import { apiGet } from './api-client.ts';

export function fetchHealth(signal?: AbortSignal): Promise<HealthReport> {
  return apiGet<HealthReport>('/api/health', { signal, acceptStatus: [503] });
}
