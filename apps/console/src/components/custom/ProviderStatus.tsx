import { StatusIndicator, type StatusIndicatorProps } from '@enterprise-ui/react';
import type { ProviderState } from '@clawapi/shared';

type Tone = NonNullable<StatusIndicatorProps['tone']>;
const TONE: Record<ProviderState, Tone> = { HEALTHY: 'success', DEGRADED: 'warning', OFFLINE: 'error', DISABLED: 'neutral', UNKNOWN: 'information' };
const LABEL: Record<ProviderState, string> = { HEALTHY: 'Healthy', DEGRADED: 'Degraded', OFFLINE: 'Offline', DISABLED: 'Disabled', UNKNOWN: 'Not checked' };

export const providerStateLabel = (s: ProviderState) => LABEL[s];

/** Provider state as text + icon (spec §18: never color alone). */
export function ProviderStatus({ state, ...rest }: { state: ProviderState } & Omit<StatusIndicatorProps, 'tone' | 'children'>) {
  return <StatusIndicator tone={TONE[state]} {...rest}>{LABEL[state]}</StatusIndicator>;
}
