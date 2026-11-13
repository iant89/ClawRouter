import type { Migration } from '../migrations.ts';

/**
 * Maximum API key lifetime per provider and per model (owner's request). NULL:
 * no limit. A model's effective limit is the stricter of its own and its
 * provider's. Keys for specific models must expire within it, and a key older
 * than the limit can no longer use the model.
 */
export const m0015KeyLifetimeLimits: Migration = {
  id: '0015_key_lifetime_limits',
  up: `
ALTER TABLE providers ADD COLUMN max_key_lifetime_hours INTEGER CHECK (max_key_lifetime_hours IS NULL OR max_key_lifetime_hours > 0);
ALTER TABLE models ADD COLUMN max_key_lifetime_hours INTEGER CHECK (max_key_lifetime_hours IS NULL OR max_key_lifetime_hours > 0);
`,
};
