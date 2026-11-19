/*
 * ClawRouter - Self-hosted AI gateway and control platform
 * https://github.com/iant89/ClawRouter
 *
 * Copyright (C) 2026 Ian Thomas
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * in the LICENSE file for more details.
 */

import type { NotificationInfo, NotificationMeta } from '@clawrouter/shared';
import { apiDelete, apiPost, requestEnvelope } from './api-client.ts';

export async function fetchNotifications(signal?: AbortSignal): Promise<{ items: NotificationInfo[]; unread: number }> {
  const envelope = await requestEnvelope<NotificationInfo[]>('GET', '/api/notifications?limit=50', undefined, { signal });
  return { items: envelope.data, unread: (envelope.meta as NotificationMeta | undefined)?.unread ?? 0 };
}
export const markNotificationRead = (id: string) => apiPost<void>(`/api/notifications/${encodeURIComponent(id)}/read`);
export const markAllNotificationsRead = () => apiPost<{ marked: number }>('/api/notifications/read-all');
export const dismissNotification = (id: string) => apiDelete(`/api/notifications/${encodeURIComponent(id)}`);
