/*
 * ClawRouter - Self-hosted AI gateway and control platform
 * https://github.com/iant89/ClawRouter
 *
 * Copyright (C) 2026 Ian Thomas
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version. This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * in the LICENSE file for more details.
 */

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
