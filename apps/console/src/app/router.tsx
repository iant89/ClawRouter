import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * A deliberately small history-API router. The server serves the console for
 * every non-API path, so deep links work. Swap for a library only if routing
 * needs grow beyond flat pages.
 */
interface RouterValue {
  pathname: string;
  search: string;
  /** Navigates to `path` (may include a query string). */
  navigate: (path: string, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

const current = () => ({ pathname: window.location.pathname, search: window.location.search });

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(current);

  useEffect(() => {
    const onPop = () => setLocation(current());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((path: string, options: { replace?: boolean } = {}) => {
    if (path === window.location.pathname + window.location.search) return;
    if (options.replace) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
    setLocation(current());
  }, []);

  const value = useMemo(() => ({ ...location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error('useRouter must be used inside <RouterProvider>');
  return value;
}
