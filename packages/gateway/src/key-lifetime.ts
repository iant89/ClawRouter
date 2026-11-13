import { formatLifetime, type FieldIssue, type ModelAlias, type ModelInfo } from '@clawrouter/shared';

/** The strictest maximum key lifetime among the models a key may use, and which model sets it. */
export interface StrictestLifetime {
  hours: number;
  modelRef: string;
  source: 'model' | 'provider';
}

/**
 * Resolves a key's allowed model names (aliases, references or provider model
 * ids, case-insensitive, as the gateway matches them) to registered models and
 * returns the strictest maximum key lifetime among them. An empty list ("any
 * model") returns null: such keys are limited when used instead (the gateway
 * skips models a key has outlived).
 */
export function strictestLifetime(allowedModels: string[], models: ModelInfo[], aliases: ModelAlias[]): StrictestLifetime | null {
  if (!allowedModels.length) return null;
  const reached = new Set<ModelInfo>();
  for (const raw of allowedModels) {
    const name = raw.trim().toLowerCase();
    const alias = aliases.find((a) => a.name.toLowerCase() === name);
    if (alias) {
      // An alias without targets may use any model with its capabilities.
      const targets = alias.targets.length ? alias.targets.map((t) => t.modelRef.toLowerCase()) : null;
      for (const m of models) {
        if (targets ? targets.includes(m.ref.toLowerCase()) : alias.capabilities.every((c) => m.capabilities.includes(c))) reached.add(m);
      }
      continue;
    }
    for (const m of models) if (m.ref.toLowerCase() === name || m.providerModelId.toLowerCase() === name) reached.add(m);
  }
  let best: StrictestLifetime | null = null;
  for (const m of reached) {
    const l = m.keyLifetimeLimit;
    if (l && (!best || l.hours < best.hours)) best = { hours: l.hours, modelRef: m.ref, source: l.source };
  }
  return best;
}

/** Adds an issue when a key's expiry does not fit within `limit` (never-expiring keys never fit). */
export function checkLifetime(expiresAt: string | null, now: Date, limit: StrictestLifetime | null, path: string, issues: FieldIssue[]): void {
  if (!limit) return;
  if (expiresAt === null || Date.parse(expiresAt) - now.getTime() > limit.hours * 3_600_000) {
    issues.push({
      path,
      message: `must be at most ${formatLifetime(limit.hours)} from now: ${limit.modelRef} allows keys of at most ${formatLifetime(limit.hours)} (set on the ${limit.source})`,
    });
  }
}
