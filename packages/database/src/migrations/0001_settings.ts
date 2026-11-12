import type { Migration } from '../migrations.ts';

/** Key/value system settings (spec §30 SETTINGS). Values are JSON. Never store secrets here. */
export const m0001Settings: Migration = {
  id: '0001_settings',
  up: `
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`,
};
