import { StatusIndicator, type StatusIndicatorProps } from '@enterprise-ui/react';
import type { HealthState } from '@clawapi/shared';

type Tone = NonNullable<StatusIndicatorProps['tone']>;

/** Spec §18: green healthy, orange warning, red offline, blue informational. */
export const HEALTH_TONE: Record<HealthState, Tone> = {
  HEALTHY: 'success',
  DEGRADED: 'warning',
  OFFLINE: 'error',
  DISABLED: 'neutral',
  UNKNOWN: 'information',
};

export const HEALTH_LABEL: Record<HealthState, string> = {
  HEALTHY: 'Healthy',
  DEGRADED: 'Degraded',
  OFFLINE: 'Offline',
  DISABLED: 'Disabled',
  UNKNOWN: 'Unknown',
};

export interface HealthStateIndicatorProps extends Omit<StatusIndicatorProps, 'tone' | 'children'> {
  state: HealthState;
  /** Optional prefix, e.g. "Gateway" renders "Gateway: Healthy". */
  label?: string;
}

/**
 * Health state as text plus icon (never color alone). Composition of the
 * ENTERPRISE-UI StatusIndicator; kept in the app because the state vocabulary
 * is ClawAPI-specific.
 */
export function HealthStateIndicator({ state, label, ...rest }: HealthStateIndicatorProps) {
  return (
    <StatusIndicator tone={HEALTH_TONE[state]} {...rest}>
      {label ? `${label}: ${HEALTH_LABEL[state]}` : HEALTH_LABEL[state]}
    </StatusIndicator>
  );
}
