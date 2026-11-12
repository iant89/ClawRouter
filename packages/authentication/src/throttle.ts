export interface ThrottleOptions {
  /** Failures allowed within `windowMs` before the key is blocked. */
  limit: number;
  windowMs: number;
  /** How long a key stays blocked once over the limit. */
  blockMs: number;
  /** Upper bound on tracked keys, so an attacker cannot exhaust memory. */
  maxKeys?: number;
  now?: () => number;
}

interface Entry {
  failures: number[];
  blockedUntil: number;
}

/**
 * In-memory failure counter for login throttling. Single-node only; phase 9
 * introduces the rate-limit abstraction that can be backed by Redis.
 */
export class FailureThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(private readonly options: ThrottleOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Milliseconds until `key` may try again; 0 when allowed. */
  retryAfter(key: string): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    return Math.max(0, entry.blockedUntil - this.now());
  }

  fail(key: string): void {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry) {
      this.evictIfFull();
      entry = { failures: [], blockedUntil: 0 };
      this.entries.set(key, entry);
    }
    entry.failures = entry.failures.filter((t) => now - t < this.options.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.options.limit) {
      entry.blockedUntil = now + this.options.blockMs;
      entry.failures = [];
    }
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private evictIfFull() {
    const max = this.options.maxKeys ?? 10_000;
    if (this.entries.size < max) return;
    const now = this.now();
    for (const [key, entry] of this.entries) {
      const stale = entry.blockedUntil <= now && entry.failures.every((t) => now - t >= this.options.windowMs);
      if (stale) this.entries.delete(key);
    }
    // Still full: drop the oldest entries (Map preserves insertion order).
    for (const key of this.entries.keys()) {
      if (this.entries.size < max) break;
      this.entries.delete(key);
    }
  }
}
