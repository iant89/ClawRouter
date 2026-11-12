import type { Database } from '@clawapi/database';
import type { NotificationInfo, NotificationSeverity } from '@clawapi/shared';

export interface NewNotification {
  id: string;
  userId: string | null;
  audiencePermission: string | null;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  link: string | null;
  source: string;
  createdAt: string;
}

/** Who is asking: notifications addressed to them, or to a permission they hold. */
export interface Recipient {
  userId: string;
  permissions: readonly string[];
}

export interface NotificationRepository {
  insert(n: NewNotification): void;
  /** Visible, not dismissed, newest first. */
  listFor(recipient: Recipient, options: { limit: number; unreadOnly?: boolean }): NotificationInfo[];
  countUnread(recipient: Recipient): number;
  /** False when the notification is not visible to the recipient. */
  markRead(recipient: Recipient, id: string, at: string): boolean;
  markAllRead(recipient: Recipient, at: string): number;
  dismiss(recipient: Recipient, id: string, at: string): boolean;
  purge(before: string): number;
}

interface Row {
  id: string;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  link: string | null;
  source: string;
  created_at: string;
  read_at: string | null;
}

/** SQL that limits rows to the recipient (params: userId, userId, ...permissions). */
function visible(recipient: Recipient) {
  const perms = recipient.permissions.length ? recipient.permissions.map(() => '?').join(', ') : 'NULL';
  return {
    from: `notifications n LEFT JOIN notification_receipts r ON r.notification_id = n.id AND r.user_id = ?`,
    where: `(n.user_id = ? OR n.audience_permission IN (${perms})) AND r.dismissed_at IS NULL`,
    params: [recipient.userId, recipient.userId, ...recipient.permissions],
  };
}

export function createSqliteNotificationRepository(db: Database): NotificationRepository {
  const upsertReceipt = (id: string, userId: string, column: 'read_at' | 'dismissed_at', at: string) =>
    db.run(
      `INSERT INTO notification_receipts (notification_id, user_id, ${column}) VALUES (?, ?, ?)
       ON CONFLICT(notification_id, user_id) DO UPDATE SET ${column} = COALESCE(${column}, excluded.${column})`,
      [id, userId, at],
    );

  const isVisible = (recipient: Recipient, id: string) => {
    const v = visible(recipient);
    return db.get(`SELECT 1 AS ok FROM ${v.from} WHERE n.id = ? AND ${v.where}`, [recipient.userId, id, ...v.params.slice(1)]) !== undefined;
  };

  return {
    insert(n) {
      db.run(
        `INSERT INTO notifications (id, user_id, audience_permission, severity, title, body, link, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [n.id, n.userId, n.audiencePermission, n.severity, n.title, n.body, n.link, n.source, n.createdAt],
      );
    },
    listFor(recipient, { limit, unreadOnly }) {
      const v = visible(recipient);
      const rows = db.all<Row>(
        `SELECT n.id, n.severity, n.title, n.body, n.link, n.source, n.created_at, r.read_at
         FROM ${v.from} WHERE ${v.where} ${unreadOnly ? 'AND r.read_at IS NULL' : ''}
         ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
        [...v.params, limit],
      );
      return rows.map((r) => ({
        id: r.id, severity: r.severity, title: r.title, body: r.body, link: r.link, source: r.source,
        createdAt: r.created_at, read: r.read_at !== null,
      }));
    },
    countUnread(recipient) {
      const v = visible(recipient);
      return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${v.from} WHERE ${v.where} AND r.read_at IS NULL`, v.params)?.n ?? 0;
    },
    markRead(recipient, id, at) {
      if (!isVisible(recipient, id)) return false;
      upsertReceipt(id, recipient.userId, 'read_at', at);
      return true;
    },
    markAllRead(recipient, at) {
      return db.transaction(() => {
        const v = visible(recipient);
        const ids = db.all<{ id: string }>(`SELECT n.id FROM ${v.from} WHERE ${v.where} AND r.read_at IS NULL`, v.params).map((r) => r.id);
        for (const id of ids) upsertReceipt(id, recipient.userId, 'read_at', at);
        return ids.length;
      });
    },
    dismiss(recipient, id, at) {
      if (!isVisible(recipient, id)) return false;
      upsertReceipt(id, recipient.userId, 'dismissed_at', at);
      return true;
    },
    purge(before) {
      return db.run('DELETE FROM notifications WHERE created_at < ?', [before]).changes;
    },
  };
}
