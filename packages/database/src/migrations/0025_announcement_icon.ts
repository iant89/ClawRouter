import type { Migration } from '../migrations.ts';

/** The icon an announcement's notice line starts with (owner request, 2026-11-17); existing ones keep 📢. */
export const m0025AnnouncementIcon: Migration = {
  id: '0025_announcement_icon',
  up: `ALTER TABLE announcements ADD COLUMN icon TEXT NOT NULL DEFAULT '📢';`,
};
