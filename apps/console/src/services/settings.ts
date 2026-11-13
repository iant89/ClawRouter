import type { SettingInfo, UpdateSettingsRequest } from '@clawrouter/shared';
import { apiGet, apiPut } from './api-client.ts';

export const fetchSettings = (signal?: AbortSignal) => apiGet<SettingInfo[]>('/api/settings', { signal });
export const saveSettings = (values: UpdateSettingsRequest['values']) => apiPut<SettingInfo[]>('/api/settings', { values } satisfies UpdateSettingsRequest);
