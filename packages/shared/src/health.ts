/**
 * Health vocabulary shared by the server and the console.
 * Browser-safe: no runtime dependencies.
 */
export const HEALTH_STATES = ['HEALTHY', 'DEGRADED', 'OFFLINE', 'DISABLED', 'UNKNOWN'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

/** Platform areas that report health (spec §24). Only some are implemented in the first milestone. */
export const HEALTH_COMPONENTS = [
  'platform',
  'database',
  'gateway',
  'authentication',
  'provider-engine',
  'providers',
  'websocket',
  'api',
] as const;
export type HealthComponent = (typeof HEALTH_COMPONENTS)[number];

export interface HealthCheckResult {
  component: HealthComponent;
  status: HealthState;
  /** Whether an OFFLINE result makes the whole platform OFFLINE. */
  critical: boolean;
  /** How long the check took, in milliseconds. */
  latencyMs: number;
  /** Short, non-sensitive explanation suitable for display. */
  detail?: string;
  checkedAt: string;
}

export interface HealthReport {
  status: HealthState;
  version: string;
  environment: string;
  startedAt: string;
  uptimeSeconds: number;
  checkedAt: string;
  checks: HealthCheckResult[];
}

export function isHealthState(value: unknown): value is HealthState {
  return typeof value === 'string' && (HEALTH_STATES as readonly string[]).includes(value);
}

/** GET /api/health/history: one component over the period. */
export interface ComponentHistory {
  component: HealthComponent;
  /** Status of the latest check in the period, or null without checks. */
  current: HealthState | null;
  /** Share of checks that were HEALTHY, from 0 to 1 (DISABLED checks are not counted); null without checks. */
  availability: number | null;
  checks: number;
  averageLatencyMs: number | null;
  /** The worst status in each time bucket, oldest first; null for buckets without checks. */
  buckets: { start: string; status: HealthState | null; checks: number }[];
  /** Status changes, newest first (at most 50). */
  changes: { at: string; from: HealthState | null; to: HealthState; detail: string | null }[];
}

export interface HealthHistoryReport {
  from: string;
  to: string;
  bucketMinutes: number;
  components: ComponentHistory[];
}

/** Worst first: used to pick a bucket's status. */
export const HEALTH_SEVERITY: Record<HealthState, number> = { OFFLINE: 4, DEGRADED: 3, UNKNOWN: 2, HEALTHY: 1, DISABLED: 0 };
