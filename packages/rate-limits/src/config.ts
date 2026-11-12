import { DEFAULT_RATE_LIMITS, RATE_LIMIT_MAX, type FieldIssue, type RateLimit, type RateLimitConfig, type RateLimitSettings } from '@clawrouter/shared';

export const MAX_MODEL_LIMITS = 500;

export function defaultConfig(): RateLimitConfig {
  return { ...structuredClone(DEFAULT_RATE_LIMITS), version: 0, updatedAt: null, updatedBy: null };
}

function checkValue(value: unknown, path: string, issues: FieldIssue[]) {
  if (value === null) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > RATE_LIMIT_MAX) {
    issues.push({ path, message: `must be a whole number from 1 to ${RATE_LIMIT_MAX.toLocaleString('en-US')}, or null for no limit` });
  }
}

/** Validates one `{ requestsPerMinute, tokensPerMinute }` pair. */
export function checkRateLimit(limit: unknown, path: string, issues: FieldIssue[]): limit is RateLimit {
  if (typeof limit !== 'object' || limit === null) {
    issues.push({ path, message: 'must be an object with requestsPerMinute and tokensPerMinute' });
    return false;
  }
  const l = limit as Record<string, unknown>;
  checkValue(l.requestsPerMinute ?? null, `${path}.requestsPerMinute`, issues);
  checkValue(l.tokensPerMinute ?? null, `${path}.tokensPerMinute`, issues);
  return true;
}

/** Normalizes a limit (missing fields become null). */
export const normalizeLimit = (l: Partial<RateLimit> | null | undefined): RateLimit => ({
  requestsPerMinute: l?.requestsPerMinute ?? null,
  tokensPerMinute: l?.tokensPerMinute ?? null,
});

/** Validates the settings document. Model references are checked separately (unknown ones are allowed but reported). */
export function validateRateLimits(s: RateLimitSettings): FieldIssue[] {
  const issues: FieldIssue[] = [];
  checkRateLimit(s.perKey, 'perKey', issues);
  checkRateLimit(s.perUser, 'perUser', issues);
  if (checkRateLimit(s.global, 'global', issues)) checkValue(s.global.maxConcurrent ?? null, 'global.maxConcurrent', issues);
  if (!Number.isInteger(s.invalidKeysPerIp) || s.invalidKeysPerIp < 1 || s.invalidKeysPerIp > 10_000) {
    issues.push({ path: 'invalidKeysPerIp', message: 'must be a whole number from 1 to 10,000' });
  }
  if (!Array.isArray(s.perModel)) {
    issues.push({ path: 'perModel', message: 'must be a list' });
    return issues;
  }
  if (s.perModel.length > MAX_MODEL_LIMITS) issues.push({ path: 'perModel', message: `at most ${MAX_MODEL_LIMITS} model limits` });
  const seen = new Set<string>();
  s.perModel.forEach((m, i) => {
    const p = `perModel[${i}]`;
    if (typeof m?.model !== 'string' || !/^[^/\s]+\/\S+$/.test(m.model) || m.model.length > 300) {
      issues.push({ path: `${p}.model`, message: 'must be a model reference, provider/model' });
    } else if (seen.has(m.model.toLowerCase())) {
      issues.push({ path: `${p}.model`, message: `"${m.model}" has two limits` });
    } else seen.add(m.model.toLowerCase());
    if (checkRateLimit(m, p, issues) && m.requestsPerMinute == null && m.tokensPerMinute == null) {
      issues.push({ path: p, message: 'set requests or tokens per minute, or remove the model' });
    }
  });
  return issues;
}

export function normalizeSettings(s: RateLimitSettings): RateLimitSettings {
  return {
    perKey: normalizeLimit(s.perKey),
    perUser: normalizeLimit(s.perUser),
    perModel: s.perModel.map((m) => ({ model: m.model.trim(), ...normalizeLimit(m) })),
    global: { ...normalizeLimit(s.global), maxConcurrent: s.global.maxConcurrent ?? null },
    invalidKeysPerIp: s.invalidKeysPerIp,
  };
}

/** What changed, for the audit record (values only; nothing secret lives here). */
export function diffSettings(before: RateLimitSettings, after: RateLimitSettings): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const k of ['perKey', 'perUser', 'global', 'invalidKeysPerIp'] as const) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed[k] = { from: before[k], to: after[k] };
  }
  const b = new Map(before.perModel.map((m) => [m.model, m]));
  const a = new Map(after.perModel.map((m) => [m.model, m]));
  const added = [...a.keys()].filter((k) => !b.has(k));
  const removed = [...b.keys()].filter((k) => !a.has(k));
  const modified = [...a.keys()].filter((k) => b.has(k) && JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k)));
  if (added.length || removed.length || modified.length) changed.perModel = { added, removed, changed: modified };
  return changed;
}
