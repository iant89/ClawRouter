import type { Migration } from '../migrations.ts';

/**
 * Provider captures (owner request, 2026-11-17): the full exchange of a gateway
 * request with its providers, kept when something went wrong (or on request) so it
 * can be exported for a developer. Kept until deleted, capped by count (setting
 * capturesMaxCount). `data` holds the bodies and headers as JSON; credentials are
 * removed before anything is written.
 */
export const m0023ProviderCaptures: Migration = {
  id: '0023_provider_captures',
  up: `
    CREATE TABLE provider_captures (
      id              TEXT PRIMARY KEY,
      created_at      TEXT NOT NULL,
      trigger         TEXT NOT NULL CHECK (trigger IN ('error', 'parse_error', 'manual')),
      request_id      TEXT NOT NULL,
      endpoint        TEXT NOT NULL,
      stream          INTEGER NOT NULL DEFAULT 0,
      requested_model TEXT NOT NULL,
      model_ref       TEXT,
      provider_id     TEXT,
      provider_name   TEXT,
      status          TEXT NOT NULL,
      http_status     INTEGER NOT NULL,
      error_code      TEXT,
      error_message   TEXT,
      exchange_count  INTEGER NOT NULL,
      size_bytes      INTEGER NOT NULL,
      data            TEXT NOT NULL
    );
    CREATE INDEX provider_captures_created ON provider_captures (created_at DESC, id DESC);
  `,
};
