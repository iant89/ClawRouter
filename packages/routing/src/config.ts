import {
  ALIAS_NAME_PATTERN, CAPABILITIES, DEFAULT_ROUTING_POLICY, FAILOVER_POLICIES, MAX_ATTEMPTS_CEILING, type FieldIssue, type ModelAlias,
  type ModelInfo, type RoutingConfig, type RoutingPolicy,
} from '@clawrouter/shared';
import { planRoute } from './engine.ts';

export const MAX_ALIASES = 500;
export const MAX_TARGETS = 50;

export function emptyConfig(): RoutingConfig {
  return { version: 0, defaultPolicy: { ...DEFAULT_ROUTING_POLICY }, aliases: [], updatedAt: null, updatedBy: null };
}

function checkPolicy(policy: RoutingPolicy, path: string, issues: FieldIssue[]) {
  if (!(FAILOVER_POLICIES as readonly string[]).includes(policy.failover)) issues.push({ path: `${path}.failover`, message: `must be one of ${FAILOVER_POLICIES.join(', ')}` });
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > MAX_ATTEMPTS_CEILING) {
    issues.push({ path: `${path}.maxAttempts`, message: `must be a whole number from 1 to ${MAX_ATTEMPTS_CEILING}` });
  }
  if (!Number.isInteger(policy.retriesPerTarget) || policy.retriesPerTarget < 0 || policy.retriesPerTarget > 3) {
    issues.push({ path: `${path}.retriesPerTarget`, message: 'must be a whole number from 0 to 3' });
  }
}

/**
 * Validates a routing configuration before it is stored.
 * `allowedRefs`: model references a target may use (registered models, plus
 * references already stored, so a model deleted later does not block unrelated edits).
 */
export function validateRoutingConfig(config: Pick<RoutingConfig, 'defaultPolicy' | 'aliases'>, allowedRefs: ReadonlySet<string>): FieldIssue[] {
  const issues: FieldIssue[] = [];
  checkPolicy(config.defaultPolicy, 'defaultPolicy', issues);
  if (config.aliases.length > MAX_ALIASES) issues.push({ path: 'aliases', message: `at most ${MAX_ALIASES} aliases` });

  const seen = new Set<string>();
  config.aliases.forEach((alias: ModelAlias, i) => {
    const p = `aliases[${i}]`;
    if (!ALIAS_NAME_PATTERN.test(alias.name)) {
      issues.push({ path: `${p}.name`, message: 'must be 1–64 letters, digits, dot, dash, colon or underscore, without "/"' });
    } else if (seen.has(alias.name.toLowerCase())) {
      issues.push({ path: `${p}.name`, message: `"${alias.name}" is used twice (names are case-insensitive)` });
    }
    seen.add(alias.name.toLowerCase());
    if (alias.description.length > 300) issues.push({ path: `${p}.description`, message: 'must be at most 300 characters' });
    const badCaps = alias.capabilities.filter((c) => !(CAPABILITIES as readonly string[]).includes(c));
    if (badCaps.length) issues.push({ path: `${p}.capabilities`, message: `unknown capability: ${badCaps.join(', ')}` });
    if (!alias.targets.length && !alias.capabilities.length) {
      issues.push({ path: `${p}.targets`, message: 'needs at least one target model, or capabilities to choose models by' });
    }
    if (alias.targets.length > MAX_TARGETS) issues.push({ path: `${p}.targets`, message: `at most ${MAX_TARGETS} targets` });
    const refs = new Set<string>();
    alias.targets.forEach((t, j) => {
      const tp = `${p}.targets[${j}]`;
      if (!allowedRefs.has(t.modelRef)) issues.push({ path: `${tp}.modelRef`, message: `"${t.modelRef}" is not a registered model` });
      if (refs.has(t.modelRef)) issues.push({ path: `${tp}.modelRef`, message: `"${t.modelRef}" is listed twice` });
      refs.add(t.modelRef);
      if (!Number.isInteger(t.priority) || t.priority < 0 || t.priority > 1000) issues.push({ path: `${tp}.priority`, message: 'must be a whole number from 0 to 1000' });
      if (!Number.isInteger(t.weight) || t.weight < 1 || t.weight > 1000) issues.push({ path: `${tp}.weight`, message: 'must be a whole number from 1 to 1000' });
    });
    if (alias.policy) checkPolicy(alias.policy, `${p}.policy`, issues);
  });
  return issues;
}

/** Problems worth showing an administrator: dangling targets, aliases that cannot route right now. */
export function routingProblems(config: RoutingConfig, models: ModelInfo[], providerPriority: ReadonlyMap<string, number>): { alias: string; message: string }[] {
  const known = new Set(models.map((m) => m.ref));
  const problems: { alias: string; message: string }[] = [];
  for (const alias of config.aliases) {
    for (const t of alias.targets) {
      if (!known.has(t.modelRef)) problems.push({ alias: alias.name, message: `Target ${t.modelRef} is no longer registered` });
    }
    if (alias.enabled) {
      const result = planRoute({ model: alias.name }, { config, models, providerPriority, random: () => 0 });
      if (!result.ok) problems.push({ alias: alias.name, message: result.reason });
    }
  }
  return problems;
}

/** Human-readable summary of what changed, for the audit log. */
export function diffConfig(before: RoutingConfig, after: Pick<RoutingConfig, 'defaultPolicy' | 'aliases'>) {
  const names = (c: { aliases: ModelAlias[] }) => new Map(c.aliases.map((a) => [a.name.toLowerCase(), a]));
  const b = names(before);
  const a = names(after);
  return {
    added: [...a.values()].filter((x) => !b.has(x.name.toLowerCase())).map((x) => x.name),
    removed: [...b.values()].filter((x) => !a.has(x.name.toLowerCase())).map((x) => x.name),
    changed: [...a.values()].filter((x) => b.has(x.name.toLowerCase()) && JSON.stringify(b.get(x.name.toLowerCase())) !== JSON.stringify(x)).map((x) => x.name),
    defaultPolicyChanged: JSON.stringify(before.defaultPolicy) !== JSON.stringify(after.defaultPolicy),
  };
}
