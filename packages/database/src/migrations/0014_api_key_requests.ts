import type { Migration } from '../migrations.ts';

/**
 * API key requests: a user without permission to create keys asks for one; a
 * user with `api_keys.write` approves or denies; the requester then creates the
 * key themselves (the secret is never stored, and never seen by the approver).
 * `expiry` is the requested expiry as JSON (e.g. {"type":"after","hours":168}),
 * resolved when the key is created.
 */
export const m0014ApiKeyRequests: Migration = {
  id: '0014_api_key_requests',
  up: `
CREATE TABLE api_key_requests (
  id             TEXT PRIMARY KEY,
  requested_by   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  purpose        TEXT NOT NULL,
  allowed_models TEXT NOT NULL DEFAULT '[]',
  expiry         TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'DENIED', 'CANCELLED', 'FULFILLED')),
  created_at     TEXT NOT NULL,
  decided_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at     TEXT,
  decision_note  TEXT,
  api_key_id     TEXT REFERENCES api_keys(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX api_key_requests_status ON api_key_requests (status, created_at);
CREATE INDEX api_key_requests_requester ON api_key_requests (requested_by, created_at);
`,
};
