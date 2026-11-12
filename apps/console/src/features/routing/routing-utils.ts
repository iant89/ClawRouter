import type { FailoverPolicy, ModelAlias, PutRoutingRequest, RoutingConfigView, RoutingPolicy } from '@clawrouter/shared';

export const FAILOVER_LABEL: Record<FailoverPolicy, string> = {
  NONE: 'No retry, no failover',
  RETRY_SAME_PROVIDER: 'Retry the same model',
  FAILOVER_PROVIDER: 'Fail over to the next model',
  RETRY_AND_FAILOVER: 'Retry, then fail over',
};

/** "Retry, then fail over · up to 3 attempts · 1 retry per model" */
export function describePolicy(p: RoutingPolicy): string {
  const parts = [FAILOVER_LABEL[p.failover], `up to ${p.maxAttempts} attempt${p.maxAttempts === 1 ? '' : 's'}`];
  if (p.failover === 'RETRY_SAME_PROVIDER' || p.failover === 'RETRY_AND_FAILOVER') parts.push(`${p.retriesPerTarget} ${p.retriesPerTarget === 1 ? 'retry' : 'retries'} per model`);
  return parts.join(' · ');
}

/** Targets grouped by priority: "alpha/x → beta/y (w3), local/z (w1)" */
export function summarizeTargets(alias: ModelAlias): string {
  if (!alias.targets.length) return `Any usable model with ${alias.capabilities.join(', ')}`;
  const levels = new Map<number, string[]>();
  for (const t of [...alias.targets].sort((a, b) => a.priority - b.priority)) {
    const list = levels.get(t.priority) ?? [];
    list.push(t.weight === 1 ? t.modelRef : `${t.modelRef} (w${t.weight})`);
    levels.set(t.priority, list);
  }
  return [...levels.values()].map((l) => l.join(', ')).join(' → ');
}

/** The request body for saving `config` with one alias added, replaced (by its original name) or removed. */
export function withAlias(config: RoutingConfigView, alias: ModelAlias | null, originalName: string | null): PutRoutingRequest {
  const others = config.aliases.filter((a) => originalName === null || a.name.toLowerCase() !== originalName.toLowerCase());
  let aliases = others;
  if (alias) {
    const index = originalName === null ? -1 : config.aliases.findIndex((a) => a.name.toLowerCase() === originalName.toLowerCase());
    aliases = [...others];
    aliases.splice(index < 0 ? aliases.length : index, 0, alias);
  }
  return { version: config.version, defaultPolicy: config.defaultPolicy, aliases };
}

export function withDefaultPolicy(config: RoutingConfigView, defaultPolicy: RoutingPolicy): PutRoutingRequest {
  return { version: config.version, defaultPolicy, aliases: config.aliases };
}
