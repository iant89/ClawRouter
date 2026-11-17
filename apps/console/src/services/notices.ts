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
