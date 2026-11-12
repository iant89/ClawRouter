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
