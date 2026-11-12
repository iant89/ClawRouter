import type { HealthComponent, HealthState } from '@clawapi/shared';

export interface HealthProbeResult {
  status: HealthState;
  /** Short, display-safe detail. Never include secrets, paths to credentials or raw errors. */
  detail?: string;
}

/** A single health probe. Implementations live next to what they check. */
export interface HealthCheck {
  component: HealthComponent;
  /** An OFFLINE critical check makes the whole platform OFFLINE. */
  critical: boolean;
  check(): Promise<HealthProbeResult> | HealthProbeResult;
}
