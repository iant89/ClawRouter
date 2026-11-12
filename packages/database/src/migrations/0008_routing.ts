import type { Migration } from '../migrations.ts';

/**
 * Routing configuration (spec §10, §30 ROUTING_RULES): one versioned JSON
 * document holding the default policy and the model aliases. A single row keeps
 * saves atomic and makes optimistic concurrency (the version) trivial.
 */
export const m0008Routing: Migration = {
  id: '0008_routing',
  up: `
CREATE TABLE routing_config (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  document   TEXT NOT NULL,
  version    INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
) STRICT;
`,
};
