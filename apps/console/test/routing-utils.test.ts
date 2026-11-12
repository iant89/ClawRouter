import { describe, expect, test } from 'bun:test';
import type { ModelAlias, RoutingConfigView } from '@clawrouter/shared';
import { describePolicy, summarizeTargets, withAlias, withDefaultPolicy } from '../src/features/routing/routing-utils.ts';

const alias = (name: string, extra: Partial<ModelAlias> = {}): ModelAlias => ({ name, description: '', enabled: true, capabilities: [], targets: [], policy: null, ...extra });
const config = (aliases: ModelAlias[]): RoutingConfigView => ({
  version: 4, defaultPolicy: { failover: 'NONE', maxAttempts: 1, retriesPerTarget: 0 }, aliases, updatedAt: null, updatedBy: null, problems: [],
});

describe('routing helpers', () => {
  test('describePolicy', () => {
    expect(describePolicy({ failover: 'RETRY_AND_FAILOVER', maxAttempts: 3, retriesPerTarget: 1 })).toBe('Retry, then fail over · up to 3 attempts · 1 retry per model');
    expect(describePolicy({ failover: 'FAILOVER_PROVIDER', maxAttempts: 1, retriesPerTarget: 2 })).toBe('Fail over to the next model · up to 1 attempt');
  });

  test('summarizeTargets groups by priority and shows non-default weights', () => {
    const a = alias('m', { targets: [{ modelRef: 'b/y', priority: 1, weight: 3 }, { modelRef: 'a/x', priority: 0, weight: 1 }, { modelRef: 'c/z', priority: 1, weight: 1 }] });
    expect(summarizeTargets(a)).toBe('a/x → b/y (w3), c/z');
    expect(summarizeTargets(alias('e', { capabilities: ['EMBEDDINGS'] }))).toBe('Any usable model with EMBEDDINGS');
  });

  test('withAlias adds at the end, replaces in place (also on rename), removes; keeps the version', () => {
    const c = config([alias('one'), alias('two'), alias('three')]);
    expect(withAlias(c, alias('four'), null).aliases.map((a) => a.name)).toEqual(['one', 'two', 'three', 'four']);
    expect(withAlias(c, alias('TWO-renamed'), 'two').aliases.map((a) => a.name)).toEqual(['one', 'TWO-renamed', 'three']);
    expect(withAlias(c, null, 'two').aliases.map((a) => a.name)).toEqual(['one', 'three']);
    expect(withAlias(c, null, 'two').version).toBe(4);
    expect(withDefaultPolicy(c, { failover: 'FAILOVER_PROVIDER', maxAttempts: 2, retriesPerTarget: 0 })).toMatchObject({ version: 4, aliases: c.aliases });
  });
});
