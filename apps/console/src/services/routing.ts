import type { Capability, PutRoutingRequest, RoutePlan, RoutingConfigView } from '@clawrouter/shared';
import { apiGet, apiPost, apiPut } from './api-client.ts';

export const fetchRouting = (signal?: AbortSignal) => apiGet<RoutingConfigView>('/api/routing', { signal });
export const saveRouting = (body: PutRoutingRequest) => apiPut<RoutingConfigView>('/api/routing', body);
/** Dry run: nothing is sent to a provider. */
export const previewRoute = (model: string, capabilities: Capability[]) => apiPost<RoutePlan>('/api/routing/preview', { model, capabilities });
