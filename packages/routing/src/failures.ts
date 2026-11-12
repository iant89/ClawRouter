/**
 * Recent provider failures (spec §10 "failure history"). In memory and per
 * process; the gateway (phase 8) records outcomes and the engine demotes
 * providers that keep failing. A later phase can back this with Redis.
 */
export class FailureTracker {
  private readonly events = new Map<string, number[]>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  recordFailure(providerId: string): void {
    const list = this.prune(providerId);
    list.push(this.now());
    this.events.set(providerId, list);
  }

  /** A success clears the history: the provider is working again. */
  recordSuccess(providerId: string): void {
    this.events.delete(providerId);
  }

  /** Failures within the window. */
  count(providerId: string): number {
    return this.prune(providerId).length;
  }

  private prune(providerId: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.events.get(providerId) ?? []).filter((t) => t > cutoff);
    if (list.length) this.events.set(providerId, list);
    else this.events.delete(providerId);
    return list;
  }
}
