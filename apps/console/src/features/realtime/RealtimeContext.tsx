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

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { RealtimeActivity, RealtimeEventName } from '@clawrouter/shared';
import { reportUnauthorized } from '../../services/api-client.ts';
import { RealtimeConnection, type RealtimeMessage, type RealtimeState } from '../../services/realtime.ts';
import { useAuth } from '../auth/AuthContext.tsx';

interface RealtimeValue {
  connection: RealtimeConnection;
  state: RealtimeState;
}

const RealtimeContext = createContext<RealtimeValue | null>(null);

/**
 * Owns the console's single live connection while a user is signed in. A role
 * change (a new hello with other permissions) re-reads the session so the
 * navigation follows; a 4401 close signs the console out.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { refresh } = useAuth();
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const [connection] = useState(() => new RealtimeConnection({ onSessionEnded: reportUnauthorized }));
  const [state, setState] = useState<RealtimeState>(connection.state);

  useEffect(() => {
    const offState = connection.onStateChange(setState);
    let permissions: string | null = null;
    const offMsg = connection.subscribe((m) => {
      if (m.type !== 'hello') return;
      const next = m.permissions.join(',');
      if (permissions !== null && permissions !== next) void refreshRef.current().catch(() => {});
      permissions = next;
    });
    const onVisible = () => {
      if (document.visibilityState === 'visible') connection.retryNow();
    };
    document.addEventListener('visibilitychange', onVisible);
    connection.start();
    return () => {
      offState();
      offMsg();
      document.removeEventListener('visibilitychange', onVisible);
      connection.stop();
    };
  }, [connection]);

  return <RealtimeContext.Provider value={{ connection, state }}>{children}</RealtimeContext.Provider>;
}

/** The connection state, or 'offline' outside the provider (e.g. the sign-in page). */
export function useRealtimeState(): RealtimeState {
  return useContext(RealtimeContext)?.state ?? 'offline';
}

/** The connection state and a way to try again now (the disconnected overlay's Retry). */
export function useRealtime(): { state: RealtimeState; retry: () => void } {
  const value = useContext(RealtimeContext);
  return { state: value?.state ?? 'offline', retry: () => value?.connection.retryNow() };
}

/** True while live updates arrive: pages may then poll slowly, as a fallback only. */
export const useLive = () => useRealtimeState() === 'live';

/**
 * Calls `handler` for the named events and after a reconnect (anything may have
 * been missed). With `throttleMs`, bursts are folded into at most one call per period.
 */
export function useRealtimeEvent(names: RealtimeEventName | RealtimeEventName[], handler: () => void, throttleMs = 0) {
  useMessages((m) => (m.type === 'resync' || (m.type === 'event' && ([] as string[]).concat(names).includes(m.name))), handler, throttleMs, [([] as string[]).concat(names).join(',')]);
}

/** Calls `handler` for gateway activity (at most once a second from the server) and after a reconnect. */
export function useActivity(handler: (activity: RealtimeActivity | null) => void, throttleMs = 0) {
  const last = useRef<RealtimeActivity | null>(null);
  useMessages((m) => {
    if (m.type === 'activity') last.current = m;
    else if (m.type === 'resync') last.current = null;
    return m.type === 'activity' || m.type === 'resync';
  }, () => handler(last.current), throttleMs, []);
}

function useMessages(match: (m: RealtimeMessage) => boolean, handler: () => void, throttleMs: number, deps: unknown[]) {
  const connection = useContext(RealtimeContext)?.connection;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const matchRef = useRef(match);
  matchRef.current = match;
  useEffect(() => {
    if (!connection) return;
    let timer: number | null = null;
    let lastRun = 0;
    const run = () => {
      timer = null;
      lastRun = Date.now();
      handlerRef.current();
    };
    const off = connection.subscribe((m) => {
      if (!matchRef.current(m)) return;
      if (!throttleMs) return run();
      if (timer !== null) return;
      const wait = Math.max(0, lastRun + throttleMs - Date.now());
      timer = window.setTimeout(run, wait);
    });
    return () => {
      off();
      if (timer !== null) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, throttleMs, ...deps]);
}
