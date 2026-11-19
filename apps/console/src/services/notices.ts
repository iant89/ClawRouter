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

import type { AnnouncementInfo, AnnouncementInput, NoticeMessage, NoticeMessages, SystemNoticeKind } from '@clawrouter/shared';
import { apiDelete, apiGet, apiPost, apiPut, request } from './api-client.ts';

/** Client notices: the default messages (Settings) and announcements (Administration → Announcements). */
export const fetchNoticeMessages = (signal?: AbortSignal) => apiGet<NoticeMessages>('/api/settings/notices', { signal });
export const saveNoticeMessages = (body: Partial<Record<SystemNoticeKind, Partial<NoticeMessage>>>) => apiPut<NoticeMessages>('/api/settings/notices', body);
export const resetNoticeMessages = () => apiDelete<NoticeMessages>('/api/settings/notices');

export const fetchAnnouncements = (signal?: AbortSignal) => apiGet<AnnouncementInfo[]>('/api/announcements', { signal });
export const createAnnouncement = (body: AnnouncementInput) => apiPost<AnnouncementInfo>('/api/announcements', body);
export const updateAnnouncement = (id: string, body: Partial<AnnouncementInput>) => request<AnnouncementInfo>('PATCH', `/api/announcements/${encodeURIComponent(id)}`, body);
export const deleteAnnouncement = (id: string) => apiDelete(`/api/announcements/${encodeURIComponent(id)}`);
