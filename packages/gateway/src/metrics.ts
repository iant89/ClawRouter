import type { GatewayMetrics } from '@clawrouter/shared';

/**
 * In-memory gateway counters for the dashboard (spec §21). Per process and lost
 * on restart; persistent request history and usage arrive in phase 10.
 */
export class GatewayMetricsRecorder {
  private active = 0;
  private total = 0;
  private errors = 0;
  private retried = 0;
  private failedOver = 0;
  private starts: number[] = [];
  private failuresAt: number[] = [];
  private latencies: number[] = [];
  private tokens: { at: number; input: number; output: number }[] = [];
  private readonly startedAt: string;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = new Date(now()).toISOString();
  }

  started(): void {
    this.active += 1;
    this.total += 1;
    this.starts.push(this.now());
  }

  finished(outcome: { ok: boolean; latencyMs: number; inputTokens?: number | null; outputTokens?: number | null; retries?: number; failovers?: number }): void {
    this.active = Math.max(0, this.active - 1);
    const at = this.now();
    if (!outcome.ok) {
      this.errors += 1;
      this.failuresAt.push(at);
    }
    if (outcome.retries) this.retried += 1;
    if (outcome.failovers) this.failedOver += 1;
    this.latencies.push(outcome.latencyMs);
    if (this.latencies.length > 100) this.latencies.shift();
    if (outcome.inputTokens || outcome.outputTokens) this.tokens.push({ at, input: outcome.inputTokens ?? 0, output: outcome.outputTokens ?? 0 });
  }

  snapshot(): GatewayMetrics {
    const at = this.now();
    this.starts = this.starts.filter((t) => at - t < 60_000);
    this.failuresAt = this.failuresAt.filter((t) => at - t < 60_000);
    this.tokens = this.tokens.filter((t) => at - t.at < 3_600_000);
    return {
      startedAt: this.startedAt,
      activeRequests: this.active,
      totalRequests: this.total,
      totalErrors: this.errors,
      requestsLastMinute: this.starts.length,
      errorsLastMinute: this.failuresAt.length,
      averageLatencyMs: this.latencies.length ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length) : null,
      tokensLastHour: this.tokens.reduce((s, t) => ({ input: s.input + t.input, output: s.output + t.output }), { input: 0, output: 0 }),
      retriedRequests: this.retried,
      failedOverRequests: this.failedOver,
    };
  }
}
