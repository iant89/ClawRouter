import type { NotificationInfo, NotificationMeta } from '@clawapi/shared';
import { apiDelete, apiPost, requestEnvelope } from './api-client.ts';

export async function fetchNotifications(signal?: AbortSignal): Promise<{ items: NotificationInfo[]; unread: number }> {
  const envelope = await requestEnvelope<NotificationInfo[]>('GET', '/api/notifications?limit=50', undefined, { signal });
  return { items: envelope.data, unread: (envelope.meta as NotificationMeta | undefined)?.unread ?? 0 };
}
export const markNotificationRead = (id: string) => apiPost<void>(`/api/notifications/${encodeURIComponent(id)}/read`);
export const markAllNotificationsRead = () => apiPost<{ marked: number }>('/api/notifications/read-all');
export const dismissNotification = (id: string) => apiDelete(`/api/notifications/${encodeURIComponent(id)}`);
