/**
 * Counter storage behind the rate limiter (spec §12). The interface is async so
 * a shared store (Redis or similar) can replace the in-memory one when ClawRouter
 * runs on several nodes; nothing else in the limiter assumes a single process.
 */
export interface CounterState {
  /** Estimated usage in the current sliding window, after this call. */
  used: number;
  /** Time until usage has dropped enough for `cost` more to fit (0 when it fits now). */
  retryAfterMs: number;
  /** Time until the current fixed window rolls over (for informational headers). */
  resetMs: number;
}

export interface CounterStore {
  /** Current usage of `key`, without changing it. */
  /** Current usage of `key`, without changing it; `retryAfterMs` says when `cost` more would fit under `limit`. */
  peek(key: string, windowMs: number, cost?: number, limit?: number | null): Promise<CounterState>;
  /**
   * Adds `cost` to `key` when `used + cost <= limit` (or always, with `limit` null).
   * Returns whether it was added, and the resulting state.
   */
  consume(key: string, cost: number, limit: number | null, windowMs: number): Promise<CounterState & { allowed: boolean }>;
  /** Adds `cost` unconditionally (charging tokens after a request). */
  add(key: string, cost: number, windowMs: number): Promise<void>;
  /** In-progress counters (concurrency). `acquire` fails when `max` is reached. */
  acquire(key: string, max: number | null): Promise<boolean>;
  release(key: string): Promise<void>;
  inFlight(key: string): Promise<number>;
  /** Keys with a non-zero estimate, for the usage view. May be capped. */
  keys(prefix: string): Promise<string[]>;
}

interface Window {
  /** Start of the current fixed window. */
  start: number;
  current: number;
  previous: number;
  windowMs: number;
}

/**
 * Sliding-window counter: two fixed windows, the previous one weighted by how
 * much of it still overlaps the sliding window. O(1) memory per key, at most a
 * few percent off a true sliding log, never lets a burst at a window boundary
 * double the limit the way plain fixed windows do.
 */
export class MemoryCounterStore implements CounterStore {
  private readonly windows = new Map<string, Window>();
  private readonly flights = new Map<string, number>();
  private ops = 0;

  constructor(private readonly now: () => number = Date.now, private readonly maxKeys = 50_000) {}

  private roll(key: string, windowMs: number, create: boolean): Window | null {
    const at = this.now();
    let w = this.windows.get(key);
    if (!w) {
      if (!create) return null;
      this.sweep();
      w = { start: at - (at % windowMs), current: 0, previous: 0, windowMs };
      this.windows.set(key, w);
      return w;
    }
    const elapsedWindows = Math.floor((at - w.start) / windowMs);
    if (elapsedWindows === 1) {
      w.previous = w.current;
      w.current = 0;
      w.start += windowMs;
    } else if (elapsedWindows > 1) {
      w.previous = 0;
      w.current = 0;
      w.start = at - (at % windowMs);
    }
    return w;
  }

  private state(w: Window | null, windowMs: number, cost = 0, limit: number | null = null): CounterState {
    const at = this.now();
    if (!w) return { used: 0, retryAfterMs: 0, resetMs: windowMs - (at % windowMs) };
    const into = (at - w.start) / windowMs;
    const used = w.previous * (1 - into) + w.current;
    const resetMs = Math.max(0, w.start + windowMs - at);
    let retryAfterMs = 0;
    if (limit !== null && used + cost > limit) {
      // The previous window's share decays linearly; the current one only resets at the boundary.
      const excess = used + cost - limit;
      const decayPerMs = w.previous / windowMs;
      const fromPrevious = decayPerMs > 0 ? excess / decayPerMs : Infinity;
      retryAfterMs = Math.ceil(fromPrevious <= resetMs ? fromPrevious : resetMs + (w.current + cost > limit ? windowMs : 0));
    }
    return { used: Math.round(used * 100) / 100, retryAfterMs, resetMs };
  }

  async peek(key: string, windowMs: number, cost = 0, limit: number | null = null) {
    return this.state(this.roll(key, windowMs, false), windowMs, cost, limit);
  }

  async consume(key: string, cost: number, limit: number | null, windowMs: number) {
    const w = this.roll(key, windowMs, true)!;
    const before = this.state(w, windowMs, cost, limit);
    if (before.retryAfterMs > 0) return { ...before, allowed: false };
    w.current += cost;
    return { ...this.state(w, windowMs), allowed: true };
  }

  async add(key: string, cost: number, windowMs: number) {
    if (cost <= 0) return;
    this.roll(key, windowMs, true)!.current += cost;
  }

  async acquire(key: string, max: number | null) {
    const n = this.flights.get(key) ?? 0;
    if (max !== null && n >= max) return false;
    this.flights.set(key, n + 1);
    return true;
  }

  async release(key: string) {
    const n = (this.flights.get(key) ?? 0) - 1;
    if (n <= 0) this.flights.delete(key);
    else this.flights.set(key, n);
  }

  async inFlight(key: string) {
    return this.flights.get(key) ?? 0;
  }

  async keys(prefix: string) {
    const out: string[] = [];
    for (const [key, w] of this.windows) {
      if (!key.startsWith(prefix)) continue;
      if (this.state(this.roll(key, w.windowMs, false), w.windowMs).used > 0) out.push(key);
      if (out.length >= 500) break;
    }
    return out;
  }

  get size(): number {
    return this.windows.size;
  }

  /** Drops idle windows now and then, and the oldest ones if there are too many (memory bound). */
  private sweep() {
    this.ops += 1;
    if (this.windows.size < this.maxKeys && this.ops % 1000 !== 0) return;
    const at = this.now();
    for (const [key, w] of this.windows) {
      if (at - w.start >= 2 * w.windowMs) this.windows.delete(key);
    }
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.maxKeys) break;
      this.windows.delete(key);
    }
  }
}
