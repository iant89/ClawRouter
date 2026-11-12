/** Console notifications (spec §17 header, §25 `notification.created`). */
export const NOTIFICATION_SEVERITIES = ['INFO', 'SUCCESS', 'WARNING', 'ERROR'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export interface NotificationInfo {
  id: string;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  /** Console path with more detail, e.g. `/health`. */
  link: string | null;
  /** What produced it, e.g. `health.changed`. */
  source: string;
  createdAt: string;
  read: boolean;
}

/** GET /api/notifications meta */
export interface NotificationMeta {
  unread: number;
}
