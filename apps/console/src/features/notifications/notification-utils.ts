import type { NotificationInfo, NotificationSeverity } from '@clawapi/shared';

export const SEVERITY_LABEL: Record<NotificationSeverity, string> = {
  INFO: 'Info',
  SUCCESS: 'Resolved',
  WARNING: 'Warning',
  ERROR: 'Error',
};

/** Title with the severity in words, so it never depends on color (spec §18). */
export function displayTitle(n: Pick<NotificationInfo, 'severity' | 'title'>): string {
  return `${SEVERITY_LABEL[n.severity]}: ${n.title}`;
}

/** Unread warnings and errors not seen in the previous poll. */
export function newAlerts(items: NotificationInfo[], known: ReadonlySet<string>): NotificationInfo[] {
  return items.filter((n) => !known.has(n.id) && !n.read && (n.severity === 'WARNING' || n.severity === 'ERROR'));
}
