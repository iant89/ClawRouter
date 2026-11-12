import type { HealthCheckResult, HealthReport, HealthState } from '@clawapi/shared';
import type { EventBus, Logger } from '@clawapi/core';
import type { HealthCheck } from './types.ts';

export interface HealthServiceOptions {
  checks: HealthCheck[];
  version: string;
  environment: string;
  startedAt?: Date;
  /** Per-check timeout; a slow check reports OFFLINE/DEGRADED instead of hanging. */
  timeoutMs?: number;
  events?: EventBus;
  log?: Logger;
  now?: () => Date;
}

export interface HealthService {
  report(): Promise<HealthReport>;
  /** Status from the most recent report, `UNKNOWN` before the first. */
  readonly lastStatus: HealthState;
}

/**
 * Overall status:
 *   - any critical check OFFLINE           -> OFFLINE
 *   - any check DEGRADED or OFFLINE        -> DEGRADED
 *   - every check HEALTHY/DISABLED         -> HEALTHY
 *   - no enabled checks / all UNKNOWN      -> UNKNOWN
 */
export function aggregateHealth(results: Pick<HealthCheckResult, 'status' | 'critical'>[]): HealthState {
  const active = results.filter((r) => r.status !== 'DISABLED');
  if (active.length === 0) return 'UNKNOWN';
  if (active.some((r) => r.critical && r.status === 'OFFLINE')) return 'OFFLINE';
  if (active.some((r) => r.status === 'DEGRADED' || r.status === 'OFFLINE')) return 'DEGRADED';
  if (active.every((r) => r.status === 'UNKNOWN')) return 'UNKNOWN';
  if (active.some((r) => r.status === 'UNKNOWN')) return 'DEGRADED';
  return 'HEALTHY';
}

export function createHealthService(options: HealthServiceOptions): HealthService {
  const now = options.now ?? (() => new Date());
  const startedAt = options.startedAt ?? now();
  const timeoutMs = options.timeoutMs ?? 2000;
  let lastStatus: HealthState = 'UNKNOWN';

  const run = async (check: HealthCheck): Promise<HealthCheckResult> => {
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      });
      const result = await Promise.race([Promise.resolve().then(() => check.check()), timeout]);
      return { component: check.component, critical: check.critical, ...result, latencyMs: Math.round(performance.now() - started), checkedAt: now().toISOString() };
    } catch (error) {
      const timedOut = error instanceof Error && error.message === 'timeout';
      options.log?.warn('health check failed', { component: 'health', check: check.component, error });
      return {
        component: check.component,
        critical: check.critical,
        status: 'OFFLINE',
        detail: timedOut ? `Check timed out after ${timeoutMs} ms` : 'Check failed',
        latencyMs: Math.round(performance.now() - started),
        checkedAt: now().toISOString(),
      };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    get lastStatus() {
      return lastStatus;
    },
    async report() {
      const checks = await Promise.all(options.checks.map(run));
      const status = aggregateHealth(checks);
      const checkedAt = now().toISOString();
      if (status !== lastStatus) {
        const previous = lastStatus;
        lastStatus = status;
        options.events?.emit('health.changed', { previous, current: status, checkedAt });
        if (previous !== 'UNKNOWN' || status !== 'HEALTHY') {
          options.log?.info('health status changed', { component: 'health', previous, current: status });
        }
      }
      return {
        status,
        version: options.version,
        environment: options.environment,
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.max(0, Math.floor((now().getTime() - startedAt.getTime()) / 1000)),
        checkedAt,
        checks,
      };
    },
  };
}
