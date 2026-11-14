import { RollingSum } from '@clawrouter/core';
import type { GatewayMetrics } from '@clawrouter/shared';

/**
 * In-memory gateway counters for the dashboard (spec §21). Per process and lost
 * on restart; persistent request history and usage are in the requests package.
 */
export class GatewayMetricsRecorder {
  private active = 0;
  private total = 0;
  private errors = 0;
  private retried = 0;
  private failedOver = 0;
  /** Last minute in one-second buckets; last hour of tokens in one-minute buckets. */
  private readonly starts = new RollingSum(1_000, 60);
  private readonly failures = new RollingSum(1_000, 60);
  private readonly inputTokens = new RollingSum(60_000, 60);
  private readonly outputTokens = new RollingSum(60_000, 60);
  private latencies: number[] = [];
  private readonly startedAt: string;

  constructor(
    private readonly now: () => number = Date.now,
    /** Requests refused with 429, counted by the rate limiter (they never become gateway requests). */
    private readonly rejections: () => { lastMinute: number; total: number } = () => ({ lastMinute: 0, total: 0 }),
  ) {
    this.startedAt = new Date(now()).toISOString();
  }

  started(): void {
    this.active += 1;
    this.total += 1;
    this.starts.add(this.now());
  }

  finished(outcome: { ok: boolean; latencyMs: number; inputTokens?: number | null; outputTokens?: number | null; retries?: number; failovers?: number }): void {
    this.active = Math.max(0, this.active - 1);
    const at = this.now();
    if (!outcome.ok) {
      this.errors += 1;
      this.failures.add(at);
    }
    if (outcome.retries) this.retried += 1;
    if (outcome.failovers) this.failedOver += 1;
    this.latencies.push(outcome.latencyMs);
    if (this.latencies.length > 100) this.latencies.shift();
    if (outcome.inputTokens) this.inputTokens.add(at, outcome.inputTokens);
    if (outcome.outputTokens) this.outputTokens.add(at, outcome.outputTokens);
  }

  snapshot(): GatewayMetrics {
    const at = this.now();
    const limited = this.rejections();
    return {
      startedAt: this.startedAt,
      activeRequests: this.active,
      totalRequests: this.total,
      totalErrors: this.errors,
      requestsLastMinute: this.starts.sum(at),
      errorsLastMinute: this.failures.sum(at),
      averageLatencyMs: this.latencies.length ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length) : null,
      tokensLastHour: { input: this.inputTokens.sum(at), output: this.outputTokens.sum(at) },
      retriedRequests: this.retried,
      failedOverRequests: this.failedOver,
      rateLimitedLastMinute: limited.lastMinute,
      rateLimitedTotal: limited.total,
    };
  }
}
