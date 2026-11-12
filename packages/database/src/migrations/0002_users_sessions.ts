import type { Migration } from '../migrations.ts';

/**
 * Console users and server-side sessions (spec §15, §30).
 * Sessions store a SHA-256 hash of the cookie token, never the token itself,
 * so a copy of the database cannot be used to hijack sessions.
 */
export const m0002UsersSessions: Migration = {
  id: '0002_users_sessions',
  up: `
CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  username            TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name        TEXT NOT NULL,
  password_hash       TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  password_changed_at TEXT NOT NULL,
  last_login_at       TEXT
) STRICT;

CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  token_hash     TEXT NOT NULL UNIQUE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  ip             TEXT,
  user_agent     TEXT,
  revoked_at     TEXT,
  revoked_reason TEXT
) STRICT;

CREATE INDEX sessions_user_id ON sessions(user_id);
CREATE INDEX sessions_expires_at ON sessions(expires_at);
`,
};
