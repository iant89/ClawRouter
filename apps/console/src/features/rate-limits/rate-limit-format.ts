import type { RateLimit, RateWindow, TokenBucket } from '@clawrouter/shared';

const SHORT: Record<RateWindow, string> = { second: 's', minute: 'min', hour: 'h' };

/** "1 every 2 s", "10 every second". */
export function describeRefill(b: TokenBucket): string {
  const s = b.refillEverySeconds;
  const every = s === 1 ? 'second' : s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`;
  return `${b.refillAmount.toLocaleString()} every ${every}`;
}

/** "burst 10, +1 every second" */
export const describeBucket = (b: TokenBucket) => `burst ${b.capacity.toLocaleString()}, +${describeRefill(b)}`;

/** "120 req/min · 50K tokens/min · burst 10, +1 every second", or "No limit". */
export function describeLimit(l: RateLimit): string {
  const w = SHORT[l.window];
  const parts: string[] = [];
  if (l.requests !== null) parts.push(`${l.requests.toLocaleString()} req/${w}`);
  if (l.tokens !== null) parts.push(`${l.tokens.toLocaleString()} tokens/${w}`);
  if (l.bucket) parts.push(describeBucket(l.bucket));
  return parts.length ? parts.join(' · ') : 'No limit';
}

/** Column header suffix for the limit's window: "1 s", "1 min", "1 h". */
export const windowShort = (w: RateWindow) => `1 ${SHORT[w]}`;

/** How close a counter is to its limit: the highest of the ratios, or null when unlimited. */
export function usageRatio(used: { requests: number; tokens: number; bucketAvailable?: number }, l: RateLimit): number | null {
  const ratios = [
    l.requests ? used.requests / l.requests : null,
    l.tokens ? used.tokens / l.tokens : null,
    l.bucket && used.bucketAvailable !== undefined ? 1 - used.bucketAvailable / l.bucket.capacity : null,
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
