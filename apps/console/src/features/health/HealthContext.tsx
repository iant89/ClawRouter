import { createContext, useContext, type ReactNode } from 'react';
import type { HealthReport } from '@clawapi/shared';
import { usePolling, type PollingState } from '../../hooks/usePolling.ts';
import { fetchHealth } from '../../services/health.ts';

const HealthContext = createContext<PollingState<HealthReport> | null>(null);

export const HEALTH_POLL_MS = 10_000;

/** One shared health poll for the header, dashboard and health page. */
export function HealthProvider({ children }: { children: ReactNode }) {
  const state = usePolling(fetchHealth, HEALTH_POLL_MS);
  return <HealthContext.Provider value={state}>{children}</HealthContext.Provider>;
}

export function useHealth(): PollingState<HealthReport> {
  const value = useContext(HealthContext);
  if (!value) throw new Error('useHealth must be used inside <HealthProvider>');
  return value;
}
