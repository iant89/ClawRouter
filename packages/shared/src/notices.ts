/**
 * Client notices (owner request, 2026-11-17): short messages ClawRouter adds to
 * gateway responses, in a header (`X-ClawRouter-Notices`) and, optionally, as a
 * line at the start of the reply. System notices come from ClawRouter itself
 * (degraded health, failover); announcements are written by administrators.
 */

/** The response header. Its value is a JSON array of `{ kind, text }`, ASCII only (non-ASCII as \u escapes). */
export const NOTICE_HEADER = 'x-clawrouter-notices';

/** System notice kinds, each with an editable default message. */
export const SYSTEM_NOTICE_KINDS = ['health', 'failover'] as const;
export type SystemNoticeKind = (typeof SYSTEM_NOTICE_KINDS)[number];
export type NoticeKind = SystemNoticeKind | 'announcement';

export const SYSTEM_NOTICE_LABELS: Record<SystemNoticeKind, { label: string; when: string }> = {
  health: { label: 'Degraded health', when: "ClawRouter's health, or the health of the provider that answered, is degraded or offline." },
  failover: { label: 'Failover', when: 'The request was answered by another model because the first choice failed.' },
};

export interface NoticeMessage {
  enabled: boolean;
  text: string;
}

/** GET/PUT /api/settings/notices: the default messages. */
export interface NoticeMessages {
  health: NoticeMessage;
  failover: NoticeMessage;
  updatedAt: string | null;
}

export const DEFAULT_NOTICE_MESSAGES: Record<SystemNoticeKind, NoticeMessage> = {
  health: { enabled: true, text: 'ClawRouter health has degraded; you may experience temporary performance issues.' },
  failover: { enabled: true, text: 'Your request was answered by a backup model because the first choice was unavailable.' },
};

export const NOTICE_TEXT_MAX = 300;

/**
 * The icons an announcement can start with (owner request, 2026-11-17). A fixed
 * list, because the cleanup recognises ClawRouter's notice lines by their icon:
 * never remove an icon from it (old replies sent back would keep their line).
 */
export const ANNOUNCEMENT_ICONS = [
  { icon: '📢', label: 'Announcement' },
  { icon: '📣', label: 'Megaphone' },
  { icon: 'ℹ️', label: 'Information' },
  { icon: '💡', label: 'Tip' },
  { icon: '⚠️', label: 'Warning' },
  { icon: '❗', label: 'Important' },
  { icon: '🛠️', label: 'Maintenance' },
  { icon: '⏰', label: 'Scheduled' },
  { icon: '🚀', label: 'New feature' },
  { icon: '🎉', label: 'Celebration' },
  { icon: '✅', label: 'Resolved' },
  { icon: '🔒', label: 'Security' },
  { icon: '📅', label: 'Event' },
  { icon: '🆕', label: 'New' },
] as const;
export type AnnouncementIcon = (typeof ANNOUNCEMENT_ICONS)[number]['icon'];
export const DEFAULT_ANNOUNCEMENT_ICON: AnnouncementIcon = '📢';
export const SYSTEM_NOTICE_ICON = '⚠️';
export const isAnnouncementIcon = (v: unknown): v is AnnouncementIcon => ANNOUNCEMENT_ICONS.some((i) => i.icon === v);

/** How often an announcement reaches each user (the key's owner). */
export const ANNOUNCEMENT_FREQUENCIES = ['every_request', 'once', 'daily', 'weekly'] as const;
export type AnnouncementFrequency = (typeof ANNOUNCEMENT_FREQUENCIES)[number];
export const ANNOUNCEMENT_FREQUENCY_LABELS: Record<AnnouncementFrequency, string> = {
  every_request: 'Every request',
  once: 'Once per user',
  daily: 'Once a day (first request of the day)',
  weekly: 'Once a week (first request of the week)',
};

/** Where an announcement is shown. */
export const ANNOUNCEMENT_CHANNELS = ['both', 'header', 'reply'] as const;
export type AnnouncementChannel = (typeof ANNOUNCEMENT_CHANNELS)[number];
export const ANNOUNCEMENT_CHANNEL_LABELS: Record<AnnouncementChannel, string> = {
  both: 'Header and reply text',
  header: 'Header only',
  reply: 'Reply text only',
};

/** GET /api/announcements */
export interface AnnouncementInfo {
  id: string;
  message: string;
  /** The icon the notice line starts with. */
  icon: AnnouncementIcon;
  frequency: AnnouncementFrequency;
  channel: AnnouncementChannel;
  /** Not sent before this time; null: at once. */
  startsAt: string | null;
  /** Deleted at this time; null: kept until deleted. */
  expiresAt: string | null;
  /** Where "a day" and "a week" begin (IANA time zone). */
  timeZone: string;
  enabled: boolean;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  /** Users it has been sent to at least once. */
  reachedUsers: number;
  /** Times it was sent in total. */
  deliveries: number;
}

/** POST /api/announcements, PATCH /api/announcements/:id (all optional on PATCH). */
export interface AnnouncementInput {
  message: string;
  /** Default 📢. */
  icon?: AnnouncementIcon;
  frequency: AnnouncementFrequency;
  channel: AnnouncementChannel;
  startsAt?: string | null;
  expiresAt?: string | null;
  timeZone: string;
  enabled?: boolean;
}

export const ANNOUNCEMENTS_ACTIVE_MAX = 20;

/** One notice for one response. */
export interface Notice {
  kind: NoticeKind;
  text: string;
  /** The line's icon (announcements choose theirs; system notices use ⚠️). */
  icon: string;
  /** Where it may go. System notices: both (each subject to its setting). */
  channel: AnnouncementChannel;
}

/** What the gateway asks before answering (implemented by packages/notices). */
export interface NoticeSource {
  /** Notices for this response. `failedOver`: another model answered; `providerStatus`: the answering provider's status. */
  noticesFor(input: { keyId: string; ownerId: string | null; failedOver: boolean; providerStatus: string | null; replyAllowed: boolean }): {
    header: Notice[];
    reply: Notice[];
  };
  /** Whether ClawRouter's notice lines are removed from assistant messages sent back by clients. */
  cleanupEnabled(): boolean;
}
