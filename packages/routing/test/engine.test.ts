import { describe, expect, test } from 'bun:test';
import { DEFAULT_ROUTING_POLICY, type Capability, type ModelAlias, type ModelInfo, type ProviderState, type RoutingConfig } from '@clawrouter/shared';
import { expandAttempts, planRoute, seededRandom, weightedShuffle, type RoutingSnapshot } from '../src/index.ts';

/** A model as the registry reports it. Only the fields routing reads matter. */
function model(ref: string, opts: { status?: ProviderState; caps?: Capability[]; usable?: boolean; reason?: string } = {}): ModelInfo {
  const [identifier, providerModelId] = [ref.slice(0, ref.indexOf('/')), ref.slice(ref.indexOf('/') + 1)];
  return {
    id: `m-${ref}`, ref, providerId: `p-${identifier}`, providerModelId, displayName: providerModelId,
    capabilities: opts.caps ?? ['CHAT'], contextLength: null, maxOutputTokens: null, enabled: true, availability: 'AVAILABLE',
    availabilityCheckedAt: null, source: 'MANUAL', cost: null, maxKeyLifetimeHours: null, keyLifetimeLimit: null,
    provider: { id: `p-${identifier}`, name: identifier, identifier, kind: 'openai', enabled: true, status: opts.status ?? 'HEALTHY' },
    usable: opts.usable ?? true, unusableReason: opts.usable === false ? (opts.reason ?? 'Provider is offline') : null,
    createdAt: '', updatedAt: '',
  };
}

const alias = (name: string, targets: [string, number, number?][], extra: Partial<ModelAlias> = {}): ModelAlias => ({
  name, description: '', enabled: true, capabilities: [], policy: null,
  targets: targets.map(([modelRef, priority, weight]) => ({ modelRef, priority, weight: weight ?? 1 })),
  ...extra,
});

function snap(models: ModelInfo[], aliases: ModelAlias[] = [], extra: Partial<RoutingSnapshot> = {}): RoutingSnapshot {
  const config: RoutingConfig = { version: 1, defaultPolicy: { ...DEFAULT_ROUTING_POLICY }, aliases, updatedAt: null, updatedBy: null };
  return { config, models, providerPriority: new Map([['p-a', 10], ['p-b', 20], ['local', 30]]), random: seededRandom(1), ...extra };
}

const refs = (r: ReturnType<typeof planRoute>) => (r.ok ? r.plan.candidates.map((c) => c.modelRef) : r.reason);

describe('resolution (spec §10: explicit model, alias, provider model id)', () => {
  const models = [model('a/x'), model('b/y'), model('local/z'), model('b/x')];

  test('the spec example: fast-code -> primary A/X, fallback B/Y, fallback Local/Z', () => {
    const r = planRoute({ model: 'fast-code' }, snap(models, [alias('fast-code', [['a/x', 0], ['b/y', 1], ['local/z', 2]])]));
    expect(refs(r)).toEqual(['a/x', 'b/y', 'local/z']);
    expect(r.ok && r.plan.resolvedAs).toBe('alias');
  });

  test('aliases are case-insensitive', () => {
    expect(refs(planRoute({ model: 'FAST-CODE' }, snap(models, [alias('fast-code', [['a/x', 0]])])))).toEqual(['a/x']);
  });

  test('a model reference means exactly that model', () => {
    const r = planRoute({ model: 'b/y' }, snap(models));
    expect(refs(r)).toEqual(['b/y']);
    expect(r.ok && r.plan.resolvedAs).toBe('model_ref');
  });

  test('a provider model id matches every provider offering it, by provider priority', () => {
    const r = planRoute({ model: 'x' }, snap(models));
    expect(refs(r)).toEqual(['a/x', 'b/x']);
    expect(r.ok && r.plan.resolvedAs).toBe('model_id');
  });

  test('aliases win over model ids with the same name', () => {
    expect(refs(planRoute({ model: 'x' }, snap(models, [alias('x', [['local/z', 0]])])))).toEqual(['local/z']);
  });

  test('unknown names and disabled aliases fail with a clear reason', () => {
    expect(planRoute({ model: 'nope' }, snap(models))).toMatchObject({ ok: false, reason: expect.stringContaining('Unknown model "nope"') });
    expect(planRoute({ model: 'a/nope' }, snap(models))).toMatchObject({ ok: false, reason: 'Unknown model "a/nope".' });
    expect(planRoute({ model: 'off' }, snap(models, [alias('off', [['a/x', 0]], { enabled: false })]))).toMatchObject({ ok: false, reason: 'The alias "off" is disabled.' });
    expect(planRoute({ model: '  ' }, snap(models))).toMatchObject({ ok: false });
  });
});

describe('eligibility (disabled providers/models, availability, capabilities)', () => {
  test('unusable models are excluded with their reason; the rest still route', () => {
    const models = [model('a/x', { usable: false, reason: 'Provider is disabled' }), model('b/y', { usable: false, reason: 'Model is disabled' }), model('local/z')];
    const r = planRoute({ model: 'fast' }, snap(models, [alias('fast', [['a/x', 0], ['b/y', 1], ['local/z', 2], ['gone/m', 3]])]));
    expect(refs(r)).toEqual(['local/z']);
    expect(r.ok && r.plan.excluded).toEqual([
      { modelRef: 'gone/m', reason: 'Model is not registered' },
      { modelRef: 'a/x', reason: 'Provider is disabled' },
      { modelRef: 'b/y', reason: 'Model is disabled' },
    ]);
  });

  test('nothing eligible -> failure listing why', () => {
    const r = planRoute({ model: 'fast' }, snap([model('a/x', { usable: false })], [alias('fast', [['a/x', 0]])]));
    expect(r).toMatchObject({ ok: false, reason: 'No usable model for alias "fast".', excluded: [{ modelRef: 'a/x', reason: 'Provider is offline' }] });
  });

  test('required capabilities filter candidates (request and alias capabilities combine)', () => {
    const models = [model('a/x', { caps: ['CHAT'] }), model('b/y', { caps: ['CHAT', 'VISION'] })];
    const r = planRoute({ model: 'smart', capabilities: ['VISION'] }, snap(models, [alias('smart', [['a/x', 0], ['b/y', 1]])]));
    expect(refs(r)).toEqual(['b/y']);
    expect(r.ok && r.plan.excluded).toEqual([{ modelRef: 'a/x', reason: 'Missing capabilities: VISION' }]);
    expect(r.ok && r.plan.requiredCapabilities).toEqual(['VISION']);
  });

  test('a capability alias (no targets) picks any usable model with the capabilities, by provider priority', () => {
    const models = [model('b/emb', { caps: ['EMBEDDINGS'] }), model('a/chat'), model('a/emb', { caps: ['EMBEDDINGS'] })];
    const r = planRoute({ model: 'embed' }, snap(models, [alias('embed', [], { capabilities: ['EMBEDDINGS'] })]));
    expect(refs(r)).toEqual(['a/emb', 'b/emb']);
  });
});

describe('ordering (priority, health, weights, failure history)', () => {
  test('priority beats health; health orders within a priority level', () => {
    const models = [model('a/x', { status: 'DEGRADED' }), model('b/y', { status: 'UNKNOWN' }), model('local/z', { status: 'HEALTHY' }), model('b/w', { status: 'HEALTHY' })];
    const r = planRoute({ model: 'm' }, snap(models, [alias('m', [['a/x', 0], ['b/y', 1], ['local/z', 1], ['b/w', 2]])]));
    // a/x is primary even though degraded; at priority 1 the healthy local/z goes before the unchecked b/y.
    expect(refs(r)).toEqual(['a/x', 'local/z', 'b/y', 'b/w']);
  });

  test('weights split traffic within a priority level (about 3:1 over many requests)', () => {
    const models = [model('a/x'), model('b/y')];
    const s = snap(models, [alias('m', [['a/x', 0, 3], ['b/y', 0, 1]])], { random: seededRandom(7) });
    let first = 0;
    for (let i = 0; i < 4000; i++) {
      const r = planRoute({ model: 'm' }, s);
      if (r.ok && r.plan.candidates[0]!.modelRef === 'a/x') first++;
    }
    expect(first / 4000).toBeGreaterThan(0.72);
    expect(first / 4000).toBeLessThan(0.78);
  });

  test('deterministic: the same inputs and random seed give the same plan', () => {
    const models = [model('a/x'), model('b/y'), model('local/z')];
    const aliases = [alias('m', [['a/x', 0, 5], ['b/y', 0, 5], ['local/z', 0, 5]])];
    const one = refs(planRoute({ model: 'm' }, snap(models, aliases, { random: seededRandom(99) })));
    const two = refs(planRoute({ model: 'm' }, snap(models, aliases, { random: seededRandom(99) })));
    expect(one).toEqual(two);
  });

  test('providers with repeated recent failures are tried last, not dropped', () => {
    const models = [model('a/x'), model('b/y'), model('local/z')];
    const failures = (id: string) => (id === 'p-a' ? 3 : id === 'p-b' ? 1 : 0);
    const r = planRoute({ model: 'm' }, snap(models, [alias('m', [['a/x', 0], ['b/y', 1], ['local/z', 2]])], { failures }));
    expect(refs(r)).toEqual(['b/y', 'local/z', 'a/x']);
    expect(r.ok && r.plan.candidates.map((c) => c.recentFailures)).toEqual([1, 0, 3]);
  });
});

describe('failover policies (spec §11) and the attempt ceiling', () => {
  const p = (failover: 'NONE' | 'RETRY_SAME_PROVIDER' | 'FAILOVER_PROVIDER' | 'RETRY_AND_FAILOVER', maxAttempts = 10, retriesPerTarget = 1) => ({ failover, maxAttempts, retriesPerTarget });
  const seq = (a: ReturnType<typeof expandAttempts>) => a.map((x) => `${x.candidate}.${x.try}`).join(' ');

  test.each([
    ['NONE', '0.1'],
    ['RETRY_SAME_PROVIDER', '0.1 0.2'],
    ['FAILOVER_PROVIDER', '0.1 1.1 2.1'],
    ['RETRY_AND_FAILOVER', '0.1 0.2 1.1 1.2 2.1 2.2'],
  ] as const)('%s', (policy, expected) => {
    expect(seq(expandAttempts(3, p(policy)))).toBe(expected);
  });

  test('maxAttempts caps the sequence, so a request can never loop', () => {
    expect(seq(expandAttempts(3, p('RETRY_AND_FAILOVER', 3)))).toBe('0.1 0.2 1.1');
    expect(expandAttempts(50, p('FAILOVER_PROVIDER', 10))).toHaveLength(10);
    expect(expandAttempts(0, p('FAILOVER_PROVIDER'))).toEqual([]);
  });

  test('an alias policy overrides the default; out-of-range values are clamped', () => {
    const models = [model('a/x'), model('b/y')];
    const r = planRoute({ model: 'm' }, snap(models, [alias('m', [['a/x', 0], ['b/y', 1]], { policy: { failover: 'FAILOVER_PROVIDER', maxAttempts: 99, retriesPerTarget: 0 } })]));
    expect(r.ok && r.plan.policy).toEqual({ failover: 'FAILOVER_PROVIDER', maxAttempts: 10, retriesPerTarget: 0 });
    expect(r.ok && r.plan.attempts).toEqual([{ candidate: 0, try: 1 }, { candidate: 1, try: 1 }]);
  });
});

describe('weightedShuffle', () => {
  test('keeps every item exactly once and never picks a zero-weight item before a positive one', () => {
    const items = [{ id: 'a', weight: 0 }, { id: 'b', weight: 5 }, { id: 'c', weight: 1 }];
    for (let seed = 0; seed < 50; seed++) {
      const out = weightedShuffle(items, seededRandom(seed)).map((i) => i.id);
      expect([...out].sort()).toEqual(['a', 'b', 'c']);
      expect(out[2]).toBe('a');
    }
  });
});
