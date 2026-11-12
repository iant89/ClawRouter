import { createContext, useContext, type ReactNode } from 'react';
import type { HealthReport } from '@clawrouter/shared';
import { usePolling, type PollingState } from '../../hooks/usePolling.ts';
import { fetchHealth } from '../../services/health.ts';
import { useLive, useRealtimeEvent } from '../realtime/RealtimeContext.tsx';

const HealthContext = createContext<PollingState<HealthReport> | null>(null);

export const HEALTH_POLL_MS = 10_000;
/** With live updates, polling is only a safety net. */
export const HEALTH_LIVE_POLL_MS = 60_000;

/** One shared health state for the header, dashboard and health page: refreshed on health and provider events, polled slowly as a fallback. */
export function HealthProvider({ children }: { children: ReactNode }) {
  const state = usePolling(fetchHealth, useLive() ? HEALTH_LIVE_POLL_MS : HEALTH_POLL_MS);
  useRealtimeEvent(['health.changed', 'provider.status'], () => void state.refresh(), 500);
  return <HealthContext.Provider value={state}>{children}</HealthContext.Provider>;
}

export function useHealth(): PollingState<HealthReport> {
  const value = useContext(HealthContext);
  if (!value) throw new Error('useHealth must be used inside <HealthProvider>');
  return value;
}
