import {
  MAX_ATTEMPTS_CEILING, type Capability, type ModelAlias, type ModelInfo, type ProviderState, type RouteAttempt, type RouteCandidate,
  type RoutePlan, type RouteResolution, type RoutingConfig, type RoutingPolicy,
} from '@clawrouter/shared';

/**
 * The routing engine (spec §10, §11). Pure: no HTTP, database, clock or UI. Given
 * a request and a snapshot of models, providers and failure history, it decides
 * which models to try and in what order. Executing the attempts is the
 * gateway's job (phase 8).
 */
export interface RouteRequest {
  /** What the client sent as `model`: an alias, a model reference or a provider model id. */
  model: string;
  /** Capabilities the request needs (e.g. VISION for image input, EMBEDDINGS for /v1/embeddings). */
  capabilities?: Capability[];
}

export interface RoutingSnapshot {
  config: RoutingConfig;
  /** Every registered model, usable or not (unusable ones are reported as excluded). */
  models: ModelInfo[];
  /** Provider priority by provider id (lower first). */
  providerPriority: ReadonlyMap<string, number>;
  /** Recent failures per provider id (gateway failure history). */
  failures?: (providerId: string) => number;
  /** Providers with at least this many recent failures go to the back of the plan. */
  demoteAfterFailures?: number;
  /** Random source in [0, 1) for weighted choice. Inject a seeded one for reproducible plans. */
  random?: () => number;
}

export type RouteResult =
  | { ok: true; plan: RoutePlan }
  | { ok: false; reason: string; excluded: RoutePlan['excluded']; resolvedAs: RouteResolution | null };

/** Health tiers within one priority level: verified healthy first. */
const HEALTH_TIER: Record<ProviderState, number> = { HEALTHY: 0, UNKNOWN: 1, DEGRADED: 2, OFFLINE: 3, DISABLED: 3 };

interface Pending {
  model: ModelInfo;
  priority: number;
  weight: number;
}

export function planRoute(request: RouteRequest, snap: RoutingSnapshot): RouteResult {
  const name = request.model.trim();
  const random = snap.random ?? Math.random;
  const failures = snap.failures ?? (() => 0);
  const demoteAfter = snap.demoteAfterFailures ?? 3;
  const excluded: RoutePlan['excluded'] = [];
  const fail = (reason: string, resolvedAs: RouteResolution | null): RouteResult => ({ ok: false, reason, excluded, resolvedAs });

  if (!name) return fail('No model was requested.', null);

  // 1. Resolve the name: alias, then model reference, then provider model id.
  const alias = snap.config.aliases.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? null;
  let resolvedAs: RouteResolution;
  let pending: Pending[];
  let aliasCaps: Capability[] = [];
  if (alias) {
    if (!alias.enabled) return fail(`The alias "${alias.name}" is disabled.`, 'alias');
    resolvedAs = 'alias';
    aliasCaps = alias.capabilities;
    pending = aliasCandidates(alias, snap, excluded);
  } else if (name.includes('/')) {
    resolvedAs = 'model_ref';
    const model = snap.models.find((m) => m.ref === name);
    if (!model) return fail(`Unknown model "${name}".`, resolvedAs);
    pending = [{ model, priority: 0, weight: 1 }];
  } else {
    resolvedAs = 'model_id';
    pending = snap.models
      .filter((m) => m.providerModelId === name)
      .map((model) => ({ model, priority: snap.providerPriority.get(model.providerId) ?? 100, weight: 1 }));
    if (!pending.length) {
      return fail(`Unknown model "${name}". Use a model alias, a model reference such as "openai/gpt-4o", or a model id offered by a provider.`, resolvedAs);
    }
  }

  // 2. Eligibility: usable (model + provider) and has every required capability.
  const required = [...new Set([...aliasCaps, ...(request.capabilities ?? [])])];
  const eligible: Pending[] = [];
  for (const p of pending) {
    if (!p.model.usable) {
      excluded.push({ modelRef: p.model.ref, reason: p.model.unusableReason ?? 'Not usable' });
      continue;
    }
    const missing = required.filter((c) => !p.model.capabilities.includes(c));
    if (missing.length) {
      excluded.push({ modelRef: p.model.ref, reason: `Missing capabilities: ${missing.join(', ')}` });
      continue;
    }
    eligible.push(p);
  }
  if (!eligible.length) {
    const what = alias ? `alias "${alias.name}"` : `"${name}"`;
    return fail(`No usable model for ${what}${required.length ? ` with ${required.join(', ')}` : ''}.`, resolvedAs);
  }

  // 3. Order: priority, then health within a priority level, then weighted random
  //    among equals. Providers with repeated recent failures go last.
  const ordered = orderCandidates(eligible, random);
  const healthy = ordered.filter((p) => failures(p.model.providerId) < demoteAfter);
  const demoted = ordered.filter((p) => failures(p.model.providerId) >= demoteAfter);
  const candidates: RouteCandidate[] = [...healthy, ...demoted].map((p) => ({
    modelId: p.model.id,
    modelRef: p.model.ref,
    displayName: p.model.displayName,
    providerId: p.model.providerId,
    providerName: p.model.provider.name,
    providerModelId: p.model.providerModelId,
    providerStatus: p.model.provider.status,
    priority: p.priority,
    weight: p.weight,
    recentFailures: failures(p.model.providerId),
  }));

  const policy = normalizePolicy(alias?.policy ?? snap.config.defaultPolicy);
  return {
    ok: true,
    plan: {
      requested: name,
      resolvedAs,
      alias: alias?.name ?? null,
      policy,
      requiredCapabilities: required,
      candidates,
      attempts: expandAttempts(candidates.length, policy),
      excluded,
    },
  };
}

function aliasCandidates(alias: ModelAlias, snap: RoutingSnapshot, excluded: RoutePlan['excluded']): Pending[] {
  // Capability alias: no fixed targets, any registered model may qualify.
  if (!alias.targets.length) {
    return snap.models.map((model) => ({ model, priority: snap.providerPriority.get(model.providerId) ?? 100, weight: 1 }));
  }
  const byRef = new Map(snap.models.map((m) => [m.ref, m]));
  const out: Pending[] = [];
  for (const t of alias.targets) {
    const model = byRef.get(t.modelRef);
    if (!model) excluded.push({ modelRef: t.modelRef, reason: 'Model is not registered' });
    else out.push({ model, priority: t.priority, weight: t.weight });
  }
  return out;
}

/** Sorts by priority and health tier; equal entries are ordered by weighted random choice. */
export function orderCandidates<T extends { priority: number; weight: number; model: { provider: { status: ProviderState }; ref: string } }>(items: T[], random: () => number): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = `${item.priority}:${HEALTH_TIER[item.model.provider.status]}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const [pa, ha] = a.split(':').map(Number);
    const [pb, hb] = b.split(':').map(Number);
    return pa! - pb! || ha! - hb!;
  });
  return keys.flatMap((k) => weightedShuffle(groups.get(k)!.sort((a, b) => a.model.ref.localeCompare(b.model.ref)), random));
}

/** Weighted random order without replacement (each pick proportional to remaining weight). */
export function weightedShuffle<T extends { weight: number }>(items: T[], random: () => number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (pool.length) {
    const total = pool.reduce((sum, i) => sum + Math.max(i.weight, 0), 0);
    let r = random() * total;
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= Math.max(pool[i]!.weight, 0);
      if (r < 0) {
        index = i;
        break;
      }
    }
    out.push(pool.splice(index, 1)[0]!);
  }
  return out;
}

export function normalizePolicy(policy: RoutingPolicy): RoutingPolicy {
  return {
    failover: policy.failover,
    maxAttempts: Math.min(Math.max(Math.trunc(policy.maxAttempts), 1), MAX_ATTEMPTS_CEILING),
    retriesPerTarget: Math.min(Math.max(Math.trunc(policy.retriesPerTarget), 0), 3),
  };
}

/**
 * Turns a policy into the concrete attempt sequence (spec §11). The total is
 * capped by maxAttempts (itself capped by MAX_ATTEMPTS_CEILING), so a request
 * can never loop.
 */
export function expandAttempts(candidateCount: number, policy: RoutingPolicy): RouteAttempt[] {
  if (candidateCount === 0) return [];
  const tries = policy.failover === 'RETRY_SAME_PROVIDER' || policy.failover === 'RETRY_AND_FAILOVER' ? 1 + policy.retriesPerTarget : 1;
  const targets = policy.failover === 'FAILOVER_PROVIDER' || policy.failover === 'RETRY_AND_FAILOVER' ? candidateCount : 1;
  const attempts: RouteAttempt[] = [];
  for (let c = 0; c < targets; c++) {
    for (let t = 1; t <= tries; t++) attempts.push({ candidate: c, try: t });
  }
  return attempts.slice(0, policy.maxAttempts);
}

/** A small seeded PRNG (mulberry32) for reproducible weighted choices in tests and previews. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
