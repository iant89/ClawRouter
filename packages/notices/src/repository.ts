import type { Database } from '@clawrouter/database';
import type { AnnouncementChannel, AnnouncementFrequency, AnnouncementInfo } from '@clawrouter/shared';

export interface AnnouncementRecord {
  id: string;
  message: string;
  frequency: AnnouncementFrequency;
  channel: AnnouncementChannel;
  startsAt: string | null;
  expiresAt: string | null;
  timeZone: string;
  enabled: boolean;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
}

export interface Delivery {
  firstAt: string;
  lastAt: string;
  count: number;
}

export interface AnnouncementRepository {
  list(): AnnouncementInfo[];
  get(id: string): AnnouncementRecord | undefined;
  /** Enabled, started and not expired at `now`, oldest first. */
  active(now: string): AnnouncementRecord[];
  insert(a: AnnouncementRecord): void;
  update(a: AnnouncementRecord): void;
  delete(id: string): boolean;
  /** Deletes announcements whose expiry has passed; returns their ids. */
  deleteExpired(now: string): string[];
  delivery(announcementId: string, recipient: string): Delivery | undefined;
  recordDelivery(announcementId: string, recipient: string, at: string): void;
}

interface Row {
  id: string;
  message: string;
  frequency: AnnouncementFrequency;
  channel: AnnouncementChannel;
  starts_at: string | null;
  expires_at: string | null;
  time_zone: string;
  enabled: number;
  created_at: string;
  created_by: string | null;
  updated_at: string;
}

const toRecord = (r: Row): AnnouncementRecord => ({
  id: r.id, message: r.message, frequency: r.frequency, channel: r.channel, startsAt: r.starts_at, expiresAt: r.expires_at,
  timeZone: r.time_zone, enabled: r.enabled === 1, createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at,
});

export function createSqliteAnnouncementRepository(db: Database): AnnouncementRepository {
  return {
    list() {
      const rows = db.all<Row & { reached: number; total: number | null; created_by_name: string | null }>(
        `SELECT a.*, u.username AS created_by_name, COUNT(d.recipient) AS reached, SUM(d.count) AS total
         FROM announcements a LEFT JOIN announcement_deliveries d ON d.announcement_id = a.id LEFT JOIN users u ON u.id = a.created_by
         GROUP BY a.id ORDER BY a.created_at DESC, a.id DESC`,
      );
      return rows.map((r) => ({ ...toRecord(r), createdBy: r.created_by_name, reachedUsers: r.reached, deliveries: r.total ?? 0 }));
    },
    get(id) {
      const r = db.get<Row>('SELECT * FROM announcements WHERE id = ?', [id]);
      return r ? toRecord(r) : undefined;
    },
    active(now) {
      return db.all<Row>(
        `SELECT * FROM announcements
         WHERE enabled = 1 AND (starts_at IS NULL OR starts_at <= ?) AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at, id`,
        [now, now],
      ).map(toRecord);
    },
    insert(a) {
      db.run(
        `INSERT INTO announcements (id, message, frequency, channel, starts_at, expires_at, time_zone, enabled, created_at, created_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [a.id, a.message, a.frequency, a.channel, a.startsAt, a.expiresAt, a.timeZone, a.enabled ? 1 : 0, a.createdAt, a.createdBy, a.updatedAt],
      );
    },
    update(a) {
      db.run(
        `UPDATE announcements SET message = ?, frequency = ?, channel = ?, starts_at = ?, expires_at = ?, time_zone = ?, enabled = ?, updated_at = ? WHERE id = ?`,
        [a.message, a.frequency, a.channel, a.startsAt, a.expiresAt, a.timeZone, a.enabled ? 1 : 0, a.updatedAt, a.id],
      );
    },
    delete(id) {
      return db.run('DELETE FROM announcements WHERE id = ?', [id]).changes > 0;
    },
    deleteExpired(now) {
      const ids = db.all<{ id: string }>('SELECT id FROM announcements WHERE expires_at IS NOT NULL AND expires_at <= ?', [now]).map((r) => r.id);
      if (ids.length) db.run(`DELETE FROM announcements WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
      return ids;
    },
    delivery(announcementId, recipient) {
      const r = db.get<{ first_at: string; last_at: string; count: number }>(
        'SELECT first_at, last_at, count FROM announcement_deliveries WHERE announcement_id = ? AND recipient = ?', [announcementId, recipient],
      );
      return r ? { firstAt: r.first_at, lastAt: r.last_at, count: r.count } : undefined;
    },
    recordDelivery(announcementId, recipient, at) {
      db.run(
        `INSERT INTO announcement_deliveries (announcement_id, recipient, first_at, last_at, count) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT (announcement_id, recipient) DO UPDATE SET last_at = excluded.last_at, count = count + 1`,
        [announcementId, recipient, at, at],
      );
    },
  };
}
