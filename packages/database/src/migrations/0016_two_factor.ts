import type { Migration } from '../migrations.ts';

/**
 * Two-factor sign-in (owner's request: methods and requirement are administrator
 * settings).
 *
 * - `users.email`: where email codes and security mail go. Optional; unique
 *   (case-insensitive) when set.
 * - `user_two_factor`: a user's enrolled methods. The authenticator secret is
 *   encrypted with the server's secret key (like provider credentials);
 *   `totp_last_step` stops a code from being used twice.
 * - `recovery_codes`: one-time codes for a lost phone, stored as hashes.
 * - `sign_in_challenges`: a password that was right, waiting for the second
 *   step. Short-lived; only a hash of the challenge token and of any emailed code.
 */
export const m0016TwoFactor: Migration = {
  id: '0016_two_factor',
  up: `
ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE;
CREATE UNIQUE INDEX users_email ON users (email) WHERE email IS NOT NULL;

CREATE TABLE user_two_factor (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  totp_ciphertext    TEXT,
  totp_key_fingerprint TEXT,
  totp_confirmed_at  TEXT,
  totp_last_step     INTEGER,
  email_enabled_at   TEXT,
  updated_at         TEXT NOT NULL
) STRICT;

CREATE TABLE recovery_codes (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at    TEXT,
  PRIMARY KEY (user_id, code_hash)
) STRICT;

CREATE TABLE sign_in_challenges (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('SIGN_IN', 'ENROLL_EMAIL', 'VERIFY_EMAIL')),
  code_hash   TEXT,
  code_sent_at TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
) STRICT;

CREATE INDEX sign_in_challenges_user ON sign_in_challenges (user_id, created_at);
`,
};
