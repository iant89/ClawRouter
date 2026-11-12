import type { HealthCheck } from './types.ts';

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
