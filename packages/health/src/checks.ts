import type { HealthCheck, HealthProbeResult } from './types.ts';

/** Structural type so this package does not depend on the database package. */
export interface Pingable {
  ping(): void;
}

export function createDatabaseCheck(db: Pingable): HealthCheck {
  return {
    component: 'database',
    critical: true,
    check() {
      try {
        db.ping();
        return { status: 'HEALTHY', detail: 'SQLite responding' };
      } catch {
        return { status: 'OFFLINE', detail: 'Database is not responding' };
      }
    },
  };
}

export interface PlatformCheckOptions {
  /** Heap usage (bytes) above which the platform reports DEGRADED. */
  heapWarningBytes?: number;
  memoryUsage?: () => { heapUsed: number; rss: number };
}

export function createPlatformCheck(options: PlatformCheckOptions = {}): HealthCheck {
  const limit = options.heapWarningBytes ?? 1024 * 1024 * 1024;
  const usage = options.memoryUsage ?? (() => process.memoryUsage());
  return {
    component: 'platform',
    critical: false,
    check() {
      const { heapUsed, rss } = usage();
      const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
      const detail = `Bun ${Bun.version}, heap ${mb(heapUsed)}, rss ${mb(rss)}`;
      return { status: heapUsed > limit ? 'DEGRADED' : 'HEALTHY', detail };
    },
  };
}

/** Provider availability as a non-critical platform component (counts only; /api/health is public). */
export function createProvidersCheck(source: { healthSummary(): { status: HealthProbeResult['status']; detail: string } }): HealthCheck {
  return {
    component: 'providers',
    critical: false,
    check: () => source.healthSummary(),
  };
}

/**
 * The request gateway (spec §24 gateway): degraded when most recent requests fail,
 * or when there is nothing to route to. Counts only (the detail can be public).
 */
export function createGatewayCheck(source: {
  metrics(): { requestsLastMinute: number; errorsLastMinute: number };
  /** Registered models, and how many of them are usable now. */
  models(): { registered: number; usable: number };
  /** Below this many requests a minute, the error rate is not judged (too few to mean anything). */
  minRequests?: number;
}): HealthCheck {
  const minRequests = source.minRequests ?? 10;
  return {
    component: 'gateway',
    critical: false,
    check() {
      const { requestsLastMinute: n, errorsLastMinute: failed } = source.metrics();
      const { registered, usable } = source.models();
      if (registered === 0) return { status: 'DISABLED', detail: 'No models registered yet' };
      const traffic = n ? `${n} request(s) in the last minute, ${Math.round((failed / n) * 100)}% failed` : 'No requests in the last minute';
      const detail = `${traffic}; ${usable} of ${registered} model(s) usable`;
      if (usable === 0) return { status: 'DEGRADED', detail };
      if (n >= minRequests && failed / n >= 0.5) return { status: 'DEGRADED', detail };
      return { status: 'HEALTHY', detail };
    },
  };
}

/** The console's live channel (spec §24 WebSocket). */
export function createWebSocketCheck(source: { connections(): number | null }): HealthCheck {
  return {
    component: 'websocket',
    critical: false,
    check() {
      const n = source.connections();
      if (n === null) return { status: 'OFFLINE', detail: 'Live channel not running' };
      return { status: 'HEALTHY', detail: `${n} live connection(s)` };
    },
  };
}
