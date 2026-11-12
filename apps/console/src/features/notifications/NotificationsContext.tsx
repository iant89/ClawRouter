import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useToast } from '@enterprise-ui/react';
import type { NotificationInfo } from '@clawapi/shared';
import * as api from '../../services/notifications.ts';
import { newAlerts } from './notification-utils.ts';

interface NotificationsValue {
  items: NotificationInfo[];
  unread: number;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
  dismiss(id: string): Promise<void>;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

/** Live push replaces polling with the WebSocket event system (phase 11). */
export const NOTIFICATION_POLL_MS = 30_000;

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [items, setItems] = useState<NotificationInfo[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const known = useRef<Set<string> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.fetchNotifications();
      // Toast only for warnings/errors that arrived since the last poll, never on first load.
      if (known.current) {
        for (const n of newAlerts(next.items, known.current)) {
          // Timed: the notification itself stays in the panel until read.
          toast.show({ duration: 10_000, tone: n.severity === 'ERROR' ? 'error' : 'warning', title: n.title, description: n.body ?? undefined });
        }
      }
      known.current = new Set(next.items.map((n) => n.id));
      setItems(next.items);
      setUnread(next.unread);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load notifications.');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, NOTIFICATION_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const value = useMemo<NotificationsValue>(() => {
    // Optimistic updates keep the panel responsive; the next refresh reconciles with the server.
    const act = async (apply: () => void, call: () => Promise<unknown>) => {
      apply();
      try {
        await call();
      } finally {
        await refresh();
      }
    };
    return {
      items, unread, loading, error, refresh,
      markRead: (id) => act(() => {
        setItems((list) => list.map((n) => (n.id === id ? { ...n, read: true } : n)));
        setUnread((u) => Math.max(0, u - (items.some((n) => n.id === id && !n.read) ? 1 : 0)));
      }, () => api.markNotificationRead(id)),
      markAllRead: () => act(() => {
        setItems((list) => list.map((n) => ({ ...n, read: true })));
        setUnread(0);
      }, api.markAllNotificationsRead),
      dismiss: (id) => act(() => {
        setItems((list) => list.filter((n) => n.id !== id));
        setUnread((u) => Math.max(0, u - (items.some((n) => n.id === id && !n.read) ? 1 : 0)));
      }, () => api.dismissNotification(id)),
    };
  }, [items, unread, loading, error, refresh]);

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error('useNotifications must be used inside <NotificationsProvider>');
  return value;
}
