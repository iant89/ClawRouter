import type { Migration } from '../migrations.ts';

/**
 * Where a model's price came from: PROVIDER (published by the provider, kept up
 * to date automatically) or MANUAL (entered by an administrator, never overwritten).
 * Prices entered before this migration were typed in by hand.
 */
export const m0019ModelCostSource: Migration = {
  id: '0019_model_cost_source',
  up: `
ALTER TABLE models ADD COLUMN cost_source TEXT CHECK (cost_source IN ('PROVIDER', 'MANUAL'));
UPDATE models SET cost_source = 'MANUAL' WHERE cost_input_per_mtok IS NOT NULL OR cost_output_per_mtok IS NOT NULL;
`,
};
