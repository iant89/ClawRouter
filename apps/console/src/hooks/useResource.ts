import { useCallback, useEffect, useState } from 'react';

export interface Resource<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  lastUpdated: Date | undefined;
  reload: () => void;
}

/** Loads server state once (and on `reload`), aborting stale requests. */
export function useResource<T>(load: (signal: AbortSignal) => Promise<T>): Resource<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date>();
  const [key, setKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    load(controller.signal)
      .then((next) => {
        setData(next);
        setError(null);
        setLastUpdated(new Date());
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load data.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // `load` is expected to be a stable module-level function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const reload = useCallback(() => setKey((k) => k + 1), []);
  return { data, error, loading, lastUpdated, reload };
}
