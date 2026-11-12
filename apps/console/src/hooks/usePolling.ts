import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollingState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  lastUpdated: Date | undefined;
  refresh: () => Promise<void>;
}

/**
 * Server state with periodic refresh. Live push arrives with the WebSocket
 * event system in Phase 11; until then, poll. Pauses while the tab is hidden.
 */
export function usePolling<T>(load: (signal: AbortSignal) => Promise<T>, intervalMs: number | null): PollingState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date>();
  const loadRef = useRef(load);
  loadRef.current = load;
  const inflight = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    setLoading(true);
    try {
      const next = await loadRef.current(controller.signal);
      if (controller.signal.aborted) return;
      setData(next);
      setError(undefined);
      setLastUpdated(new Date());
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (inflight.current === controller) {
        inflight.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => inflight.current?.abort();
  }, [refresh]);

  useEffect(() => {
    if (intervalMs === null) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, refresh]);

  return { data, error, loading, lastUpdated, refresh };
}
