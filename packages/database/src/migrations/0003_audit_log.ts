import type { Migration } from '../migrations.ts';

/** Security audit trail (spec §28). Metadata is JSON and never contains secrets. */
export const m0003AuditLog: Migration = {
  id: '0003_audit_log',
  up: `
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  timestamp   TEXT NOT NULL,
  actor_id    TEXT,
  actor_name  TEXT,
  action      TEXT NOT NULL,
  resource    TEXT,
  resource_id TEXT,
  result      TEXT NOT NULL CHECK (result IN ('SUCCESS', 'FAILURE')),
  ip          TEXT,
  request_id  TEXT,
  metadata    TEXT
) STRICT;

CREATE INDEX audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX audit_log_action ON audit_log(action, timestamp);
CREATE INDEX audit_log_actor ON audit_log(actor_id, timestamp);
`,
};
