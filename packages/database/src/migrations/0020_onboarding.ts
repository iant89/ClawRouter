import type { Migration } from '../migrations.ts';

/**
 * First-run onboarding (owner request, 2026-11-16): a setup wizard after the
 * first administrator is created, and a guided tour at each user's first sign-in.
 * Existing installations and users have already found their way around: their
 * wizard is marked completed and their tour seen, so neither appears after an
 * upgrade. Only new users (and a fresh installation) get them.
 */
export const m0020Onboarding: Migration = {
  id: '0020_onboarding',
  up: `
ALTER TABLE users ADD COLUMN tour_state TEXT NOT NULL DEFAULT 'PENDING' CHECK (tour_state IN ('PENDING', 'COMPLETED', 'SKIPPED'));
UPDATE users SET tour_state = 'COMPLETED';
INSERT INTO settings (key, value, updated_at)
  SELECT 'onboarding.setup_wizard', '{"status":"COMPLETED","step":null}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE EXISTS (SELECT 1 FROM users);
`,
};
