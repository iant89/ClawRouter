import type { Migration } from '../migrations.ts';

/**
 * Console notifications. A notification goes to one user (`user_id`) or to
 * every holder of a permission (`audience_permission`), evaluated when read so
 * role changes apply. Read/dismissed state is per user.
 */
export const m0005Notifications: Migration = {
  id: '0005_notifications',
  up: `
CREATE TABLE notifications (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT REFERENCES users(id) ON DELETE CASCADE,
  audience_permission TEXT,
  severity            TEXT NOT NULL CHECK (severity IN ('INFO', 'SUCCESS', 'WARNING', 'ERROR')),
  title               TEXT NOT NULL,
  body                TEXT,
  link                TEXT,
  source              TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  CHECK ((user_id IS NULL) <> (audience_permission IS NULL))
) STRICT;

CREATE INDEX notifications_user ON notifications(user_id, created_at);
CREATE INDEX notifications_audience ON notifications(audience_permission, created_at);
CREATE INDEX notifications_created ON notifications(created_at);

CREATE TABLE notification_receipts (
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         TEXT,
  dismissed_at    TEXT,
  PRIMARY KEY (notification_id, user_id)
) STRICT;
`,
};
