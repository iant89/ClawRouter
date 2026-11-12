import type { RateLimit } from '@clawrouter/shared';

/** "120 req/min · 50K tokens/min", or "No limit". */
export function describeLimit(l: RateLimit): string {
  const parts: string[] = [];
  if (l.requestsPerMinute !== null) parts.push(`${l.requestsPerMinute.toLocaleString()} req/min`);
  if (l.tokensPerMinute !== null) parts.push(`${l.tokensPerMinute.toLocaleString()} tokens/min`);
  return parts.length ? parts.join(' · ') : 'No limit';
}

/** How close a counter is to its limit: the higher of the two ratios, or null when unlimited. */
export function usageRatio(used: { requests: number; tokens: number }, l: RateLimit): number | null {
  const ratios = [
    l.requestsPerMinute ? used.requests / l.requestsPerMinute : null,
    l.tokensPerMinute ? used.tokens / l.tokensPerMinute : null,
  ].filter((r): r is number => r !== null);
  return ratios.length ? Math.max(...ratios) : null;
}

export type UsageLevel = 'ok' | 'near' | 'at' | 'unlimited';

export function usageLevel(ratio: number | null): UsageLevel {
  if (ratio === null) return 'unlimited';
  if (ratio >= 1) return 'at';
  if (ratio >= 0.8) return 'near';
  return 'ok';
}
