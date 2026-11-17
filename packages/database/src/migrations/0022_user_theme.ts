import type { Migration } from '../migrations.ts';

/**
 * Each user's console theme (owner request, 2026-11-17): light, dark or system
 * (follow the device). Null means the default, dark (spec §18).
 */
export const m0022UserTheme: Migration = {
  id: '0022_user_theme',
  up: `ALTER TABLE users ADD COLUMN theme TEXT CHECK (theme IN ('light', 'dark', 'system'));`,
};
